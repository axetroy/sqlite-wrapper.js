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
	let state = "normal";
	let stateStartPos = -1;

	for (let pos = 0; pos < sql.length; pos++) {
		const ch = sql[pos];
		const next = sql[pos + 1];

		if (state === "normal") {
			if (ch === "'") {
				state = "singleQuote";
				stateStartPos = pos;
				continue;
			}

			if (ch === '"') {
				state = "doubleQuote";
				stateStartPos = pos;
				continue;
			}

			if (ch === "-" && next === "-") {
				state = "lineComment";
				pos++;
				continue;
			}

			if (ch === "/" && next === "*") {
				state = "blockComment";
				stateStartPos = pos;
				pos++;
				continue;
			}

			if (ch === "?") {
				if (i >= params.length) throw new Error("Too few parameters provided");
				parts.push(sql.slice(segStart, pos));
				parts.push(escapeValue(params[i++]));
				segStart = pos + 1;
				continue;
			}

			continue;
		}

		if (state === "singleQuote") {
			if (ch === "'" && next === "'") {
				pos++;
				continue;
			}

			if (ch === "'") {
				state = "normal";
				stateStartPos = -1;
			}
			continue;
		}

		if (state === "doubleQuote") {
			if (ch === '"' && next === '"') {
				pos++;
				continue;
			}

			if (ch === '"') {
				state = "normal";
				stateStartPos = -1;
			}
			continue;
		}

		if (state === "lineComment") {
			if (ch === "\n") state = "normal";
			continue;
		}

		if (state === "blockComment") {
			if (ch === "*" && next === "/") {
				pos++;
				state = "normal";
				stateStartPos = -1;
			}
		}
	}

	if (state === "singleQuote") {
		throw new Error(`Unterminated single-quoted string starting at position ${stateStartPos + 1}`);
	}

	if (state === "doubleQuote") {
		throw new Error(`Unterminated double-quoted identifier/string starting at position ${stateStartPos + 1}`);
	}

	if (state === "blockComment") {
		throw new Error(`Unterminated block comment starting at position ${stateStartPos + 1}`);
	}

	if (i < params.length) throw new Error("Too many parameters provided");

	parts.push(sql.slice(segStart));
	return parts.join("");
}
function isWhitespace(code) {
	// space, tab, lf, vt, ff, cr
	return code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13;
}

export function normalizeSQL(sql) {
	const len = sql.length;
	const outCodes = new Uint16Array(len + 1);
	let writePos = 0;
	let pendingSpace = false;
	let state = "normal";

	function writeCode(code) {
		outCodes[writePos++] = code;
	}

	function writeChar(ch) {
		writeCode(ch.charCodeAt(0));
	}

	function writePendingSpaceIfNeeded() {
		if (pendingSpace && writePos > 0) {
			writeCode(32); // space
			pendingSpace = false;
		}
	}

	for (let i = 0; i < len; i++) {
		const ch = sql[i];
		const next = sql[i + 1];

		if (state === "lineComment") {
			if (ch === "\n") {
				state = "normal";
				if (writePos > 0) pendingSpace = true;
			}
			continue;
		}

		if (state === "normal") {
			if (ch === "-" && next === "-") {
				state = "lineComment";
				i++;
				continue;
			}
		}

		if (isWhitespace(ch.charCodeAt(0))) {
			if (writePos > 0) pendingSpace = true;
			continue;
		}

		writePendingSpaceIfNeeded();
		writeChar(ch);

		if (state === "normal") {
			if (ch === "'") state = "singleQuote";
			else if (ch === '"') state = "doubleQuote";
			continue;
		}

		if (state === "singleQuote") {
			if (ch === "'" && next === "'") {
				writeChar(next);
				i++;
				continue;
			}

			if (ch === "'") state = "normal";
			continue;
		}

		if (state === "doubleQuote") {
			if (ch === '"' && next === '"') {
				writeChar(next);
				i++;
				continue;
			}

			if (ch === '"') state = "normal";
		}
	}

	if (writePos === 0) return ";";

	while (writePos > 0 && outCodes[writePos - 1] === 59) writePos--; // ';'
	outCodes[writePos++] = 59;

	let out = "";
	const CHUNK_SIZE = 8192;
	for (let i = 0; i < writePos; i += CHUNK_SIZE) {
		const end = Math.min(writePos, i + CHUNK_SIZE);
		out += String.fromCharCode(...outCodes.subarray(i, end));
	}

	return out;
}
