import { spawn } from "node:child_process";
import readline from "node:readline";
import { EOL } from "node:os";
import { END_SIGNAL, END_MARKERS } from "./constants.js";
import { interpolateSQL } from "./utils.js";
export { escapeValue, interpolateSQL } from "./utils.js";

/**
 * SQLite 包装器类
 * 提供安全的 SQLite 进程管理和查询执行
 * @typedef {Object} QueueTask
 * @property {string} sql - 要执行的 SQL 语句
 * @property {(result: string) => void} resolve - 成功回调
 * @property {(error: Error) => void} reject - 失败回调
 * @property {boolean} isRaw - 是否为原生命令，如果是原生命令，则不需要对 sql 任何处理
 */
export class SQLiteWrapper {
	/**
	 * @type {QueueTask[]}
	 */
	#queue = [];
	/**
	 * @type {QueueTask | null}
	 */
	#current = null;
	#closed = false;
	#stdoutBuffer = "";
	#stderrBuffer = "";
	/**
	 * @type {import('child_process').ChildProcessWithoutNullStreams | null}
	 */
	#proc = null;
	/**
	 * @type {import('readline').Interface | null}
	 */
	#rl = null;
	/**
	 * @type {import('./index.d.ts').Logger | null}
	 */
	#logger = null;
	#modeIsSet = false;
	/**
	 * @type {Set<(reason: any) => void>}
	 */
	#pendingRejections = new Set();
	#timeout = 0;

	constructor(sqlite3ExePath, { dbPath, logger, timeout } = {}) {
		this.#logger = logger;
		this.#timeout = timeout;
		this.#initProcess(sqlite3ExePath, dbPath);
	}

