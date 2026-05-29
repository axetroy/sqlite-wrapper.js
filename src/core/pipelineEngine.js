import { Queue } from "./queue.js";
import { createJsonValueParser, toError } from "./parser.js";
import { isSentinelRaw, isSentinelRow, buildBatchPayload } from "./protocol.js";
import { collectQueryRows, processStreamRows, settleTask } from "./settleUtils.js";
import { finalizePendingTasks, prepareTaskTimeout } from "./pipelineUtils.js";
import { DEFAULT_BATCH_SIZE, DEFAULT_MAX_INFLIGHT } from "../constants.js";

/**
 * 管线化执行引擎。
 *
 * 维护任务队列、管理 inflight 任务、处理 stdout/stderr 解析、
 * 实现 sentinel token 协议和 stderr 竞态处理。
 *
 * PipelineEngine 不关心事务作用域、读写分离或进程恢复 ——
 * 这些由上层（SQLiteExecutor）负责。
 */
export class PipelineEngine {
	#queue = new Queue();
	#inflightTasks = [];
	#pendingFinalizeTasks = new Set();
	#scheduledFinalize = false;
	#sharedValueParser;
	#processManager;
	#metrics;
	#statementTimeout;
	#logger;
	#batchSize;
	#maxInflight;
	#onTaskTimeout;
	#active = false;
	#sweepTimer = null;
	#sweepIntervalMs;

	/**
	 * @param {import("./process.js").ProcessManager} processManager
	 * @param {{
	 *   metrics: import("./metrics.js").Metrics,
	 *   statementTimeout: number,
	 *   logger?: import("../index.js").Logger,
	 *   batchSize?: number,
	 *   onTaskTimeout?: (task: object) => void,
	 * }} options
	 */
	constructor(processManager, { metrics, statementTimeout, logger, batchSize = DEFAULT_BATCH_SIZE, maxInflight = DEFAULT_MAX_INFLIGHT, onTaskTimeout, sweepInterval = 100 }) {
		this.#processManager = processManager;
		this.#metrics = metrics;
		this.#statementTimeout = statementTimeout;
		this.#logger = logger;
		this.#batchSize = batchSize;
		this.#maxInflight = maxInflight;
		this.#onTaskTimeout = onTaskTimeout ?? (() => {});
		this.#sharedValueParser = createJsonValueParser((raw) => this.#handleParsedValue(raw));
		this.#processManager.setOnDrainCallback(() => this.#pumpQueue());
		this.#sweepIntervalMs = sweepInterval;
	}

	/** 测试用：获取扫制定时器引用。 */
	get _sweepTimer() {
		return this.#sweepTimer;
	}

	/** 主任务队列（供事务延迟任务恢复使用）。 */
	get mainQueue() {
		return this.#queue;
	}

	/** 主动触发一次队列发送。 */
	pump() {
		this.#pumpQueue();
	}

	/** 当前待处理的任务总数（队列中 + 执行中 + pendingFinalize）。 */
	get pendingStatements() {
		return this.#queue.size + this.#inflightTasks.length + this.#pendingFinalizeTasks.size;
	}

	/**
	 * 将数据送入 sharedValueParser 解析（供 stream 的 rowParser 回喂数据使用）。
	 * @param {string} raw
	 */
	feed(raw) {
		this.#sharedValueParser.feed(raw);
	}

	/** 标记引擎可用，允许发送任务。 */
	activate() {
		this.#sharedValueParser?.reset();
		this.#active = true;
	}

	/** 标记引擎不可用，阻止发送新任务。 */
	deactivate() {
		this.#active = false;
	}

	/**
	 * 入队一个任务。
	 * 任务对象应包含：kind, sql, timeout, token, onRow, rows, resolve, reject,
	 * consumerError, stderrText, timer, startTime, rowParser。
	 * @param {object} task
	 */
	enqueue(task) {
		this.#queue.enqueue(task);
		this.#pumpQueue();
	}

