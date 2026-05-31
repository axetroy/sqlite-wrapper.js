import { settleTask, collectQueryRows, processStreamRows } from "./settleUtils.js";
import { isSentinelRaw, isSentinelRow, buildBatchPayload } from "./protocol.js";
import { toError } from "./parser.js";
import { createTimeoutError } from "../utils/timeout.js";

/**
 * 批量结算 pendingFinalize 集合中的所有任务。
 * 由 scheduleFinalizeCheck 的 setImmediate 回调调用。
 *
 * @param {Set<object>} tasks - pendingFinalizeTasks 集合
 * @param {(task: object, error: Error | null, value: any) => void} settle
 * @param {() => void} pumpQueue
 */
export function finalizePendingTasks(tasks, settle, pumpQueue) {
	for (const task of tasks) {
		if (task.stderrText) {
			settle(task, new Error(task.stderrText.trim()), undefined);
			continue;
		}

		if (task.consumerError) {
			settle(task, task.consumerError, undefined);
			continue;
		}

		if (task.kind === "query") {
			settle(task, null, task.rows);
			continue;
		}

		settle(task, null, undefined);
	}
	tasks.clear();
	pumpQueue();
}

/**
 * 处理单任务超时：防重复结算、清除定时器、更新指标、创建超时错误。
 *
 * @param {object} task
 * @param {import("./metrics.js").Metrics | null | undefined} metrics
 * @returns {Error | null} 已创建的 TimeoutError，若任务已结算则返回 null
 */
export function prepareTaskTimeout(task, metrics) {
	if (task.settled) return null;
	task.timedout = true;
	metrics?.incrementTasksTimeout();
	return createTimeoutError(task.timeout, task.sql);
}

/**
 * 创建 sweep 定时器管理器。
 * schedule() 启动定期扫描，检查 inflight 任务是否超时；
 * clear() 停止定时器。
 *
 * @param {{
 *   inflight: import("./inflightTracker.js").InflightTracker,
 *   sweepIntervalMs: number,
 *   handleTaskTimeout: (task: object) => void,
 * }} params
 * @returns {{ schedule: () => void, clear: () => void, getSweepTimer: () => (number | null) }}
 */
export function createSweeper({ inflight, sweepIntervalMs, handleTaskTimeout }) {
	let sweepTimer = null;
	const schedule = () => {
		if (sweepTimer) return;
		sweepTimer = setTimeout(() => {
			sweepTimer = null;
			const now = performance.now();
			inflight.forEach((task) => {
				if (now - task.startTime > task.timeout) {
					handleTaskTimeout(task);
				}
			});
			if (inflight.count > 0) {
				schedule();
			}
		}, sweepIntervalMs).unref();
	};
	const clear = () => {
		clearTimeout(sweepTimer);
		sweepTimer = null;
	};
	return { schedule, clear, getSweepTimer: () => sweepTimer };
}

/**
 * 创建 pendingFinalize 结算调度器。
 * 通过 setImmediate 延迟一帧执行 finalizePendingTasks，给 stderr chunk 到达的时间窗口。
 *
 * @param {{
 *   pendingFinalizeTasks: Set<object>,
 *   settleTask: (task: object, error: Error | null, value: any) => void,
 *   pumpQueue: () => void,
 * }} params
 * @returns {() => void}
 */
export function createFinalizeScheduler({ pendingFinalizeTasks, settleTask: settle, pumpQueue }) {
	let scheduled = false;
	return () => {
		if (scheduled) return;
		scheduled = true;
		setImmediate(() => {
			scheduled = false;
			finalizePendingTasks(pendingFinalizeTasks, settle, pumpQueue);
		});
	};
}

/**
 * 处理一个完整的 JSON 值（来自 sharedValueParser）。
 * 匹配 sentinel token、收集 query 行数据、触发 stream 回调。
 * PipelineEngine 和 TaskWorker 共享此逻辑。
 *
 * @param {string} raw - 原始 JSON 文本
 * @param {import("./inflightTracker.js").InflightTracker} inflight
 * @param {{
 *   afterSentinel: (task: object) => void,
 *   rejectAll: (error: Error) => void,
 * }} callbacks
 */
