import { once } from "node:events";
import { DEFAULT_STATEMENT_TIMEOUT } from "../utils/timeout.js";
import { VALID_TRANSACTION_MODES } from "../transaction/transaction.js";
import { Queue } from "./queue.js";
import { ProcessManager } from "./process.js";
import { createJsonValueParser } from "./parser.js";
import { toError } from "./parser.js";
import { isSentinelRow } from "./protocol.js";
import { buildPayload } from "./protocol.js";
import { generateToken } from "../utils/token.js";
import { createTimeoutError } from "../utils/timeout.js";
import { setupStreamParser } from "../stream/queryStream.js";
import { interpolateSQL } from "../utils.js";

/**
 * SQLite 执行器。
 *
 * 通过 stdin/stdout 与 sqlite3 CLI 进程通信，提供 execute/query/queryStream/transaction API。
 * 内部使用串行队列保证任务按顺序执行，基于 Sentinel token 协议检测单个 SQL 任务的输出边界。
 */
export class SQLiteExecutor {
	queue = new Queue();
	#deferredQueue = new Queue();
	#activeScopeId = null;
	#scopeChain = Promise.resolve();
	#closed = false;
	#currentTask = null;
	#proc = null;
	#logger;
	#statementTimeout;
	#autoRestart;
	#fatalError = null;
	#processManager;

	/**
	 * @param {{
	 *   binary?: string,
	 *   database?: string,
	 *   logger?: import("../index.js").Logger,
	 *   statementTimeout?: number,
	 *   autoRestart?: boolean,
	 * }} options
	 */
	constructor({ binary = "sqlite3", database = ":memory:", logger, statementTimeout = DEFAULT_STATEMENT_TIMEOUT, autoRestart = true } = {}) {
		this.#logger = logger;
		this.#statementTimeout = this.#normalizeTimeout(statementTimeout);
		this.#autoRestart = autoRestart !== false;
		this.#processManager = new ProcessManager({ binary, database });
		this.#startProcess();
	}

	/** 当前待处理的任务总数（队列中 + 执行中） */
	get pendingStatements() {
		return this.queue.size + this.#deferredQueue.size + (this.#currentTask ? 1 : 0);
	}

	/**
	 * 执行 SQL 语句（不返回行数据）。
	 * 适用于 INSERT / UPDATE / CREATE 等非查询操作。
	 * @param {string} sql
	 * @param {any[]} [params]
	 * @param {{ timeout?: number }} [options]
	 * @returns {Promise<void>}
	 */
	async execute(sql, params = [], options = {}) {
		await this.#enqueue("execute", sql, params, options, null);
	}

	/**
	 * 执行查询并返回所有结果行。
	 * @template T
	 * @param {string} sql
	 * @param {any[]} [params]
	 * @param {{ timeout?: number }} [options]
	 * @returns {Promise<T[]>}
	 */
	query(sql, params = [], options = {}) {
		return this.#enqueue("query", sql, params, options, null);
	}

	/**
	 * 流式执行查询，每返回一行就调用 onRow 回调。
	 * 不会将所有结果一次性缓存在内存中。
	 * @template T
	 * @param {string} sql
	 * @param {(row: T) => void} onRow
	 * @param {any[]} [params]
	 * @param {{ timeout?: number }} [options]
	 * @returns {Promise<void>}
	 */
	queryStream(sql, onRow, params = [], options = {}) {
		if (typeof onRow !== "function") {
			return Promise.reject(new TypeError("queryStream requires an onRow callback"));
		}
		return this.#enqueue("stream", sql, params, { ...options, onRow }, null);
	}

	/**
	 * 在一个数据库事务中执行用户函数。
	 * 事务内所有操作共享一个域，不会被外部任务交错。
	 * 函数成功时自动 COMMIT，抛出异常时自动 ROLLBACK。
	 * @template T
	 * @param {(tx: import("../index.js").TransactionHandle) => Promise<T>} fn
	 * @param {{ mode?: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE" }} [options]
	 * @returns {Promise<T>}
	 */
	async transaction(fn, options = {}) {
		const mode = options?.mode ?? "DEFERRED";
		if (!VALID_TRANSACTION_MODES.includes(mode)) {
			throw new TypeError(`transaction mode must be one of: ${VALID_TRANSACTION_MODES.join(", ")}`);
		}

		const scopeId = Symbol("transaction");
		let release = null;
		const gate = new Promise((resolve) => {
			release = resolve;
		});

		const previous = this.#scopeChain;
		this.#scopeChain = previous.catch(() => {}).then(() => gate);
		await previous.catch(() => {});
		this.#activeScopeId = scopeId;

		const tx = {
			execute: (sql, params = [], txOptions = {}) => this.#enqueue("execute", sql, params, txOptions, scopeId),
			query: (sql, params = [], txOptions = {}) => this.#enqueue("query", sql, params, txOptions, scopeId),
			queryStream: (sql, onRow, params = [], txOptions = {}) =>
				this.#enqueue("stream", sql, params, { ...txOptions, onRow }, scopeId),
		};

		try {
			await tx.execute(`BEGIN ${mode}`);
			try {
				const result = await fn(tx);
				await tx.execute("COMMIT");
				return result;
			} catch (error) {
				await tx.execute("ROLLBACK").catch(() => {});
				throw error;
			}
		} finally {
			this.#activeScopeId = null;
			this.#restoreDeferred();
			release();
		}
	}