	/**
	 * 从队列批量取出任务发送给 sqlite3 进程。
	 * 非 stream 任务最多批量发送 DEFAULT_BATCH_SIZE 个；
	 * stream 任务独占发送（队列中有 stream 时不会与其他任务打包）。
	 */
	#pumpQueue() {
		if (!this.#active) return;
		if (this.#processManager.draining) return;
		if (this.#inflightTasks.length >= this.#maxInflight) return;

		const batch = [];
		while (
			batch.length < this.#batchSize &&
			!this.#queue.isEmpty() &&
			this.#inflightTasks.length + batch.length < this.#maxInflight
		) {
			const task = this.#queue.peek();
			if (task.kind === "stream" && (batch.length > 0 || this.#inflightTasks.length > 0)) break;
			this.#queue.dequeue();
			batch.push(task);
		}
		if (batch.length === 0) return;

		const now = performance.now();

		const payload = buildBatchPayload(batch);

		for (const task of batch) {
			task.startTime = now;
		}
		this.#inflightTasks.push(...batch);
		this.#scheduleSweep();
		this.#processManager.write(payload);
	}

	/**
	 * 处理 sqlite3 的 stdout 输出。
	 * 对于 stream 类型任务，先通过行流解析器逐行处理，剩余数据转给 JSON 值解析器。
	 * @param {string} chunk
	 */
	handleStdoutChunk(chunk) {
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

		// Fast path: 原始字符串精确匹配 sentinel，跳过 JSON.parse
		if (isSentinelRaw(raw, task.token)) {
			this.#inflightTasks.shift();

			if (task.timedout) {
				this.#pumpQueue();
				return;
			}

			// 无论 stderrText 是否为空，都走 pendingFinalize 延迟结算。
			// 原因：Windows 上 sqlite3 的 stderr 输出可能被 OS pipe 拆分为多个 chunk，
			// 若在此处立即 reject，后续到达的 stderr chunk 会丢失或被错误地配给下一个 inflight 任务。
			// 通过 pendingFinalize + setImmediate 给 stderr chunk 留足时间到达。
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

		// Fast path: 空数组 []，execute 的零行结果，跳过 JSON.parse
		if (raw === "[]") return;

		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			this.rejectAll(new Error(`Invalid JSON from sqlite3: ${toError(error).message}`));
			return;
		}

		if (isSentinelRow(parsed, task.token)) {
			this.#inflightTasks.shift();

			if (task.timedout) {
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

		if (task.timedout) {
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
	 * 处理 sqlite3 的 stderr 输出。
	 * 将错误文本附加到 inflight 任务或 pendingFinalize 任务；
	 * 如果没有匹配任务则通过 logger 输出。
	 * @param {string} chunk
	 */
	handleStderrChunk(chunk) {
		// 优先匹配 pendingFinalize 任务，确保延迟到达的 stderr chunk
		// 被正确归因到原始任务，而非下一个 inflight 任务。
		const task = this.#pendingFinalizeTasks.values().next().value ?? this.#inflightTasks[0];
		if (!task) {
			this.#logger?.error?.(String(chunk).trim());
			return;
		}
		task.stderrText += String(chunk);
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

	#scheduleSweep() {
		if (this.#sweepTimer) return;
		this.#sweepTimer = setTimeout(() => {
			this.#sweepTimer = null;
			const inflight = this.#inflightTasks;
			const now = performance.now();
			for (let i = 0; i < inflight.length; i++) {
				const task = inflight[i];
				if (now - task.startTime > task.timeout) {
					this.#handleTaskTimeout(task);
				}
			}
			if (this.#inflightTasks.length > 0) {
				this.#scheduleSweep();
			}
		}, this.#sweepIntervalMs).unref();
	}

	#handleTaskTimeout(task) {
		const error = prepareTaskTimeout(task, this.#metrics);
		if (error) {
			this.#settleTask(task, error, undefined);
			this.#onTaskTimeout?.(task);
		}
	}


	#settleTask(task, error, value) {
		settleTask(task, error, value, this.#metrics, { resetRowParser: true });
	}

	/**
	 * 拒绝 inflight 任务以及队列中的所有待处理任务。
	 * 不清除 deferred 队列（由上层负责）。
	 * @param {Error} error
	 */
	rejectAll(error) {
		const all = this.#inflightTasks;
		this.#inflightTasks = [];

		for (const task of all) {
			this.#settleTask(task, error, undefined);
		}

		let queued = this.#queue.dequeue();
		while (queued) {
			this.#settleTask(queued, error, undefined);
			queued = this.#queue.dequeue();
		}

		for (const task of this.#pendingFinalizeTasks) {
			this.#settleTask(task, error, undefined);
		}
		this.#pendingFinalizeTasks.clear();
	}

	/**
	 * 终止引擎：拒绝所有任务，清空状态。
	 */
	kill() {
		this.#active = false;
		clearTimeout(this.#sweepTimer);
		this.#sweepTimer = null;
		this.rejectAll(new Error("PipelineEngine is killed"));
	}
}
