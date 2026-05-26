import { ProcessManager } from "./process.js";
import { Queue } from "./queue.js";
import { createJsonValueParser, toError } from "./parser.js";
import { isSentinelRow, buildBatchPayload } from "./protocol.js";
import { createTimeoutError } from "../utils/timeout.js";
import { collectQueryRows, processStreamRows, settleTask } from "./settleUtils.js";
import { DEFAULT_BATCH_SIZE } from "../constants.js";

/**
 * 单个 sqlite3 进程的任务执行器。
 * 内部维护 pending 和 inflight 两个队列，支持管线化（pipelining）：
 * 多个任务的 SQL payload 合并为一次 stdin.write() 发送，由 sqlite3 顺序执行后，
 * 在 stdout 解析时按 FIFO 顺序匹配 sentinel token 并逐一完成 Promise。
 *
 * TaskWorker 不关心任务是读还是写——它只负责发送 SQL、解析输出、完成 Promise。
 * 由上层（SQLiteExecutor / ReaderPool）决定如何分发任务。
 */
export class TaskWorker {
	#processManager;
	#pendingQueue = new Queue();
	#inflightTasks = [];
	#pendingFinalizeTasks = new Set();
	#scheduledFinalize = false;
	#valueParser;
	#statementTimeout;
	#logger;
	#name;
	#batchSize;
	#metrics;

	/**
	 * @param {{
	 *   binary: string
	 *   database: string
	 *   statementTimeout: number
	 *   logger?: import("../index.js").Logger
	 *   name?: string
	 *   initMode?: "wal" | "none"
	 *   batchSize?: number
	 *   metrics?: import("./metrics.js").Metrics
	 * }} options
	 */
	constructor({ binary, database, statementTimeout, logger, name, initMode, batchSize = DEFAULT_BATCH_SIZE, metrics }) {
		this.#name = name ?? "worker";
		this.#statementTimeout = statementTimeout;
		this.#logger = logger;
		this.#batchSize = batchSize;
		this.#metrics = metrics;
		this.#processManager = new ProcessManager({ binary, database, initMode });
		this.#valueParser = createJsonValueParser((raw) => this.#handleParsedValue(raw));
		this.#startProcess();
	}

	get name() {
		return this.#name;
	}

	get idle() {
		return this.#inflightTasks.length === 0 && this.#pendingQueue.isEmpty() && this.#pendingFinalizeTasks.size === 0;
	}

	get pendingStatements() {
		return this.#pendingQueue.size + this.#inflightTasks.length + this.#pendingFinalizeTasks.size;
	}

	/**
	 * 接收一个任务配置并加入队列。
	 * 任务配置应包含：kind, sql, timeout, token, resolve, reject, onRow
	 * @param {object} config
	 */
	enqueue(config) {
		const task = {
			kind: config.kind,
			sql: config.sql,
			timeout: config.timeout,
			token: config.token,
			resolve: config.resolve,
			reject: config.reject,
			rows: config.kind === "query" ? [] : undefined,
			onRow: config.onRow ?? null,
			consumerError: null,
			stderrText: "",
			errorScheduled: false,
			timer: null,
			startTime: 0,
		};
		this.#metrics?.incrementTasksTotal(config.kind);
		this.#pendingQueue.enqueue(task);
		this.#pumpQueue();
	}

	/** 终止进程并清理。 */
	kill() {
		this.#rejectAll(new Error(`${this.#name} is killed`));
		this.#processManager.kill();
	}

	// ---- 内部 ----

	#startProcess() {
		const proc = this.#processManager.start();

		proc.stdout.on("data", (chunk) => {
			this.#valueParser.feed(chunk);
		});

		proc.stderr.on("data", (chunk) => {
			this.#handleStderrChunk(chunk);
		});

