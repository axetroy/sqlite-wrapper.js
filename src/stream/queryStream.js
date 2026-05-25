import { createRowStreamParser } from "../core/parser.js";
import { toError } from "../core/parser.js";

export { createRowStreamParser };

/**
 * 为 stream 类型的任务设置行级流解析器。
 * 如果任务类型不是 "stream" 则返回 null。
 *
 * 解析器内部逐行解析 JSON 数组元素，每解析出一行就调用 task.onRow()。
 * 如果 onRow 抛异常，会将错误记录到 task.consumerError。
 *
 * @param {{ kind: string, onRow?: Function, consumerError?: Error | null }} task
 * @returns {ReturnType<typeof createRowStreamParser> | null}
 */
export function setupStreamParser(task) {
	if (task.kind !== "stream") return null;
	const parser = createRowStreamParser((rawRow) => {
		if (task.consumerError) return;
		try {
			task.onRow(JSON.parse(rawRow));
		} catch (error) {
			task.consumerError = toError(error);
		}
	});
	return parser;
}
