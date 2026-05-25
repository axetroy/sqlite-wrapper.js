import { createRowStreamParser, RowStreamParser } from "../core/parser.js";

export { createRowStreamParser };

/**
 * 根据任务配置设置流解析器。
 * 判断任务是否需要逐行解析 JSON 输出，并返回对应的 RowStreamParser 实例。
 *
 * @param task - 任务配置对象，应包含 kind、onRow、token 等字段
 * @returns 解析器实例，若无需流式解析则返回 null
 */
export function setupStreamParser(task: {
	kind: string;
	onRow?: Function;
	consumerError?: Error | null;
	valueParser?: { feed: Function };
	token?: string;
}): RowStreamParser | null;

/**
 * 异步行缓冲区，实现 AsyncIterable。
 *
 * 生产者调用 push(row) 逐行写入，消费者通过 for-await-of 逐行读取。
 * 支持背压和提前终止。
 */
export declare class AsyncRowBuffer<T = any> implements AsyncIterable<T>, AsyncIterator<T> {
	/** 推入一行数据 */
	push(row: T): void;

	/** 标记数据流结束 */
	end(): void;

	/** 向消费者抛出一个错误 */
	error(err: unknown): void;

	/** 获取下一行（AsyncIterator 接口） */
	next(): Promise<IteratorResult<T>>;

	/** 提前终止迭代器 */
	return(): Promise<IteratorResult<T>>;

	[Symbol.asyncIterator](): AsyncIterator<T>;
}