		proc.on("error", (error) => {
			if (this.#processManager.process !== proc) return;
			this.#logger?.error?.(`${this.#name} process error`, error);
			this.#rejectAll(toError(error));
		});

		proc.on("close", (code, signal) => {
			if (this.#processManager.process !== proc) return;
			const err = new Error(`${this.#name} exited unexpectedly (code=${code}, signal=${signal ?? "none"})`);
			this.#rejectAll(err);
		});
	}

	/**
	 * 从 pendingQueue 中取出最多 batchSize 个任务，合并 payload 后一次性写入 stdin。
	 * stream 任务必须单独发送（不与其他任务合批），且需要等 inflight 清空后再发送。
	 */
	#pumpQueue() {
		const batch = [];
		while (batch.length < this.#batchSize && !this.#pendingQueue.isEmpty()) {
			const task = this.#pendingQueue.peek();
			if (task.kind === "stream" && (batch.length > 0 || this.#inflightTasks.length > 0)) break;
			this.#pendingQueue.dequeue();
			batch.push(task);
		}
		if (batch.length === 0) return;

		const now = performance.now();

		const payload = buildBatchPayload(batch);

		for (const task of batch) {
			task.startTime = now;
			task.timer = setTimeout(() => this.#handleTaskTimeout(task), task.timeout ?? this.#statementTimeout);
		}
		this.#inflightTasks.push(...batch);
		this.#processManager.write(payload);
	}

	/**
	 * 单次 JSON 值到达时调用。
	 * 按 FIFO 顺序匹配 inflightTasks[0] 的 sentinel token。
	 */
	#handleParsedValue(raw) {
		const task = this.#inflightTasks[0];
		if (!task) return;

		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			this.#rejectAll(new Error(`Invalid JSON from sqlite3: ${toError(error).message}`));
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

			// stderr 和 stdout 是独立的 OS 管道，data 事件触发顺序无法保证。
			// 延迟一帧再 finalize，给 stderr 一个事件循环周期的时间到达。
			// 多个 task 共享同一个 setImmediate，减少事件循环开销。
			this.#pendingFinalizeTasks.add(task);
			this.#scheduleFinalizeCheck();
			this.#pumpQueue();
			return;
		}

		if (task.kind === "query") {
			collectQueryRows(task, parsed);
			return;
		}

		if (task.kind === "stream") {
			processStreamRows(task, parsed);
		}
	}

	/**
	 * 批量处理 pendingFinalize 任务，合并多次 setImmediate 为一次。
	 */
	#scheduleFinalizeCheck() {
		if (this.#scheduledFinalize) return;
		this.#scheduledFinalize = true;
		setImmediate(() => {
			this.#scheduledFinalize = false;
			// 直接遍历 Set 而非展开为数组，避免百万级 SQL 下高频率的中间数组分配
			for (const task of this.#pendingFinalizeTasks) {
				if (task.stderrText) {
					this.#settleTask(task, new Error(task.stderrText.trim()), undefined);
					continue;
				}

				if (task.consumerError) {
					this.#settleTask(task, task.consumerError, undefined);
					continue;
				}

				if (task.kind === "query") {
					this.#settleTask(task, null, task.rows);
					continue;
				}

				this.#settleTask(task, null, undefined);
			}
			this.#pendingFinalizeTasks.clear();
			this.#pumpQueue();
		});
	}

	#handleStderrChunk(chunk) {
		const task = this.#inflightTasks[0] ?? this.#pendingFinalizeTasks.values().next().value;
		if (!task) {
			this.#logger?.error?.(String(chunk).trim());
			return;
		}
		task.stderrText += String(chunk);
	}

	#handleTaskTimeout(task) {
		if (this.#inflightTasks[0] !== task) return;
		this.#metrics?.incrementTasksTimeout();
		this.#rejectAll(createTimeoutError(task.timeout, task.sql));
	}

	#settleTask(task, error, value) {
		settleTask(task, error, value, this.#metrics);
	}

	#rejectAll(error) {
		const all = this.#inflightTasks;
		this.#inflightTasks = [];

		let queued = this.#pendingQueue.dequeue();
		while (queued) {
			this.#settleTask(queued, error, undefined);
			queued = this.#pendingQueue.dequeue();
		}

		for (const task of all) {
			this.#settleTask(task, error, undefined);
		}

		for (const task of this.#pendingFinalizeTasks) {
			this.#settleTask(task, error, undefined);
		}
		this.#pendingFinalizeTasks.clear();
	}
}
