/**
 * 转义 SQLite 参数
 * @param {any} value
 * @returns {string}
 */
export function escapeValue(value) {
	if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	if (typeof value === "boolean") return value.toString().toUpperCase();
	if (value instanceof Date) return `'${value.toISOString()}'`;
	throw new TypeError(`Unsupported parameter type: ${typeof value}`);
}

/**
 * 替换 SQL 语句中的 ? 为转义后的参数
 * @param {string} sql
 * @param {any[]} params
 * @returns {string}
 */
export function interpolateSQL(sql, params) {
	// Fast path: no parameters means no replacement needed
	if (params.length === 0) return sql;
	
	let i = 0;
	return sql.replace(/\?/g, () => {
		if (i >= params.length) throw new Error("Too few parameters provided");
		return escapeValue(params[i++]);
	});
}
