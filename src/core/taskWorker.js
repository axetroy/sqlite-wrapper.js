import { ProcessManager } from "./process.js";
import { Queue } from "./queue.js";
import { createJsonValueParser, toError } from "./parser.js";
import { isSentinelRaw, isSentinelRow, buildBatchPayload } from "./protocol.js";
import { collectQueryRows, processStreamRows, settleTask } from "./settleUtils.js";
import { finalizePendingTasks, prepareTaskTimeout } from "./pipelineUtils.js";
import { DEFAULT_BATCH_SIZE, DEFAULT_MAX_INFLIGHT } from "../constants.js";

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
	#inflightHead = 0;
	#pendingFinalizeTasks = new Set();
	#scheduledFinalize = false;
	#valueParser;
	#statementTimeout;
	#logger;
	#name;
	#batchSize;
	#maxInflight;
	#metrics;
	#sweepTimer = null;
	#sweepIntervalMs;
	/** @type {number} */
	#nextBatchId = 1;

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
	 *   sweepInterval?: number
	 * }} options
	 */
	constructor({ binary, database, statementTimeout, logger, name, initMode, batchSize = DEFAULT_BATCH_SIZE, maxInflight = DEFAULT_MAX_INFLIGHT, metrics, sweepInterval = 100 }) {
		this.#name = name ?? "worker";
		this.#statementTimeout = statementTimeout;
		this.#logger = logger;
		this.#batchSize = batchSize;
		this.#maxInflight = maxInflight;
		this.#metrics = metrics;
		this.#sweepIntervalMs = sweepInterval;
		this.#processManager = new ProcessManager({ binary, database, initMode, onDrain: () => this.#pumpQueue() });
		this.#valueParser = createJsonValueParser((raw) => this.#handleParsedValue(raw));
		this.#startProcess();
	}

	get name() {
		return this.#name;
	}

	get idle() {
		return this.#inflightTasks.length === this.#inflightHead && this.#pendingQueue.isEmpty() && this.#pendingFinalizeTasks.size === 0;
	}

	get pendingStatements() {
		return this.#pendingQueue.size + (this.#inflightTasks.length - this.#inflightHead) + this.#pendingFinalizeTasks.size;
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
			settled: false,
			startTime: 0,
		};
		this.#metrics?.incrementTasksTotal(config.kind);
		this.#pendingQueue.enqueue(task);
		this.#pumpQueue();
	}

	/** 测试用：获取扫制定时器引用。 */
	get _sweepTimer() {
		return this.#sweepTimer;
	}

	/** 测试用：获取底层子进程引用。 */
	get _process() {
		return this.#processManager.process;
	}

	/** 终止进程并清理。 */
	kill() {
		clearTimeout(this.#sweepTimer);
		this.#sweepTimer = null;
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

	#inflightCount() {
		return this.#inflightTasks.length - this.#inflightHead;
	}

	#firstInflight() {
		return this.#inflightHead < this.#inflightTasks.length ? this.#inflightTasks[this.#inflightHead] : null;
	}

	#shiftInflight() {
		const task = this.#inflightTasks[this.#inflightHead];
		this.#inflightTasks[this.#inflightHead] = null;
		this.#inflightHead++;
		if (this.#inflightHead >= this.#inflightTasks.length) {
			this.#inflightTasks = [];
			this.#inflightHead = 0;
		} else if (this.#inflightHead > 128) {
			this.#inflightTasks = this.#inflightTasks.slice(this.#inflightHead);
			this.#inflightHead = 0;
		}
		return task;
	}

	/**
	 * 从 pendingQueue 中取出最多 batchSize 个任务，合并 payload 后一次性写入 stdin。
	 * stream 任务必须单独发送（不与其他任务合批），且需要等 inflight 清空后再发送。
	 */
	#pumpQueue() {
		if (this.#processManager.draining) {
			this.#processManager.onDrained(() => this.#pumpQueue());
			return;
		}
		if (this.#inflightCount() >= this.#maxInflight) return;

		const batch = [];
		while (
			batch.length < this.#batchSize &&
			!this.#pendingQueue.isEmpty() &&
			this.#inflightCount() + batch.length < this.#maxInflight
		) {
			const task = this.#pendingQueue.peek();
			if (task.kind === "stream" && (batch.length > 0 || this.#inflightCount() > 0)) break;
			this.#pendingQueue.dequeue();
			batch.push(task);
		}
		if (batch.length === 0) return;

		const now = performance.now();

		const payload = buildBatchPayload(batch);
		const batchId = this.#nextBatchId++;
		const useWalBatch = payload.startsWith("BEGIN;");

		// 分配 batchId 和 walBatch 标记（供 P0 stderr 传播使用）
		for (const task of batch) {
			task.startTime = now;
			task.batchId = batchId;
			task.walBatch = useWalBatch;
		}
		this.#inflightTasks.push(...batch);
		this.#scheduleSweep();
		this.#processManager.write(payload);
	}

	/**
	 * 单次 JSON 值到达时调用。
	 * 按 FIFO 顺序匹配 inflightTasks[0] 的 sentinel token。
	 */
	#handleParsedValue(raw) {
		const task = this.#firstInflight();
		if (!task) return;

		// Fast path: 原始字符串精确匹配 sentinel，跳过 JSON.parse
		if (isSentinelRaw(raw, task.token)) {
			this.#shiftInflight();

			if (task.timedout) {
				this.#pumpQueue();
				return;
			}

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

		// Fast path: 空数组 []，execute 的零行结果，跳过 JSON.parse
		if (raw === "[]") return;

		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			this.#rejectAll(new Error(`Invalid JSON from sqlite3: ${toError(error).message}`));
			return;
		}

		if (isSentinelRow(parsed, task.token)) {
			this.#shiftInflight();

			if (task.timedout) {
				this.#pumpQueue();
				return;
			}

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
			this.#scheduleFinalizeCheck();
			this.#pumpQueue();
			return;
		}

		if (task.timedout) return;

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
			finalizePendingTasks(this.#pendingFinalizeTasks, (t, e, v) => this.#settleTask(t, e, v), () => this.#pumpQueue());
		});
	}

	#handleStderrChunk(chunk) {
		const task = this.#pendingFinalizeTasks.values().next().value ?? this.#firstInflight();
		if (!task) {
			this.#logger?.error?.(chunk.trim());
			return;
		}
		task.stderrText += chunk;

		// P0 修复：传播到所有涉及的任务（不依赖 walBatch 标记）
		if (task.batchId != null) {
			// pendingFinalize 中所有任务（同 batch + 跨 batch）
			for (const t of this.#pendingFinalizeTasks) {
				if (t !== task) {
					t.stderrText += chunk;
				}
			}
			// inflight 中所有任务
			for (let i = this.#inflightHead; i < this.#inflightTasks.length; i++) {
				const t = this.#inflightTasks[i];
				if (t && t !== task) {
					t.stderrText += chunk;
				}
			}
		}
	}

	#scheduleSweep() {
		if (this.#sweepTimer) return;
		this.#sweepTimer = setTimeout(() => {
			this.#sweepTimer = null;
			const tasks = this.#inflightTasks;
			const head = this.#inflightHead;
			const now = performance.now();
			for (let i = head; i < tasks.length; i++) {
				const task = tasks[i];
				if (now - task.startTime > task.timeout) {
					this.#handleTaskTimeout(task);
				}
			}
			if (this.#inflightCount() > 0) {
				this.#scheduleSweep();
			}
		}, this.#sweepIntervalMs).unref();
	}

	#handleTaskTimeout(task) {
		const error = prepareTaskTimeout(task, this.#metrics);
		if (error) this.#settleTask(task, error, undefined);
	}

	#settleTask(task, error, value) {
		settleTask(task, error, value, this.#metrics);
	}

	#rejectAll(error) {
		clearTimeout(this.#sweepTimer);
		this.#sweepTimer = null;

		const activeCount = this.#inflightTasks.length - this.#inflightHead;
		const all = activeCount > 0 ? this.#inflightTasks.slice(this.#inflightHead) : [];
		this.#inflightTasks = [];
		this.#inflightHead = 0;

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
