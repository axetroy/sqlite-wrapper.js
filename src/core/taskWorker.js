import { ProcessManager } from "./process.js";
import { Queue } from "./queue.js";
import { InflightTracker } from "./inflightTracker.js";
import { createJsonValueParser, toError } from "./parser.js";
import { buildBatchPayload } from "./protocol.js";
import { settleTask } from "./settleUtils.js";
import { handleParsedValue, createSweeper, createFinalizeScheduler, prepareTaskTimeout } from "./pipelineUtils.js";
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
	#inflight = new InflightTracker();
	#pendingFinalizeTasks = new Set();
	#valueParser;
	#statementTimeout;
	#logger;
	#name;
	#batchSize;
	#maxInflight;
	#metrics;
	#sweeper;
	/** 由 createFinalizeScheduler 创建的闭包，替代 #scheduleFinalizeCheck 方法 */
	#scheduleFinalizeCheck;
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

		// 创建共享管道组件
		this.#sweeper = createSweeper({
			inflight: this.#inflight,
			sweepIntervalMs: sweepInterval,
			handleTaskTimeout: (task) => {
				const error = prepareTaskTimeout(task, this.#metrics);
				if (error) this.#settleTask(task, error, undefined);
			},
		});
		this.#scheduleFinalizeCheck = createFinalizeScheduler({
			pendingFinalizeTasks: this.#pendingFinalizeTasks,
			settleTask: (t, e, v) => this.#settleTask(t, e, v),
			pumpQueue: () => this.#pumpQueue(),
		});
		this.#valueParser = createJsonValueParser((raw) => {
			handleParsedValue(raw, this.#inflight, {
				afterSentinel: (task) => this.#afterSentinel(task),
				rejectAll: (error) => this.#rejectAll(error),
			});
		});
		this.#processManager = new ProcessManager({ binary, database, initMode, onDrain: () => this.#pumpQueue() });
		this.#startProcess();
	}

	get name() {
		return this.#name;
	}

	get idle() {
		return this.#inflight.count === 0 && this.#pendingQueue.isEmpty() && this.#pendingFinalizeTasks.size === 0;
	}

	get pendingStatements() {
		return this.#pendingQueue.size + this.#inflight.count + this.#pendingFinalizeTasks.size;
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
		return this.#sweeper?.getSweepTimer() ?? null;
	}

	/** 测试用：获取底层子进程引用。 */
	get _process() {
		return this.#processManager.process;
	}

	/** 终止进程并清理。 */
	kill() {
		this.#sweeper.clear();
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
		if (this.#processManager.draining) {
			this.#processManager.onDrained(() => this.#pumpQueue());
			return;
		}
		if (this.#inflight.count >= this.#maxInflight) return;

		const batch = [];
		while (
			batch.length < this.#batchSize &&
			!this.#pendingQueue.isEmpty() &&
			this.#inflight.count + batch.length < this.#maxInflight
		) {
			const task = this.#pendingQueue.peek();
			if (task.kind === "stream" && (batch.length > 0 || this.#inflight.count > 0)) break;
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
		this.#inflight.push(...batch);
		this.#sweeper.schedule();
		this.#processManager.write(payload);
	}

	/** sentinel token 命中后的统一处理逻辑。 */
	#afterSentinel(task) {
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
	}

	#handleStderrChunk(chunk) {
		const firstPending = this.#pendingFinalizeTasks.values().next().value;
		const inflight = this.#inflight.first;
		const task = firstPending ?? inflight;

		if (!task) {
			this.#logger?.error?.(chunk.trim());
			return;
		}

		// ── P0 根治：当所有任务都在 pendingFinalize（无 inflight）──
		// 利用 query task.rows.length 特征定位实际失败者。
		if (!inflight && firstPending) {
			let zeroRowFound = false;
			for (const t of this.#pendingFinalizeTasks) {
				if (t.kind === "query" && t.rows.length === 0) {
					t.stderrText += chunk;
					zeroRowFound = true;
				}
			}
			if (zeroRowFound) return;
		}

		// ── 安全兜底 ──
		task.stderrText += chunk;
		if (task.batchId != null) {
			for (const t of this.#pendingFinalizeTasks) {
				if (t !== task) t.stderrText += chunk;
			}
			this.#inflight.forEach((t) => {
				if (t !== task) t.stderrText += chunk;
			});
		}
	}

	#settleTask(task, error, value) {
		settleTask(task, error, value, this.#metrics);
	}

	#rejectAll(error) {
		this.#sweeper.clear();

		const all = this.#inflight.toArray();
		this.#inflight.clear();

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
