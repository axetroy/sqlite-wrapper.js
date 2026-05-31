import { settleTask, collectQueryRows, processStreamRows } from "./settleUtils.js";
import { isSentinelRaw, isSentinelRow } from "./protocol.js";
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
