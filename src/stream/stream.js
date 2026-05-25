import { createRowStreamParser } from "../core/parser.js";
import { toError } from "../core/parser.js";
import { TOKEN_COLUMN } from "../core/protocol.js";

export { createRowStreamParser };

/**
 * 为 stream 类型的任务设置行级流解析器。
 * 如果任务类型不是 "stream" 则返回 null。
 *
 * 解析器内部逐行解析 JSON 数组元素，每解析出一行就调用 task.onRow()。
 * 如果 onRow 抛异常，会将错误记录到 task.consumerError。
 *
 * sqlite3 `-json` 模式下空结果集不输出 `[]`，
 * 此时行解析器可能错误地消费 sentinel 数组（而非数据数组）。
 * 回调中检测 sentinel 行并回喂给 valueParser 以确保 sentinel 被识别。
 *
 * @param {{ kind: string, onRow?: Function, consumerError?: Error | null, token?: string }} task
 * @param {{ feed: Function }} valueParser - 共享 JSON 值解析器，用于回喂 sentinel 行
 * @returns {ReturnType<typeof createRowStreamParser> | null}
 */
export function setupStreamParser(task, valueParser = { feed() {} }) {
	if (task.kind !== "stream") return null;
	const parser = createRowStreamParser((rawRow) => {
		if (task.consumerError) return;
		try {
			const row = JSON.parse(rawRow);
			// sqlite3 空结果不输出 []，导致 sentinel 被行解析器消费。
			// 若该行包含 TOKEN_COLUMN，回喂给 valueParser 做正式 sentinel 检测。
			if (typeof row === "object" && row !== null && TOKEN_COLUMN in row) {
				valueParser.feed(`[${rawRow}]`);
				return;
			}
			task.onRow(row);
		} catch (error) {
			task.consumerError = toError(error);
		}
	});
	return parser;
}

/**
 * 将回调驱动的行流桥接到 Async Iterator 协议。
 *
 * stream 使用 onRow 回调消费行数据，
 * 而 stream() 方法返回 AsyncIterable 供 for await 使用。
 * AsyncRowBuffer 在两者之间充当适配器：
 *  - push(row) 由 onRow 回调调用
 *  - end() 由任务完成时调用
 *  - error(err) 由任务失败时调用
 *  - next() / [Symbol.asyncIterator]() 供消费者使用
 */
export class AsyncRowBuffer {
	#buffer = [];
	#done = false;
	#error = null;
	#pending = null;

	/** 生产者侧：添加一行数据 */
	push(row) {
		if (this.#pending) {
			const resolve = this.#pending.resolve;
			this.#pending = null;
			resolve({ value: row, done: false });
		} else {
			this.#buffer.push(row);
		}
	}

	/** 生产者侧：标记数据流结束 */
	end() {
		this.#done = true;
		if (this.#pending) {
			const resolve = this.#pending.resolve;
			this.#pending = null;
			resolve({ value: undefined, done: true });
		}
	}

	/** 生产者侧：标记数据流出错 */
	error(err) {
		this.#error = err;
		if (this.#pending) {
			const reject = this.#pending.reject;
			this.#pending = null;
			reject(err);
		}
	}

	/** AsyncIterator 协议：获取下一行 */
	next() {
		if (this.#buffer.length > 0) {
			return Promise.resolve({ value: this.#buffer.shift(), done: false });
		}
		if (this.#done) {
			return Promise.resolve({ value: undefined, done: true });
		}
		if (this.#error) {
			return Promise.reject(this.#error);
		}
		return new Promise((resolve, reject) => {
			this.#pending = { resolve, reject };
		});
	}

	/** for await 提前 break / return 时清理 */
	return() {
		this.#done = true;
		if (this.#pending) {
			const resolve = this.#pending.resolve;
			this.#pending = null;
			resolve({ value: undefined, done: true });
		}
		return Promise.resolve({ value: undefined, done: true });
	}

	[Symbol.asyncIterator]() {
		return this;
	}
}
