import { Queue } from "./queue.js";
import { InflightTracker } from "./inflightTracker.js";
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
	#inflight = new InflightTracker();
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
	/** @type {number} */
	#nextBatchId = 1;

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
	constructor(
		processManager,
		{
			metrics,
			statementTimeout,
			logger,
			batchSize = DEFAULT_BATCH_SIZE,
			maxInflight = DEFAULT_MAX_INFLIGHT,
			onTaskTimeout,
			sweepInterval = 100,
		},
	) {
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
		return this.#queue.size + this.#inflight.count + this.#pendingFinalizeTasks.size;
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
		if (this.#processManager.draining) {
			this.#processManager.onDrained(() => this.#pumpQueue());
			return;
		}
		if (this.#inflight.count >= this.#maxInflight) return;

		const batch = [];
		while (batch.length < this.#batchSize && !this.#queue.isEmpty() && this.#inflight.count + batch.length < this.#maxInflight) {
			const task = this.#queue.peek();
			if (task.kind === "stream" && (batch.length > 0 || this.#inflight.count > 0)) break;
			this.#queue.dequeue();
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
		this.#scheduleSweep();
		this.#processManager.write(payload);
	}

	/**
	 * 处理 sqlite3 的 stdout 输出。
	 * 对于 stream 类型任务，先通过行流解析器逐行处理，剩余数据转给 JSON 值解析器。
	 * @param {string} chunk
	 */
	handleStdoutChunk(chunk) {
		const task = this.#inflight.first;
		if (!task) return;

		// 已超时的 stream 任务：禁止继续喂给 rowParser（rowParser.reset 后 finished=false，
		// 否则会触发 spurious onRow 回调）。数据直接走 sharedValueParser 由
		// #handleParsedValue 中的 task.timedout 短路丢弃。
		if (task.kind === "stream" && task.rowParser && !task.rowParser.finished && !task.timedout) {
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
		const task = this.#inflight.first;
		if (!task) return;

		// Fast path: 原始字符串精确匹配 sentinel，跳过 JSON.parse
		if (isSentinelRaw(raw, task.token)) {
			this.#inflight.shift();
			this.#afterSentinel(task);
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
			this.#inflight.shift();
			this.#afterSentinel(task);
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
	 * sentinel token 命中后的统一处理逻辑。
	 * 将任务放入 pendingFinalize，延迟一帧结算以等待可能的 stderr。
	 */
	#afterSentinel(task) {
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
	}

	/**
	 * 处理 sqlite3 的 stderr 输出。
	 * 将错误文本附加到 inflight 任务或 pendingFinalize 任务；
	 * 如果没有匹配任务则通过 logger 输出。
	 *
	 * P0 修复：stderr 无法唯一定位到具体任务（stdout/stderr 独立管道，
	 * OS 调度顺序不确定）。保守策略：宁可误报不可漏报。
	 *
	 * 归因策略（由优到劣）：
	 *   1. 零行归因 — pendingFinalize 中 rows.length === 0 的 query 极可能是失败源
	 *   2. WAL batch — 整个事务回滚，传播到 batch 内所有任务
	 *   3. 非 WAL batch — 传播到 pendingFinalize 中其他任务 + 第一个 inflight 任务
	 *      （不传播到后续 inflight 任务，避免 macOS 上因 pipe 时序导致成功查询被误杀）
	 *
	 * @param {string} chunk
	 */
	handleStderrChunk(chunk) {
		const firstPending = this.#pendingFinalizeTasks.values().next().value;
		const inflight = this.#inflight.first;
		const task = firstPending ?? inflight;

		if (!task) {
			this.#logger?.error?.(chunk.trim());
			return;
		}

		// ── 零行归因（不受 inflight 有无影响）──
		// sqlite3 对失败的 SQL 不输出任何 stdout 数据行，只有 stderr。
		// 因此 pendingFinalize 中 rows.length === 0 的 query 极可能失败源。
		// 仅归因给这些任务，不传播到其他成功任务。
		for (const t of this.#pendingFinalizeTasks) {
			if (t.kind === "query" && t.rows.length === 0) {
				t.stderrText += chunk;
				return;
			}
		}

		// ── 安全兜底 ──
		task.stderrText += chunk;
		if (task.batchId == null) return;

		// WAL batch：整个事务回滚，batch 内所有任务全部受影响
		if (task.walBatch) {
			for (const t of this.#pendingFinalizeTasks) {
				if (t !== task) t.stderrText += chunk;
			}
			this.#inflight.forEach((t) => {
				if (t !== task) t.stderrText += chunk;
			});
			return;
		}

		// 非 WAL batch：传播到其他 pendingFinalize 任务（保守，execute 无零行可判断）
		for (const t of this.#pendingFinalizeTasks) {
			if (t !== task) t.stderrText += chunk;
		}
		// 仅传播到第一个 inflight 任务（sqlite3 当前正在处理的语句最可能是失败者）
		// 避免传播到后续所有 inflight 任务，防止 macOS 上因 stderr pipe 提前到达
		// 而误杀本应成功的查询。
		if (inflight && inflight !== task) {
			inflight.stderrText += chunk;
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
			finalizePendingTasks(
				this.#pendingFinalizeTasks,
				(t, e, v) => this.#settleTask(t, e, v),
				() => this.#pumpQueue(),
			);
		});
	}

	#scheduleSweep() {
		if (this.#sweepTimer) return;
		this.#sweepTimer = setTimeout(() => {
			this.#sweepTimer = null;
			const now = performance.now();
			this.#inflight.forEach((task) => {
				if (now - task.startTime > task.timeout) {
					this.#handleTaskTimeout(task);
				}
			});
			if (this.#inflight.count > 0) {
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
		this.#sharedValueParser.reset();

		const all = this.#inflight.toArray();
		this.#inflight.clear();

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
