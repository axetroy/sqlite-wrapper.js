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
	if (!sql.includes("?")) {
		if (params.length > 0) throw new Error("Too many parameters provided");
		return sql;
	}

	let i = 0;
	let interpolated = "";
	let state = "normal";
	let stateStartPos = -1;

	for (let pos = 0; pos < sql.length; pos++) {
		const ch = sql[pos];
		const next = sql[pos + 1];

		if (state === "normal") {
			if (ch === "'") {
				state = "singleQuote";
				stateStartPos = pos;
				interpolated += ch;
				continue;
			}

			if (ch === '"') {
				state = "doubleQuote";
				stateStartPos = pos;
				interpolated += ch;
				continue;
			}

			if (ch === "-" && next === "-") {
				state = "lineComment";
				interpolated += "--";
				pos++;
				continue;
			}

			if (ch === "/" && next === "*") {
				state = "blockComment";
				stateStartPos = pos;
				interpolated += "/*";
				pos++;
				continue;
			}

			if (ch === "?") {
				if (i >= params.length) throw new Error("Too few parameters provided");
				interpolated += escapeValue(params[i++]);
				continue;
			}

			interpolated += ch;
			continue;
		}

		if (state === "singleQuote") {
			interpolated += ch;

			if (ch === "'" && next === "'") {
				interpolated += next;
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
			interpolated += ch;

			if (ch === '"' && next === '"') {
				interpolated += next;
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
			interpolated += ch;
			if (ch === "\n") state = "normal";
			continue;
		}

		if (state === "blockComment") {
			interpolated += ch;
			if (ch === "*" && next === "/") {
				interpolated += next;
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

	return interpolated;
}

const regexWhitespace = /\s+/g;
const regexTrimSemicolons = /;*$/;
export function normalizeSQL(sql) {
	return sql.trim().replace(regexWhitespace, " ").replace(regexTrimSemicolons, ";");
}
