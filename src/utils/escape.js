/**
 * 转义 SQLite 参数
 * @param {any} value
 * @returns {string}
 */
export function escapeValue(value) {
	if (typeof value === "string") {
		// 绝大多数字符串不含单引号，先检查再 replace 避免无意义的分配
		return value.includes("'") ? `'${value.replace(/'/g, "''")}'` : `'${value}'`;
	}
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (value instanceof Date) return `'${value.toISOString()}'`;
	throw new TypeError(`Unsupported parameter type: ${typeof value}`);
}
