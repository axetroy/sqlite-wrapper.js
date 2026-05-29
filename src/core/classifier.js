import { LRUCache } from "./lruCache.js";

const READ_ONLY_KINDS = new Set(["SELECT", "WITH", "VALUES", "EXPLAIN"]);

// LRU cache for classifySQL: keyed by normalized SQL template (before interpolation),
// so repeated queries with different params hit the cache.
const _classifyCache = new LRUCache({ maxSize: 256, maxKeyLength: 4096 });

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
	if (typeof sql !== "string") return "write";

	const cached = _classifyCache.get(sql);
	if (cached !== undefined) return cached;

	// sql 已经过 normalizeSQL 去除首尾空白，但保留 trim() 防御直接调用
	const trimmed = sql.trim();
	if (trimmed.length === 0) return "write";
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

	_classifyCache.set(sql, result);
	return result;
}