	/**
	 * 关闭执行器，拒绝所有待处理任务，终止 sqlite3 进程。
	 * @returns {Promise<void>}
	 */
	async close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#rejectQueues(new Error("SQLiteExecutor is closed"));

		this.#processManager.kill();
		try {
			await once(this.#processManager.process, "close");
		} catch {
		}
	}

	[Symbol.asyncDispose]() {
		return this.close();
	}

	[Symbol.dispose]() {
		void this.close();
	}

	/**
	 * 验证超时时间配置是否合法。
	 * @param {unknown} value
	 * @returns {number}
	 */
	#normalizeTimeout(value) {
		if (!Number.isInteger(value) || value <= 0) {
			throw new TypeError("statementTimeout must be a positive integer");
		}
		return value;
	}

	/**
	 * 启动 sqlite3 进程并注册 stdout/stderr/error/close 事件处理。
	 */
	#startProcess() {
		const proc = this.#processManager.start();

		proc.stdout.on("data", (chunk) => {
			this.#handleStdoutChunk(chunk);
		});

		proc.stderr.on("data", (chunk) => {
			this.#handleStderrChunk(chunk);
		});

		proc.on("error", (error) => {
			this.#logger?.error?.("sqlite3 process error", error);
			this.#handleProcessFailure(error);
		});

		proc.on("close", (code, signal) => {
			if (this.#closed) return;
			this.#handleProcessFailure(new Error(`sqlite3 process exited unexpectedly (code=${code}, signal=${signal ?? "none"})`));
		});

		this.#proc = proc;
		this.#pumpQueue();
	}

	/**
	 * 创建一个任务并加入队列。
	 * 如果当前处于事务域中且任务不属于该事务，则放入延迟队列。
	 * @param {"execute" | "query" | "stream"} kind
	 * @param {string} sql
	 * @param {any[]} params
	 * @param {{ timeout?: number, onRow?: Function }} options
	 * @param {symbol | null} scopeId
	 * @returns {Promise<any>}
	 */
	#enqueue(kind, sql, params, options, scopeId) {
		if (this.#closed) return Promise.reject(new Error("SQLiteExecutor is closed"));
		if (this.#fatalError) return Promise.reject(this.#fatalError);
		if (!Array.isArray(params)) return Promise.reject(new TypeError("params must be an array"));

		const formatted = params.length === 0 && !sql.includes("?") ? sql : interpolateSQL(sql, params);
		const timeout = options?.timeout ?? this.#statementTimeout;

		return new Promise((resolve, reject) => {
			const task = {
				kind,
				sql: formatted,
				scopeId,
				timeout,
				token: generateToken(),
				rows: [],
				resolve,
				reject,
				onRow: options?.onRow ?? null,
				consumerError: null,
				stderrText: "",
				errorScheduled: false,
				timer: null,
				valueParser: null,
				rowParser: null,
			};

			task.valueParser = createJsonValueParser((raw) => {
				this.#handleJsonValue(task, raw);
			});

			task.rowParser = setupStreamParser(task);

			if (this.#activeScopeId && this.#activeScopeId !== scopeId) {
				this.#deferredQueue.enqueue(task);
			} else {
				this.queue.enqueue(task);
			}

			this.#pumpQueue();
		});
	}

	/**
	 * 尝试从主队列取出下一个任务发送给 sqlite3 进程执行。
	 * 只有在没有当前任务、进程存在且未关闭时才会执行。
	 */
	#pumpQueue() {
		if (this.#closed || this.#currentTask || !this.#proc) return;
		const task = this.queue.dequeue();
		if (!task) return;

		this.#currentTask = task;
		task.timer = setTimeout(() => {
			this.#handleTaskTimeout(task);
		}, task.timeout);

		this.#processManager.write(buildPayload(task.sql, task.token));
	}

	/** 将延迟队列中的任务恢复到主队列头部。 */
	#restoreDeferred() {
		this.queue.prependAll(this.#deferredQueue);
		this.#pumpQueue();
	}

	/**
	 * 处理 sqlite3 的 stdout 输出。
	 * 对于 stream 类型任务，先通过行流解析器逐行处理，剩余数据转给 JSON 值解析器。
	 * @param {string} chunk
	 */
	#handleStdoutChunk(chunk) {
		const task = this.#currentTask;
		if (!task) return;

		if (task.kind === "stream" && task.rowParser && !task.rowParser.finished) {
			const leftover = task.rowParser.feed(chunk);
			if (leftover) task.valueParser.feed(leftover);
			return;
		}

		task.valueParser.feed(chunk);
	}

	/**
	 * 处理一个完整 JSON 值的解析结果。
	 * 如果是 sentinel 行，则根据 stderr/consumerError 决定拒绝还是完成；
	 * 否则按 query/stream 类型分别收集行数据或逐行回调。
	 * @param {object} task
	 * @param {string} raw
	 */
	#handleJsonValue(task, raw) {
		if (task !== this.#currentTask) return;

		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			this.#finalizeTask(task, { error: new Error(`Invalid JSON from sqlite3: ${toError(error).message}`) });
			return;
		}

		if (isSentinelRow(parsed, task.token)) {
			if (task.stderrText) {
				this.#finalizeTask(task, { error: new Error(task.stderrText.trim()) });
				return;
			}

			if (task.consumerError) {
				this.#finalizeTask(task, { error: task.consumerError });
				return;
			}

			if (task.kind === "query") {
				this.#finalizeTask(task, { value: task.rows });
				return;
			}

			this.#finalizeTask(task, { value: undefined });
			return;
		}

		if (task.kind === "query") {
			if (Array.isArray(parsed)) task.rows.push(...parsed);
			return;
		}

		if (task.kind === "stream") {
			if (!Array.isArray(parsed)) return;
			for (const row of parsed) {
				if (task.consumerError) break;
				try {
					task.onRow(row);
				} catch (error) {
					task.consumerError = toError(error);
				}
			}
		}
	}

	/**
	 * 处理 sqlite3 的 stderr 输出。
	 * 将错误文本附加到当前任务；如果没有当前任务则通过 logger 输出。
	 * @param {string} chunk
	 */
	#handleStderrChunk(chunk) {
		const task = this.#currentTask;
		if (!task) {
			this.#logger?.error?.(String(chunk).trim());
			return;
		}

		task.stderrText += String(chunk);
	}

	/**
	 * 任务超时处理，触发进程级失败恢复。
	 * @param {object} task
	 */
	#handleTaskTimeout(task) {
		if (task !== this.#currentTask) return;
		this.#handleProcessFailure(createTimeoutError(task.timeout, task.sql));
	}

	/**
	 * 处理 sqlite3 进程级别的失败。
	 * 杀死当前进程、拒绝所有队列中的任务。
	 * 如果启用了 autoRestart 则自动重启进程。
	 * @param {Error} error
	 */
	#handleProcessFailure(error) {
		const failure = toError(error);
		const proc = this.#processManager.kill();
		this.#proc = null;

		this.#rejectQueues(failure);

		if (!this.#closed && this.#autoRestart) {
			this.#startProcess();
			return;
		}

		this.#fatalError = failure;
		this.#closed = true;
	}

	/** 拒绝当前任务以及主队列、延迟队列中的所有待处理任务。 */
	#rejectQueues(error) {
		if (this.#currentTask) {
			this.#settleTask(this.#currentTask, error, undefined);
			this.#currentTask = null;
		}

		let queued = this.queue.dequeue();
		while (queued) {
			this.#settleTask(queued, error, undefined);
			queued = this.queue.dequeue();
		}

		let deferred = this.#deferredQueue.dequeue();
		while (deferred) {
			this.#settleTask(deferred, error, undefined);
			deferred = this.#deferredQueue.dequeue();
		}
	}

	/**
	 * 完成一个任务，清除当前任务引用并尝试派发下一个任务。
	 * @param {object} task
	 * @param {{ error?: Error | null, value?: any }} result
	 */
	#finalizeTask(task, { error = null, value = undefined }) {
		if (task !== this.#currentTask) return;
		this.#settleTask(task, error, value);
		this.#currentTask = null;
		this.#pumpQueue();
	}

	/**
	 * 最终结算一个任务：清除定时器、重置解析器，然后 resolve 或 reject。
	 * @param {object} task
	 * @param {Error | null} error
	 * @param {any} value
	 */
	#settleTask(task, error, value) {
		clearTimeout(task.timer);
		task.valueParser?.reset?.();
		task.rowParser?.reset?.();

		if (error) {
			task.reject(toError(error));
			return;
		}

		task.resolve(value);
	}
}
