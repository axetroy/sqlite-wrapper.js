import { AsyncRowBuffer } from "../stream/stream.js";

/** SQLite 支持的三种事务模式 */
export const VALID_TRANSACTION_MODES = ["DEFERRED", "IMMEDIATE", "EXCLUSIVE"];

/**
 * 判断给定的值是否为有效的事务模式。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTransactionMode(value) {
	return VALID_TRANSACTION_MODES.includes(value);
}

/**
 * 创建一个事务操作句柄。
 * 该句柄的 execute/query/stream 方法会自动携带 scopeId，
 * 使得事务内的所有操作被标记为属于同一事务域。
 *
 * @param {symbol} scopeId - 事务域标识
 * @param {{ enqueue(kind: string, sql: string, params: any[], options: object, scopeId: symbol | null): Promise<any> }} executor
 * @returns {{ execute: Function, query: Function, stream: Function }}
 */
export function createTransactionHandle(scopeId, executor) {
	const handle = {
		execute: (sql, params = [], options = {}) => executor.enqueue("execute", sql, params, options, scopeId),
		query: (sql, params = [], options = {}) => executor.enqueue("query", sql, params, options, scopeId),
		stream: (sql, params = [], options = {}) => {
			if (!Array.isArray(params)) throw new TypeError("params must be an array");
			const buffer = new AsyncRowBuffer();
			executor.enqueue("stream", sql, params, { ...options, onRow: (row) => buffer.push(row) }, scopeId)
				.then(() => buffer.end(), (err) => buffer.error(err));
			return buffer;
		},
	};
	return handle;
}