export function handleParsedValue(raw, inflight, { afterSentinel, rejectAll }) {
	const task = inflight.first;
	if (!task) return;

	// Fast path: 原始字符串精确匹配 sentinel，跳过 JSON.parse
	if (isSentinelRaw(raw, task.token)) {
		inflight.shift();
		afterSentinel(task);
		return;
	}

	// Fast path: 空数组 []，execute 的零行结果，跳过 JSON.parse
	if (raw === "[]") return;

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		rejectAll(new Error(`Invalid JSON from sqlite3: ${toError(error).message}`));
		return;
	}

	if (isSentinelRow(parsed, task.token)) {
		inflight.shift();
		afterSentinel(task);
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
 * 创建一个泵送（pump）函数，将队列中的任务批量发送给 sqlite3 进程。
 *
 * PipelineEngine 和 TaskWorker 共享此工厂，消除 #pumpQueue 方法的重复。
 * 调用方可通过 active 守卫（可选）控制是否允许泵送。
 *
 * @param {{
 *   queue: import("./queue.js").Queue,
 *   inflight: import("./inflightTracker.js").InflightTracker,
 *   processManager: { draining: boolean, write: (data: string) => void, onDrained: (cb: () => void) => void },
 *   sweeper: { schedule: () => void },
 *   batchSize: number,
 *   maxInflight: number,
 * }} params
 * @returns {() => void} 泵送函数，调用后尝试从队列取出 batch 发送
 */
export function createPumpQueue({ queue, inflight, processManager, sweeper, batchSize, maxInflight }) {
	let nextBatchId = 1;
	return function pump() {
		if (processManager.draining) {
			processManager.onDrained(() => pump());
			return;
		}
		if (inflight.count >= maxInflight) return;

		const batch = [];
		while (batch.length < batchSize && !queue.isEmpty() && inflight.count + batch.length < maxInflight) {
			const task = queue.peek();
			if (task.kind === "stream" && (batch.length > 0 || inflight.count > 0)) break;
			queue.dequeue();
			batch.push(task);
		}
		if (batch.length === 0) return;

		const now = performance.now();
		const payload = buildBatchPayload(batch);
		const batchId = nextBatchId++;
		const useWalBatch = payload.startsWith("BEGIN;");

		for (const task of batch) {
			task.startTime = now;
			task.batchId = batchId;
			task.walBatch = useWalBatch;
		}
		inflight.push(...batch);
		sweeper.schedule();
		processManager.write(payload);
	};
}

/**
 * 处理 sentinel token 命中后的任务结算。
 *
 * 此函数提取自 PipelineEngine.#afterSentinel 和 TaskWorker.#afterSentinel，
 * 消除二者间的逻辑重复。统一使用延迟结算策略：
 * - timedout 任务直接跳过（不结算，数据已丢弃）
 * - consumerError 任务立即 reject（用户主动错误无需等待）
 * - 其他任务进入 pendingFinalize 延迟一帧，给 stderr chunk 留到达时间
 *
 * @param {object} task - 已从 inflight shift 的任务
 * @param {{
 *   settleTask: (task: object, error: Error | null, value: any) => void,
 *   pendingFinalizeTasks: Set<object>,
 *   scheduleFinalizeCheck: () => void,
 *   pumpQueue: () => void,
 * }} params
 */
export function handleSentinelTask(task, { settleTask, pendingFinalizeTasks, scheduleFinalizeCheck, pumpQueue }) {
	if (task.timedout) {
		pumpQueue();
		return;
	}

	if (task.consumerError) {
		settleTask(task, task.consumerError, undefined);
		pumpQueue();
		return;
	}

	// 无论 stderrText 是否为空，都走 pendingFinalize 延迟结算。
	// 原因：Windows 上 sqlite3 的 stderr 输出可能被 OS pipe 拆分为多个 chunk，
	// 若在此处立即 reject，后续到达的 stderr chunk 会丢失或被错误地配给下一个 inflight 任务。
	pendingFinalizeTasks.add(task);
	scheduleFinalizeCheck();
	pumpQueue();
}

/**
 * 处理 sqlite3 的 stderr 输出，将其归因到合适的任务。
 *
 * 提取自 PipelineEngine.handleStderrChunk 和 TaskWorker.#handleStderrChunk，
 * 统一采用 PipelineEngine 的精细归因策略：
 *   1. 零行归因 — pendingFinalize 中 rows.length === 0 的 query 极可能是失败源
 *   2. WAL batch — 整个事务回滚，传播到 batch 内所有任务
 *   3. 非 WAL batch — 传播到 pendingFinalize 中其他任务 + 第一个 inflight 任务
 *      （不传播到后续 inflight 任务，避免 macOS 上因 pipe 时序导致成功查询被误杀）
 *
 * @param {string} chunk - stderr 文本块
 * @param {{
 *   inflight: import("./inflightTracker.js").InflightTracker,
 *   pendingFinalizeTasks: Set<object>,
 *   logger?: { error?: (msg: string) => void },
 * }} params
 */
export function handleStderrChunk(chunk, { inflight, pendingFinalizeTasks, logger }) {
	const firstPending = pendingFinalizeTasks.values().next().value;
	const inflightFirst = inflight.first;
	const task = firstPending ?? inflightFirst;

	if (!task) {
		logger?.error?.(chunk.trim());
		return;
	}

	// ── 零行归因（不受 inflight 有无影响）──
	// sqlite3 对失败的 SQL 不输出任何 stdout 数据行，只有 stderr。
	// 因此 pendingFinalize 中 rows.length === 0 的 query 极可能失败源。
	// 仅归因给这些任务，不传播到其他成功任务。
	for (const t of pendingFinalizeTasks) {
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
		for (const t of pendingFinalizeTasks) {
			if (t !== task) t.stderrText += chunk;
		}
		inflight.forEach((t) => {
			if (t !== task) t.stderrText += chunk;
		});
		return;
	}

	// 非 WAL batch：传播到其他 pendingFinalize 任务（保守，execute 无零行可判断）
	for (const t of pendingFinalizeTasks) {
		if (t !== task) t.stderrText += chunk;
	}

	// 仅传播到第一个 inflight 任务（sqlite3 当前正在处理的语句最可能是失败者）
	// 避免传播到后续所有 inflight 任务，防止 macOS 上因 stderr pipe 提前到达
	// 而误杀本应成功的查询。
	if (inflightFirst && inflightFirst !== task) {
		inflightFirst.stderrText += chunk;
	}
}

/**
 * 拒绝所有待处理任务（inflight、队列、pendingFinalize）。
 *
 * 提取自 PipelineEngine.rejectAll 和 TaskWorker.#rejectAll，
 * 消除二者间的逻辑重复。调用方负责清理各自特有的资源
 * （如 sharedValueParser.reset() 或 sweeper.clear()）。
 *
 * @param {{
 *   inflight: import("./inflightTracker.js").InflightTracker,
 *   queue: import("./queue.js").Queue,
 *   pendingFinalizeTasks: Set<object>,
 *   settleTask: (task: object, error: Error | null, value: any) => void,
 *   error: Error,
 * }} params
 */
export function rejectAllTasks({ inflight, queue, pendingFinalizeTasks, settleTask, error }) {
	// 1. 取走并清空 inflight
	const all = inflight.toArray();
	inflight.clear();

	// 2. 结算队列中的任务（尚未发送）
	let queued = queue.dequeue();
	while (queued) {
		settleTask(queued, error, undefined);
		queued = queue.dequeue();
	}

	// 3. 结算 inflight 任务（正在执行）
	for (const task of all) {
		settleTask(task, error, undefined);
	}

	// 4. 结算 pendingFinalize 任务（等待延迟结算）
	for (const task of pendingFinalizeTasks) {
		settleTask(task, error, undefined);
	}
	pendingFinalizeTasks.clear();
}
