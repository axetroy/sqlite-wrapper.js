/** JSON 值流式解析器的状态 */
export interface JsonValueParser {
	feed(chunk: string): void;
	reset(): void;
	buffer: string;
	start: number;
	readPos: number;
	nesting: number;
	inString: boolean;
	escaped: boolean;
}

/** 行流解析器的状态 */
export interface RowStreamParser {
	feed(chunk: string): string;
	reset(): void;
	buffer: string;
	started: boolean;
	finished: boolean;
	inString: boolean;
	escaped: boolean;
	elementStart: number;
	elementEnd: number;
	nesting: number;
	readPos: number;
}

/**
 * 将任意值转为 Error 对象。
 * 如果值已经是 Error 则直接返回，否则包装为 Error。
 *
 * @param value - 可能为 Error、string 或其他类型的值
 * @returns Error 实例
 */
export function toError(value: unknown): Error;

/**
 * 创建一个 JSON 值流式解析器。
 * 从 JSON 数组的块式输入中逐个提取完整值，通过回调通知。
 * 适用于 parse 完整的 JSON 结果。
 *
 * @param onValue - 每次解析出一个完整值时的回调
 * @returns 解析器实例
 */
export function createJsonValueParser(onValue: (raw: string) => void): JsonValueParser;

/**
 * 创建一个行流解析器。
 * 从 JSON 数组的块式输入中逐行提取原始字符串，通过回调通知。
 * 适用于流式逐行处理结果而不缓存全部数据。
 *
 * @param onRow - 每解析出一行时的回调
 * @returns 解析器实例
 */
export function createRowStreamParser(onRow: (rawRow: string) => void): RowStreamParser;
