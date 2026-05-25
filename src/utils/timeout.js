import { normalizeSQL } from "../utils.js";

/** 默认 SQL 超时时间（毫秒） */
export const DEFAULT_STATEMENT_TIMEOUT = 30_000;

/**
 * 创建一个描述 SQL 超时的 Error 对象。
 * @param {number} timeout - 超时毫秒数
 * @param {string} sql - 超时的 SQL 语句
 * @returns {Error}
 */
export function createTimeoutError(timeout, sql) {
	return new Error(`SQLite statement timed out after ${timeout}ms: ${normalizeSQL(sql)}`);
}
