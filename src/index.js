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
			// Prevent unbounded memory growth (max 1MB stderr)
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

	close() {
		this.#closed = true;
		this.#rl?.close();
		this.#proc?.stdin?.end();
		this.#proc?.kill();
	}

	// ----------------------------
	// 队列系统
	// ----------------------------
	#enqueueSQL(sql, params) {
		if (this.#closed) return Promise.reject(new Error("Cannot enqueue SQL on closed SQLiteWrapper"));

		const formatted = interpolateSQL(sql, params);

		return new Promise((resolve, reject) => {
			this.#queue.push({ sql: formatted, resolve, reject, isRaw: false });
			this.#maybeProcessNext();
		});
	}

	#enqueueCommand(command) {
		if (this.#closed) return Promise.reject(new Error("Cannot enqueue command on closed SQLiteWrapper"));

		return new Promise((resolve, reject) => {
			this.#queue.push({ sql: command, resolve, reject, isRaw: true });
			this.#maybeProcessNext();
		});
	}

	#maybeProcessNext() {
		if (this.#closed || this.#current || this.#queue.length === 0) return;
		this.#current = this.#queue.shift();

		const { sql, isRaw } = this.#current;
		// Optimize: avoid regex by checking for semicolon first
		const statement = isRaw ? sql : (sql.endsWith(";") ? sql : sql.trimEnd() + ";");

		this.#logger?.debug?.("Executing SQL:", statement);
		this.#proc.stdin.write(statement + EOL + END_SIGNAL);
	}

	#handleLine(line) {
		if (END_MARKERS.has(line)) {
			this.#finalizeCurrent();
		} else {
			// Collect lines in array for efficient joining (avoid O(n²) string concat)
			// Limit to 10000 lines to prevent unbounded memory growth
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

		if (error) {
			reject(new Error(error));
		} else {
			resolve(result);
		}
		this.#maybeProcessNext();
	}

	#handleFatalError(error) {
		// Clear buffers to prevent memory leaks
		this.#stdoutLines = [];
		this.#stderrBuffer = "";
		
		this.close();
		if (this.#current) {
			this.#current.reject(new Error("sqlite3 process error: " + error.message, { cause: error }));
			this.#current = null;
		}
	}
}
