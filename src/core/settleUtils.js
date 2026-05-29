import { toError } from "./parser.js";

/**
 * 将解析后的 JSON 数组行收集到 query 任务的结果数组中。
 * @param {{ rows: any[] }} task
 * @param {any} parsed
 */
export function collectQueryRows(task, parsed) {
	if (Array.isArray(parsed)) {
		// 延迟初始化 rows 数组（query 任务在 enqueue 时已创建，此分支仅防御性保障）
		if (!task.rows) task.rows = [];
		task.rows.push(...parsed);
	}
}

/**
 * 将解析后的 JSON 数组元素通过 stream 任务的 onRow 逐行回调。
 * 若 onRow 抛错则记录到 task.consumerError 并停止后续回调。
 * @param {{ onRow: Function, consumerError?: Error | null }} task
 * @param {any} parsed
 */
export function processStreamRows(task, parsed) {
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

/**
 * 最终结算一个任务：清除定时器、更新指标，然后 resolve 或 reject。
 * @param {object} task
 * @param {Error | null} error
 * @param {any} value
 * @param {import("./metrics.js").Metrics | null | undefined} metrics
 * @param {{ resetRowParser?: boolean }} [options]
 */
export function settleTask(task, error, value, metrics, { resetRowParser = false } = {}) {
	if (task.settled) return;
	task.settled = true;

	if (resetRowParser) {
		task.rowParser?.reset?.();
	}

	if (error) {
		metrics?.incrementTasksFailed();
		task.reject(toError(error));
		return;
	}

	const duration = task.startTime > 0 ? performance.now() - task.startTime : 0;
	metrics?.incrementTasksSuccess(duration);
	task.resolve(value);
}
