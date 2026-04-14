// Character code constants used across functions
const CC_SINGLE_QUOTE = 39; // '
const CC_DOUBLE_QUOTE = 34; // "
const CC_DASH = 45; // -
const CC_SLASH = 47; // /
const CC_STAR = 42; // *
const CC_NEWLINE = 10; // \n
const CC_QUESTION = 63; // ?
const CC_SEMICOLON = 59; // ;
const CC_SPACE = 32; // (space)

// State constants shared by interpolateSQL and normalizeSQL
const STATE_NORMAL = 0;
const STATE_SINGLE_QUOTE = 1;
const STATE_DOUBLE_QUOTE = 2;
const STATE_LINE_COMMENT = 3;
const STATE_BLOCK_COMMENT = 4;

/**
 * 转义 SQLite 参数
 * @param {any} value
 * @returns {string}
 */
export function escapeValue(value) {
	if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
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
	if (!sql.includes("?")) {
		if (params.length > 0) throw new Error("Too many parameters provided");
		return sql;
	}

	let i = 0;
	const parts = [];
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
				if (i >= params.length) throw new Error("Too few parameters provided");
				parts.push(sql.slice(segStart, pos));
				parts.push(escapeValue(params[i++]));
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

	if (i < params.length) throw new Error("Too many parameters provided");

	parts.push(sql.slice(segStart));
	return parts.join("");
}

// Module-level reusable buffer for normalizeSQL. Grows as needed; never shrinks.
// Safe because Node.js is single-threaded and normalizeSQL is synchronous.
let _normBuf = new Uint16Array(1024);
// Module-level TextDecoder reuse avoids per-call object allocation.
// 'utf-16le' maps each Uint16 element to its UTF-16 code unit.
// Node.js runs exclusively on little-endian platforms (x86/x64/ARM64),
// where Uint16Array values are stored in LE byte order, matching utf-16le.
// If big-endian support is ever needed, switch to String.fromCharCode in a loop.
const _normDecoder = new TextDecoder("utf-16le");

export function normalizeSQL(sql) {
	const len = sql.length;

	// Ensure the reusable buffer is large enough (output is at most len+1 chars)
	const needed = len + 1;
	if (_normBuf.length < needed) {
		_normBuf = new Uint16Array(needed * 2);
	}

	const outCodes = _normBuf;
	let writePos = 0;
	let pendingSpace = false;
	let state = STATE_NORMAL;

	for (let i = 0; i < len; i++) {
		const code = sql.charCodeAt(i);
		const nextCode = sql.charCodeAt(i + 1);

		if (state === STATE_LINE_COMMENT) {
			if (code === CC_NEWLINE) {
				state = STATE_NORMAL;
				if (writePos > 0) pendingSpace = true;
			}
			continue;
		}

		if (state === STATE_NORMAL) {
			if (code === CC_DASH && nextCode === CC_DASH) {
				state = STATE_LINE_COMMENT;
				i++;
				continue;
			}
		}

		// space, tab, lf, vt, ff, cr
		if (code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13) {
			if (writePos > 0) pendingSpace = true;
			continue;
		}

		if (pendingSpace && writePos > 0) {
			outCodes[writePos++] = CC_SPACE;
			pendingSpace = false;
		}
		outCodes[writePos++] = code;

		if (state === STATE_NORMAL) {
			if (code === CC_SINGLE_QUOTE) state = STATE_SINGLE_QUOTE;
			else if (code === CC_DOUBLE_QUOTE) state = STATE_DOUBLE_QUOTE;
			continue;
		}

		if (state === STATE_SINGLE_QUOTE) {
			if (code === CC_SINGLE_QUOTE && nextCode === CC_SINGLE_QUOTE) {
				outCodes[writePos++] = nextCode;
				i++;
				continue;
			}

			if (code === CC_SINGLE_QUOTE) state = STATE_NORMAL;
			continue;
		}

		if (state === STATE_DOUBLE_QUOTE) {
			if (code === CC_DOUBLE_QUOTE && nextCode === CC_DOUBLE_QUOTE) {
				outCodes[writePos++] = nextCode;
				i++;
				continue;
			}

			if (code === CC_DOUBLE_QUOTE) state = STATE_NORMAL;
		}
	}

	if (writePos === 0) return ";";

	while (writePos > 0 && outCodes[writePos - 1] === CC_SEMICOLON) writePos--;
	outCodes[writePos++] = CC_SEMICOLON;

	return _normDecoder.decode(outCodes.subarray(0, writePos));
}
