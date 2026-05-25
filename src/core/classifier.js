const READ_ONLY_KINDS = new Set(["SELECT", "WITH", "VALUES", "EXPLAIN"]);

function classifySingle(stmt) {
	const trimmed = stmt.trim();
	if (trimmed.length === 0) return "write";
	const kind = trimmed.split(/\s+/)[0].toUpperCase();
	return READ_ONLY_KINDS.has(kind) ? "read" : "write";
}

/**
 * 判断一条 SQL 语句是否为只读操作。
 * 多语句（以 ; 分隔）中若包含任意写语句，整体返回 "write"。
 * @param {string} sql
 * @returns {"read" | "write"}
 */
export function classifySQL(sql) {
	if (typeof sql !== "string" || sql.trim().length === 0) return "write";

	const trimmed = sql.trim();

	if (trimmed.includes(";")) {
		const stmts = trimmed.split(";");
		for (const stmt of stmts) {
			if (classifySingle(stmt) === "write") return "write";
		}
		return "read";
	}

	return classifySingle(trimmed);
}
