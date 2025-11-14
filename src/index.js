import { spawn } from "node:child_process";
import readline from "node:readline";
import { EOL } from "node:os";
import { END_SIGNAL, END_MARKERS } from "./constants.js";
import { interpolateSQL } from "./utils.js";
export { escapeValue, interpolateSQL } from "./utils.js";

export class SQLiteWrapper {
	#queue = [];
	#current = null;
	#closed = false;
	#stdoutLines = [];
	#stderrBuffer = "";
	#proc;
	#rl;
	#logger;
	#modeIsSet = false;

	constructor(sqlite3ExePath, { dbPath, logger } = {}) {
		this.#logger = logger;
		this.#initProcess(sqlite3ExePath, dbPath);
	}

	// ----------------------------
	// 进程初始化与事件绑定
	// ----------------------------
	#initProcess(sqlite3ExePath, dbPath) {
		this.#proc = spawn(sqlite3ExePath, dbPath ? [dbPath] : [], { stdio: "pipe" });
		this.#proc.stdin.setDefaultEncoding("utf-8");

		this.#bindProcessEvents();
		this.#setupStdoutReader();
	}

	#bindProcessEvents() {
		this.#proc.on("error", (err) => {
			this.#logger?.error("sqlite3 process error:", err);
			this.#handleFatalError(err);
		});

		this.#proc.stderr.on("data", (chunk) => {
			const newData = chunk.toString();
			// Limit stderr buffer to prevent memory issues (max 1MB)
			if (this.#stderrBuffer.length + newData.length > 1048576) {
				this.#stderrBuffer = this.#stderrBuffer.slice(-524288) + newData;
			} else {
				this.#stderrBuffer += newData;
			}
		});

		this.#proc.on("close", () => {
			this.#handleFatalError(new Error("sqlite3 process closed unexpectedly"));
		});
	}

	#setupStdoutReader() {
		this.#rl = readline.createInterface({ input: this.#proc.stdout, terminal: false });
		this.#rl.on("line", (line) => this.#handleLine(line.trim()));
	}

	// ----------------------------
	// 主接口方法
	// ----------------------------
	async exec(sql, params = []) {
		return this.#enqueueSQL(sql, params);
	}

	async query(sql, params = []) {
		if (!this.#modeIsSet) {
			await this.#enqueueCommand(".mode json");
			this.#modeIsSet = true;
		}

		const raw = await this.#enqueueSQL(sql, params);
		if (!raw.trim()) return [];

		try {
			return JSON.parse(raw);
		} catch {
			throw new Error("Invalid JSON from sqlite3: " + raw);
		}
	}

	async close() {
		this.#closed = true;
		this.#rl?.close();
		this.#proc?.stdin?.end();
		this.#proc?.kill();
	}

	// ----------------------------
	// 队列系统
	// ----------------------------
	#enqueueSQL(sql, params) {
		const formatted = interpolateSQL(sql, params);

		return new Promise((resolve, reject) => {
			this.#queue.push({ sql: formatted, resolve, reject, isRaw: false });
			this.#maybeProcessNext();
		});
	}

	#enqueueCommand(command) {
		return new Promise((resolve, reject) => {
			this.#queue.push({ sql: command, resolve, reject, isRaw: true });
			this.#maybeProcessNext();
		});
	}

	#maybeProcessNext() {
		if (this.#closed || this.#current || this.#queue.length === 0) return;
		this.#current = this.#queue.shift();

		const { sql, isRaw } = this.#current;
		// Optimize: reduce string operations by checking for semicolon first
		const statement = isRaw ? sql : (sql.endsWith(";") ? sql : sql.trimEnd() + ";");

		this.#logger?.debug?.("Executing SQL:", statement);
		this.#proc.stdin.write(statement + EOL + END_SIGNAL);
	}

	#handleLine(line) {
		if (END_MARKERS.has(line)) {
			this.#finalizeCurrent();
		} else {
			// Limit stdout buffer to prevent memory issues (max 10000 lines)
			if (this.#stdoutLines.length >= 10000) {
				this.#stdoutLines.shift();
			}
			this.#stdoutLines.push(line);
		}
	}

	#finalizeCurrent() {
		const result = this.#stdoutLines.join(EOL).trim();
		const error = this.#stderrBuffer.trim();

		this.#stdoutLines = [];
		this.#stderrBuffer = "";

		if (!this.#current) return;
		const { resolve, reject } = this.#current;
		this.#current = null;

		error ? reject(new Error(error)) : resolve(result);
		this.#maybeProcessNext();
	}

	#handleFatalError(error) {
		this.#closed = true;
		// Clear buffers to prevent memory leaks
		this.#stdoutLines = [];
		this.#stderrBuffer = "";
		
		if (this.#current) {
			this.#current.reject(new Error("sqlite3 process error: " + error.message, { cause: error }));
			this.#current = null;
		}
	}
}
