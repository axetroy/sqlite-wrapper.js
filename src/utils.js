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

const regexWhitespace = /\s+/g;
const regexTrimSemicolons = /;*$/;
export function normalizeSQL(sql) {
	const stripped = sql.includes("--") ? stripLineComments(sql) : sql;
	return stripped.trim().replace(regexWhitespace, " ").replace(regexTrimSemicolons, ";");
}

/**
 * Strip SQL line comments (-- to end of line) while preserving string literals.
 * @param {string} sql
 * @returns {string}
 */
function stripLineComments(sql) {
	const parts = [];
	let segStart = 0;
	let i = 0;
	const len = sql.length;

	while (i < len) {
		const ch = sql[i];

		if (ch === "'") {
			// Single-quoted string: skip verbatim including escaped quotes ('')
			i++;
			while (i < len) {
				if (sql[i] === "'" && sql[i + 1] === "'") {
					i += 2;
				} else if (sql[i] === "'") {
					i++;
					break;
				} else {
					i++;
				}
			}
		} else if (ch === '"') {
			// Double-quoted identifier: skip verbatim including escaped quotes ("")
			i++;
			while (i < len) {
				if (sql[i] === '"' && sql[i + 1] === '"') {
					i += 2;
				} else if (sql[i] === '"') {
					i++;
					break;
				} else {
					i++;
				}
			}
		} else if (ch === "-" && sql[i + 1] === "-") {
			// Line comment: flush accumulated segment then skip to end of line
			parts.push(sql.slice(segStart, i));
			while (i < len && sql[i] !== "\n") {
				i++;
			}
			segStart = i;
		} else {
			i++;
		}
	}

	if (parts.length === 0) return sql;
	parts.push(sql.slice(segStart));
	return parts.join("");
}
