import { settleTask } from "./settleUtils.js";
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
	clearTimeout(task.timer);
	task.timer = null;
	metrics?.incrementTasksTimeout();
	return createTimeoutError(task.timeout, task.sql);
}
