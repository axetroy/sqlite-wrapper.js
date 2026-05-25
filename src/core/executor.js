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
import { setupStreamParser, AsyncRowBuffer } from "../stream/queryStream.js";
import { interpolateSQL, normalizeSQL } from "../utils.js";
import { classifySQL } from "./classifier.js";
import { ReaderPool } from "./readerPool.js";
import { Metrics } from "./metrics.js";

const DEFAULT_BATCH_SIZE = 10;

/**
 * SQLite 执行器。
 *
 * 通过 stdin/stdout 与 sqlite3 CLI 进程通信，提供 execute/query/stream/transaction API。
 * 内部使用管线化队列批量发送任务，基于 Sentinel token 协议检测单个 SQL 任务的输出边界。
 */
export class SQLiteExecutor {
	queue = new Queue();
	#deferredQueue = new Queue();
	#activeScopeId = null;
	#scopeChain = Promise.resolve();
	#closed = false;
	#proc = null;
	#inflightTasks = [];
	#pendingFinalizeTasks = new Set();
	#sharedValueParser = null;
	#logger;
	#statementTimeout;
	#autoRestart;
	#fatalError = null;
	#processManager;
	#readerPool = null;
	#poolSize;
	#binary;
	#database;
	#metrics;

	/**
	 * @param {{
	 *   binary?: string,
	 *   database?: string,
	 *   logger?: import("../index.js").Logger,
	 *   statementTimeout?: number,
	 *   autoRestart?: boolean,
	 *   poolSize?: number,
	 *   metrics?: import("./metrics.js").Metrics,
	 * }} options
	 */
	constructor({ binary = "sqlite3", database = ":memory:", logger, statementTimeout = DEFAULT_STATEMENT_TIMEOUT, autoRestart = true, poolSize = 0, metrics } = {}) {
		this.#logger = logger;
		this.#statementTimeout = this.#normalizeTimeout(statementTimeout);
		this.#autoRestart = autoRestart !== false;
		this.#binary = binary;
		this.#database = database;
		this.#poolSize = poolSize;
		this.#metrics = metrics ?? new Metrics();

		this.#processManager = new ProcessManager({ binary, database });
		this.#sharedValueParser = createJsonValueParser((raw) => this.#handleParsedValue(raw));
		this.#startProcess();

		if (poolSize > 0 && database !== ":memory:") {
			this.#readerPool = new ReaderPool({
				binary,
				database,
				poolSize,
				statementTimeout,
				logger,
				metrics: this.#metrics,
			});
		}
	}

	/** 当前待处理的任务总数（队列中 + 执行中 + reader 队列中） */
	get pendingStatements() {
		return this.queue.size + this.#deferredQueue.size + this.#inflightTasks.length + this.#pendingFinalizeTasks.size + (this.#readerPool?.pendingStatements ?? 0);
	}

	/** 读取器连接池（null 表示未启用读写分离）。 */
	get readerPool() {
		return this.#readerPool;
	}

	/** 运行时指标收集器。 */
	get metrics() {
		return this.#metrics;
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
	 * 流式执行查询，返回 AsyncIterable，可配合 `for await` 逐行消费。
	 *
	 * @template T
	 * @param {string} sql
	 * @param {any[]} [params]
	 * @param {{ timeout?: number }} [options]
	 * @returns {AsyncIterable<T>}
	 */
	stream(sql, params = [], options = {}) {
		if (!Array.isArray(params)) throw new TypeError("params must be an array");

		const buffer = new AsyncRowBuffer();

		this.#enqueue("stream", sql, params, {
			...options,
			onRow: (row) => buffer.push(row),
		}, null).then(
			() => buffer.end(),
			(err) => buffer.error(err),
		);

		return buffer;
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
			stream: (sql, params = [], txOptions = {}) => {
				if (!Array.isArray(params)) throw new TypeError("params must be an array");
				const buffer = new AsyncRowBuffer();
				this.#enqueue("stream", sql, params, { ...txOptions, onRow: (row) => buffer.push(row) }, scopeId)
					.then(() => buffer.end(), (err) => buffer.error(err));
				return buffer;
			},
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

		this.#readerPool?.kill();

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
		this.#sharedValueParser?.reset();
		let proc;
		try {
			proc = this.#processManager.start();
		} catch (error) {
			this.#fatalError = toError(error);
			this.#logger?.error?.("failed to start sqlite3 process", this.#fatalError);
			return;
		}

		if (!proc.stdout) {
			this.#fatalError = new Error(`Failed to spawn sqlite3 process: stdio unavailable (binary=${this.#binary})`);
			this.#processManager.kill();
			return;
		}

		proc.stdout.on("data", (chunk) => {
			this.#handleStdoutChunk(chunk);
		});

		proc.stderr?.on("data", (chunk) => {
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
	 * 决定任务应该由 writer 还是 reader 执行，并分发。
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

		const timeout = options?.timeout ?? this.#statementTimeout;
		const token = generateToken();
		const onRow = options?.onRow ?? null;

		// Normalize the TEMPLATE first so:
		//   - normalizeSQL cache key = original SQL (template, not interpolated)
		//   - classifySQL also uses a cacheable key (normalized template with ? preserved)
		//   - buildPayload can skip the second normalizeSQL scan
		const normalized = normalizeSQL(sql);

		let formatted;
		let sqlNormalized = true;
		if (params.length === 0 && !normalized.includes("?")) {
			formatted = normalized;
		} else {
			formatted = interpolateSQL(normalized, params);
		}

		if (scopeId) {
			return this.#enqueueWriter(kind, formatted, timeout, token, onRow, scopeId, sqlNormalized);
		}

		if (this.#readerPool) {
			if (kind === "stream" || kind === "query") {
				return this.#enqueueReader(kind, formatted, timeout, token, onRow);
			}
			if (kind === "execute" && classifySQL(normalized) === "read") {
				return this.#enqueueReader(kind, formatted, timeout, token, onRow);
			}
		}

		return this.#enqueueWriter(kind, formatted, timeout, token, onRow, null, sqlNormalized);
	}

	/**
	 * 创建任务发送到 writer 队列。
	 * @param {"execute" | "query" | "stream"} kind
	 * @param {string} sql
	 * @param {number} timeout
	 * @param {string} token
	 * @param {Function | null} onRow
	 * @param {symbol | null} scopeId
	 * @param {boolean} [sqlNormalized=false]
	 * @returns {Promise<any>}
	 */
	#enqueueWriter(kind, sql, timeout, token, onRow, scopeId, sqlNormalized = false) {
		this.#metrics.incrementTasksTotal(kind);
		return new Promise((resolve, reject) => {
			const task = {
				kind,
				sql,
				timeout,
				token,
				onRow,
				scopeId,
				sqlNormalized,
				rows: [],
				resolve,
				reject,
				consumerError: null,
				stderrText: "",
				errorScheduled: false,
				timer: null,
				startTime: 0,
				rowParser: null,
				valueParser: null,
			};

			if (kind === "stream") {
				task.rowParser = setupStreamParser(task);
				task.valueParser = this.#sharedValueParser;
			}

			if (this.#activeScopeId && this.#activeScopeId !== scopeId) {
				this.#deferredQueue.enqueue(task);
			} else {
				this.queue.enqueue(task);
			}

			this.#pumpQueue();
		});
	}

	/**
	 * 创建任务发送到 reader 池。
	 * @param {"execute" | "query" | "stream"} kind
	 * @param {string} sql
	 * @param {number} timeout
	 * @param {string} token
	 * @param {Function | null} onRow
	 * @returns {Promise<any>}
	 */
	#enqueueReader(kind, sql, timeout, token, onRow) {
		return new Promise((resolve, reject) => {
			this.#readerPool.enqueue({
				kind,
				sql,
				timeout,
				token,
				onRow,
				resolve,
				reject,
			});
		});
	}

	/**
	 * 尝试从主队列批量取出任务发送给 sqlite3 进程执行。
	 * 非 stream 任务最多批量发送 DEFAULT_BATCH_SIZE 个；
	 * stream 任务独占发送（队列中有 stream 时不会与其他任务打包）。
	 */
	#pumpQueue() {
		if (this.#closed || !this.#proc) return;

		const batch = [];
		while (batch.length < DEFAULT_BATCH_SIZE && !this.queue.isEmpty()) {
			const task = this.queue.peek();
			if (task.kind === "stream" && (batch.length > 0 || this.#inflightTasks.length > 0)) break;
			this.queue.dequeue();
			batch.push(task);
		}
		if (batch.length === 0) return;

		const now = performance.now();
		let payload = "";
		for (const task of batch) {
			payload += buildPayload(task.sql, task.token, { skipNormalize: task.sqlNormalized });
			task.startTime = now;
			task.timer = setTimeout(() => this.#handleTaskTimeout(task), task.timeout);
		}
		this.#inflightTasks.push(...batch);
		this.#processManager.write(payload);
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
		const task = this.#inflightTasks[0];
		if (!task) return;

		if (task.kind === "stream" && task.rowParser && !task.rowParser.finished) {
			const leftover = task.rowParser.feed(chunk);
			if (leftover) this.#sharedValueParser.feed(leftover);
			return;
		}

		this.#sharedValueParser.feed(chunk);
	}

	/**
	 * 处理一个完整 JSON 值的解析结果。
	 * 如果是 sentinel 行，则根据 stderr/consumerError 决定拒绝还是完成；
	 * 否则按 query/stream 类型分别收集行数据或逐行回调。
	 * @param {string} raw
	 */
	#handleParsedValue(raw) {
		const task = this.#inflightTasks[0];
		if (!task) return;

		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			this.#rejectQueues(new Error(`Invalid JSON from sqlite3: ${toError(error).message}`));
			return;
		}

		if (isSentinelRow(parsed, task.token)) {
			clearTimeout(task.timer);
			this.#inflightTasks.shift();

			if (task.stderrText) {
				this.#settleTask(task, new Error(task.stderrText.trim()), undefined);
				this.#pumpQueue();
				return;
			}

			if (task.consumerError) {
				this.#settleTask(task, task.consumerError, undefined);
				this.#pumpQueue();
				return;
			}

			this.#pendingFinalizeTasks.add(task);
			setImmediate(() => {
				if (!this.#pendingFinalizeTasks.has(task)) return;
				this.#pendingFinalizeTasks.delete(task);
				if (task.stderrText) {
					this.#settleTask(task, new Error(task.stderrText.trim()), undefined);
					return;
				}

				if (task.consumerError) {
					this.#settleTask(task, task.consumerError, undefined);
					return;
				}

				if (task.kind === "query") {
					this.#settleTask(task, null, task.rows);
					return;
				}

				this.#settleTask(task, null, undefined);
			});
			this.#pumpQueue();
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
	 * 将错误文本附加到 inflight 任务或 pendingFinalize 任务；
	 * 如果没有匹配任务则通过 logger 输出。
	 * @param {string} chunk
	 */
	#handleStderrChunk(chunk) {
		const task = this.#inflightTasks[0] ?? this.#pendingFinalizeTasks.values().next().value;
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
		if (this.#inflightTasks[0] !== task) return;
		this.#metrics.incrementTasksTimeout();
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
			this.#metrics.incrementProcessRestarts();
			this.#startProcess();
			return;
		}

		this.#fatalError = failure;
		this.#closed = true;
	}

	/** 拒绝 inflight 任务以及主队列、延迟队列、pendingFinalize 中的所有待处理任务。 */
	#rejectQueues(error) {
		const all = this.#inflightTasks;
		this.#inflightTasks = [];

		for (const task of all) {
			this.#settleTask(task, error, undefined);
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

		for (const task of this.#pendingFinalizeTasks) {
			this.#settleTask(task, error, undefined);
		}
		this.#pendingFinalizeTasks.clear();
	}

	/**
	 * 最终结算一个任务：清除定时器、重置解析器，然后 resolve 或 reject。
	 * @param {object} task
	 * @param {Error | null} error
	 * @param {any} value
	 */
	#settleTask(task, error, value) {
		clearTimeout(task.timer);
		task.rowParser?.reset?.();

		if (error) {
			this.#metrics.incrementTasksFailed();
			task.reject(toError(error));
			return;
		}

		const duration = task.startTime > 0 ? performance.now() - task.startTime : 0;
		this.#metrics.incrementTasksSuccess(duration);
		task.resolve(value);
	}
}
