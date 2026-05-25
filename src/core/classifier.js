const READ_ONLY_KINDS = new Set(["SELECT", "WITH", "VALUES", "EXPLAIN"]);

// LRU cache for classifySQL: keyed by normalized SQL template (before interpolation),
// so repeated queries with different params hit the cache.
const _CLASSIFY_CACHE_MAX_SIZE = 256;
const _CLASSIFY_CACHE_MAX_KEY_LEN = 4096;
const _classifyCache = new Map();

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

	// Cache lookup: keyed by original SQL (template), not interpolated.
	if (sql.length <= _CLASSIFY_CACHE_MAX_KEY_LEN) {
		const cached = _classifyCache.get(sql);
		if (cached !== undefined) {
			_classifyCache.delete(sql);
			_classifyCache.set(sql, cached);
			return cached;
		}
	}

	const trimmed = sql.trim();
	let result;
	if (trimmed.includes(";")) {
		const stmts = trimmed.split(";");
		result = "read";
		for (const stmt of stmts) {
			if (classifySingle(stmt) === "write") {
				result = "write";
				break;
			}
		}
	} else {
		result = classifySingle(trimmed);
	}

	if (sql.length <= _CLASSIFY_CACHE_MAX_KEY_LEN) {
		if (_classifyCache.size >= _CLASSIFY_CACHE_MAX_SIZE) {
			_classifyCache.delete(_classifyCache.keys().next().value);
		}
		_classifyCache.set(sql, result);
	}
	return result;
}
