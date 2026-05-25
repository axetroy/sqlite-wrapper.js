import { normalizeSQL } from "../utils.js";
import { TOKEN_COLUMN } from "../constants.js";

export { TOKEN_COLUMN } from "../constants.js";

/**
 * 构建发送给 sqlite3 进程的完整载荷。
 * 在原始 SQL 末尾追加一条 sentinel 查询，用于标记该任务输出的结束。
 *
 * @param {string} sql - 要执行的 SQL 语句
 * @param {string} token - 唯一 sentinel token
 * @returns {string} 追加了 sentinel 查询后的完整载荷
 */
export function buildPayload(sql, token) {
	const normalized = normalizeSQL(sql);
	const suffix = normalized.endsWith(";") ? "" : ";";
	return `${normalized}${suffix}\nSELECT '${token}' AS ${TOKEN_COLUMN};\n`;
}

/**
 * 检查解析出的 JSON 行是否为当前任务的 sentinel 结束标记行。
 *
 * @param {unknown} value - 已解析的 JSON 值
 * @param {string} token - 当前任务的唯一 token
 * @returns {boolean}
 */
export function isSentinelRow(value, token) {
	return Array.isArray(value) && value.length === 1 && value[0]?.[TOKEN_COLUMN] === token;
}
