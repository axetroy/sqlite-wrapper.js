import { LRUCache } from "../core/lruCache.js";
import { escapeValue } from "./escape.js";
import {
	CC_SINGLE_QUOTE,
	CC_DOUBLE_QUOTE,
	CC_DASH,
	CC_SLASH,
	CC_STAR,
	CC_NEWLINE,
	CC_QUESTION,
	STATE_NORMAL,
	STATE_SINGLE_QUOTE,
	STATE_DOUBLE_QUOTE,
	STATE_LINE_COMMENT,
	STATE_BLOCK_COMMENT,
} from "./constants.js";

/** @type {LRUCache<{ segments: string[], paramCount: number }>} */
const _interpCache = new LRUCache({ maxSize: 256, maxKeyLength: 4096 });

/**
 * 将 SQL 模板解析为以 `?` 分隔的文本段。
 * @param {string} sql
 * @returns {{ segments: string[], paramCount: number }}
 */
function _parseTemplate(sql) {
	const segments = [];
	let segStart = 0;
	let state = STATE_NORMAL;
	let stateStartPos = -1;

	for (let pos = 0; pos < sql.length; pos++) {
		const code = sql.charCodeAt(pos);

		if (state === STATE_NORMAL) {
			if (code === CC_SINGLE_QUOTE) {
				state = STATE_SINGLE_QUOTE;
				stateStartPos = pos;
				continue;
			}

			if (code === CC_DOUBLE_QUOTE) {
				state = STATE_DOUBLE_QUOTE;
				stateStartPos = pos;
				continue;
			}

			if (code === CC_DASH && sql.charCodeAt(pos + 1) === CC_DASH) {
				state = STATE_LINE_COMMENT;
				pos++;
				continue;
			}

			if (code === CC_SLASH && sql.charCodeAt(pos + 1) === CC_STAR) {
				state = STATE_BLOCK_COMMENT;
				stateStartPos = pos;
				pos++;
				continue;
			}

			if (code === CC_QUESTION) {
				segments.push(sql.slice(segStart, pos));
				segStart = pos + 1;
				continue;
			}

			continue;
		}

		if (state === STATE_SINGLE_QUOTE) {
			if (code === CC_SINGLE_QUOTE) {
				if (sql.charCodeAt(pos + 1) === CC_SINGLE_QUOTE) {
					pos++;
					continue;
				}
				state = STATE_NORMAL;
				stateStartPos = -1;
			}
			continue;
		}

		if (state === STATE_DOUBLE_QUOTE) {
			if (code === CC_DOUBLE_QUOTE) {
				if (sql.charCodeAt(pos + 1) === CC_DOUBLE_QUOTE) {
					pos++;
					continue;
				}
				state = STATE_NORMAL;
				stateStartPos = -1;
			}
			continue;
		}

		if (state === STATE_LINE_COMMENT) {
			if (code === CC_NEWLINE) state = STATE_NORMAL;
			continue;
		}

		if (state === STATE_BLOCK_COMMENT) {
			if (code === CC_STAR && sql.charCodeAt(pos + 1) === CC_SLASH) {
				pos++;
				state = STATE_NORMAL;
				stateStartPos = -1;
			}
		}
	}

	if (state === STATE_SINGLE_QUOTE) {
		throw new Error(`Unterminated single-quoted string starting at position ${stateStartPos + 1}`);
	}

	if (state === STATE_DOUBLE_QUOTE) {
		throw new Error(`Unterminated double-quoted identifier/string starting at position ${stateStartPos + 1}`);
	}

	if (state === STATE_BLOCK_COMMENT) {
		throw new Error(`Unterminated block comment starting at position ${stateStartPos + 1}`);
	}

	segments.push(sql.slice(segStart));
	return { segments, paramCount: segments.length - 1 };
}

/**
 * 使用预解析的模板替换参数，避免重新扫描 SQL。
 * @param {{ segments: string[], paramCount: number }} template - 由 _parseTemplate 返回的模板
 * @param {any[]} params - 参数数组
 * @returns {string}
 */
export function interpolateFromTemplate(template, params) {
	const { segments, paramCount } = template;
	if (params.length < paramCount) throw new Error("Too few parameters provided");
	if (params.length > paramCount) throw new Error("Too many parameters provided");

	if (paramCount === 0) return segments[0];

	const parts = [segments[0]];
	for (let i = 0; i < params.length; i++) {
		parts.push(escapeValue(params[i]));
		parts.push(segments[i + 1]);
	}
	return parts.join("");
}

/**
 * 替换 SQL 语句中的 ? 为转义后的参数。
 * 内部使用 LRU 缓存已解析的模板，避免重复扫描相同 SQL。
 * @param {string} sql - SQL 模板（含 ? 占位符）
 * @param {any[]} params - 参数数组
 * @returns {string}
 */
export function interpolateSQL(sql, params) {
	if (!sql.includes("?")) {
		if (params.length > 0) throw new Error("Too many parameters provided");
		return sql;
	}

	let template = _interpCache.get(sql);

	if (template === undefined) {
		template = _parseTemplate(sql);
		_interpCache.set(sql, template);
	}

	return interpolateFromTemplate(template, params);
}