	// ----------------------------
	// 进程初始化与事件绑定
	// ----------------------------
	#initProcess(sqlite3ExePath, dbPath) {
		try {
			const args = dbPath ? [dbPath] : ["-bail"]; // -bail: 出错时停止执行
			this.#proc = spawn(sqlite3ExePath, args, {
				stdio: "pipe",
				windowsHide: true, // Windows 下隐藏子进程窗口
			});

			this.#proc.stdin.setDefaultEncoding("utf-8");
			this.#bindProcessEvents();
			this.#setupStdoutReader();

			this.#logger?.debug("SQLite process started");
		} catch (error) {
			this.#handleFatalError(new Error(`Failed to start SQLite process: ${error.message}`));
		}
	}

	#bindProcessEvents() {
		this.#proc.on("error", (error) => {
			this.#logger?.error("SQLite process error:", error);
			this.#handleFatalError(error);
		});

		this.#proc.stderr.on("data", (chunk) => {
			this.#stderrBuffer += chunk.toString();
		});

		this.#proc.on("close", (code, signal) => {
			const message = signal ? `SQLite process killed by signal: ${signal}` : `SQLite process exited with code: ${code}`;
			this.#handleFatalError(new Error(message));
		});
	}

	#setupStdoutReader() {
		this.#rl = readline.createInterface({
			input: this.#proc.stdout,
			terminal: false,
			crlfDelay: Infinity, // 正确处理不同平台的换行符
		});

		this.#rl.on("line", (line) => this.#handleLine(line.trim()));
		this.#rl.on("close", () => {
			this.#logger?.debug("Readline interface closed");
		});
	}

	// ----------------------------
	// 主接口方法
	// ----------------------------
	async exec(sql, params = []) {
		this.#checkIfClosed();
		return await this.#enqueueSQL(sql, params);
	}

	async query(sql, params = []) {
		this.#checkIfClosed();

		if (!this.#modeIsSet) {
			await this.#enqueueCommand(".mode json");
			this.#modeIsSet = true;
		}

		const raw = await this.#enqueueSQL(sql, params);
		if (!raw.trim()) return [];

		try {
			return JSON.parse(raw);
		} catch (parseError) {
			throw new Error(`Invalid JSON response from SQLite: ${raw.substring(0, 200)}`, {
				cause: parseError,
			});
		}
	}

	async batch(operations) {
		this.#checkIfClosed();

		const results = [];
		for (const op of operations) {
			if (typeof op === "string") {
				results.push(await this.exec(op));
			} else if (Array.isArray(op)) {
				const [sql, params] = op;
				results.push(await this.exec(sql, params));
			} else if (op.sql) {
				const { sql, params = [] } = op;
				results.push(await this.exec(sql, params));
			} else {
				throw new Error(`Invalid operation format: ${JSON.stringify(op)}`);
			}
		}
		return results;
	}

	async close() {
		if (this.#closed) return;

		this.#logger?.debug("Closing SQLite wrapper");
		this.#closed = true;

		// 拒绝所有待处理的请求
		for (const rejection of this.#pendingRejections) {
			rejection(new Error("SQLite wrapper is closing"));
		}
		this.#pendingRejections.clear();

		// 清理队列
		this.#queue.length = 0;

		// 优雅关闭进程
		try {
			if (this.#rl) {
				this.#rl.close();
				this.#rl = null;
			}

			if (this.#proc) {
				// 发送退出命令
				this.#proc.stdin.write(".exit" + EOL);
				this.#proc.stdin.end();

				// 强制终止如果进程不退出
				setTimeout(() => {
					if (this.#proc && !this.#proc.killed) {
						this.#proc.kill("SIGTERM");
					}
				}, 1000).unref();
			}
		} catch (error) {
			this.#logger?.warn("Error during close:", error);
		} finally {
			this.#proc = null;
		}
	}

	// ----------------------------
	// 状态检查方法
	// ----------------------------
	#checkIfClosed() {
		if (this.#closed) {
			throw new Error("SQLite wrapper is closed");
		}
		if (!this.#proc || this.#proc.killed) {
			throw new Error("SQLite process is not available");
		}
	}

	get isClosed() {
		return this.#closed;
	}

	get queueLength() {
		return this.#queue.length;
	}

	// ----------------------------
	// 队列系统
	// ----------------------------
	#enqueueSQL(sql, params) {
		return this.#enqueueOperation(sql, params, false);
	}

	#enqueueCommand(command) {
		return this.#enqueueOperation(command, [], true);
	}

	#enqueueOperation(sql, params, isRaw) {
		return new Promise((resolve, reject) => {
			// 创建超时处理
			const timeoutId = this.#timeout
				? setTimeout(() => {
						reject(new Error(`SQL operation timeout after ${this.#timeout}ms: ${sql.substring(0, 100)}`));
						this.#pendingRejections.delete(reject);
				  }, this.#timeout)
				: null;

			const operation = {
				sql: isRaw ? sql : interpolateSQL(sql, params),
				resolve: (result) => {
					timeoutId && clearTimeout(timeoutId);
					this.#pendingRejections.delete(reject);
					resolve(result);
				},
				reject: (error) => {
					timeoutId && clearTimeout(timeoutId);
					this.#pendingRejections.delete(reject);
					reject(error);
				},
				isRaw,
			};

			this.#pendingRejections.add(reject);
			this.#queue.push(operation);
			this.#maybeProcessNext();
		});
	}

	#maybeProcessNext() {
		if (this.#closed || this.#current || this.#queue.length === 0) return;

		this.#current = this.#queue.shift();
		const { sql, isRaw } = this.#current;

		// 格式化 SQL 语句
		const statement = isRaw ? sql : this.#formatSQLStatement(sql);

		this.#logger?.debug("Executing SQL:", statement);

		try {
			this.#proc.stdin.write(statement + EOL + END_SIGNAL + EOL);
		} catch (error) {
			this.#current.reject(new Error(`Failed to write to SQLite process: ${error.message}`));
			this.#current = null;
			this.#maybeProcessNext();
		}
	}

	#formatSQLStatement(sql) {
		return sql
			.trim()
			.replace(/;*$/, ";") // 确保以分号结尾
			.replace(/\s+/g, " "); // 标准化空格
	}

	// ----------------------------
	// 输出处理
	// ----------------------------
	#handleLine(line) {
		if (END_MARKERS.has(line)) {
			this.#finalizeCurrent();
		} else {
			this.#stdoutBuffer += line + EOL;
		}
	}

	#finalizeCurrent() {
		if (!this.#current) return;

		const result = this.#stdoutBuffer.trim();
		const error = this.#stderrBuffer.trim();

		this.#stdoutBuffer = "";
		this.#stderrBuffer = "";

		const { resolve, reject } = this.#current;
		this.#current = null;

		if (error) {
			const sqlError = new Error(`SQLite error: ${error}`);
			sqlError.sql = this.#current?.sql; // 保留出错的 SQL
			reject(sqlError);
		} else {
			resolve(result);
		}

		this.#maybeProcessNext();
	}

	#handleFatalError(error) {
		if (this.#closed) return;

		this.#closed = true;
		this.#logger?.error("Fatal SQLite error:", error);

		// 拒绝当前操作
		if (this.#current) {
			this.#current.reject(
				new Error(`SQLite process fatal error: ${error.message}`, {
					cause: error,
				})
			);
			this.#current = null;
		}

		// 拒绝所有待处理的操作
		for (const operation of this.#queue) {
			operation.reject(
				new Error(`SQLite process fatal error: ${error.message}`, {
					cause: error,
				})
			);
		}
		this.#queue.length = 0;

		// 拒绝所有待处理的 rejection
		for (const rejection of this.#pendingRejections) {
			rejection(
				new Error(`SQLite process fatal error: ${error.message}`, {
					cause: error,
				})
			);
		}
		this.#pendingRejections.clear();

		// 清理资源
		this.#cleanup();
	}

	#cleanup() {
		try {
			if (this.#rl) {
				this.#rl.close();
				this.#rl = null;
			}
			if (this.#proc) {
				this.#proc.kill();
				this.#proc = null;
			}
		} catch (error) {
			this.#logger?.warn("Error during cleanup:", error);
		}
	}

	// ----------------------------
	// 析构函数
	// ----------------------------
	async [Symbol.asyncDispose]() {
		await this.close();
	}
}
