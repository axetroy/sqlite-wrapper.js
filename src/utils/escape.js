/**
 * 转义 SQLite 参数值为安全字符串。
 * 字符串中的单引号会被双写（''）转义；
 * null/undefined 转 "NULL"；boolean 转 "TRUE"/"FALSE"；
 * Date 转 ISO 字符串带引号；数字/bigint 直转字符串。
 * @param {any} value - 要转义的值
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
