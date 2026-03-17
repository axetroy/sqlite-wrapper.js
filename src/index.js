import { spawn } from "node:child_process";
import { EOL } from "node:os";
import { END_SIGNAL, END_MARKERS } from "./constants.js";
import { Queue } from "./queue.js";
import { interpolateSQL } from "./utils.js";
export { escapeValue, interpolateSQL } from "./utils.js";

export class SQLiteWrapper {
	#queue = new Queue();
	#current = null;
	#closed = false;
	#stdoutBuffer = [];
	#stdoutChunkRemainder = "";
	#stderrBuffer = [];
	#proc;
	#logger;

	constructor(sqlite3ExePath, { dbPath, logger } = {}) {
		this.#logger = logger;
		this.#initProcess(sqlite3ExePath, dbPath);
	}

	// ----------------------------
	// 进程初始化与事件绑定
	// ----------------------------
	#initProcess(sqlite3ExePath, dbPath) {
		const args = ["-cmd", ".mode json"];

		if (dbPath) args.push(dbPath);

		this.#proc = spawn(sqlite3ExePath, args, { stdio: "pipe" });
		this.#proc.stdin.setDefaultEncoding("utf-8");

		this.#bindProcessEvents();
	}

	#bindProcessEvents() {
		this.#proc.on("error", (err) => {
			this.#logger?.error("sqlite3 process error:", err);
			this.#handleFatalError(err);
		});

		this.#proc.stderr.on("data", (chunk) => {
			this.#stderrBuffer.push(chunk.toString());
		});

		this.#proc.stdout.on("data", (chunk) => {
			this.#handleStdoutChunk(chunk.toString());
		});

		this.#proc.on("close", () => {
			if (this.#closed) return;
			this.#handleFatalError(new Error("sqlite3 process closed unexpectedly"));
		});
	}

	// ----------------------------
	// 主接口方法
	// ----------------------------
	get pendingQueries() {
		return this.#queue.size + (this.#current ? 1 : 0);
	}

	async exec(sql, params = []) {
		return this.#enqueueSQL(sql, params);
	}

	async query(sql, params = []) {
		const raw = await this.#enqueueSQL(sql, params);
		if (!raw.trim()) return [];

		try {
			return JSON.parse(raw);
		} catch {
			throw new Error("Invalid JSON from sqlite3: " + raw);
		}
	}

	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#rejectPending(new Error("SQLiteWrapper is closed"));
		this.#proc?.stdin?.end();
		this.#proc?.kill();
	}

	// ----------------------------
	// 队列系统
	// ----------------------------
	#enqueueSQL(sql, params) {
		if (this.#closed) return Promise.reject(new Error("Cannot enqueue SQL on closed SQLiteWrapper"));

		const formatted = params.length === 0 && !sql.includes("?") ? sql : interpolateSQL(sql, params);

		return new Promise((resolve, reject) => {
			const startTime = Date.now();
			const end = () => {
				this.#logger?.debug?.("SQL execution completed in ", Date.now() - startTime, "ms");
			};

			this.#queue.enqueue({
				sql: formatted,
				resolve: (...args) => {
					end();
					resolve(...args);
				},
				reject: (...args) => {
					end();
					reject(...args);
				},
				isRaw: false,
			});
			this.#maybeProcessNext();
		});
	}

	#maybeProcessNext() {
		if (this.#closed || this.#current || this.#queue.isEmpty()) return;
		this.#current = this.#queue.dequeue();

		const { sql, isRaw } = this.#current;
		const statement = isRaw ? sql : sql.trim().replace(/;*$/, ";");

		this.#logger?.debug?.("Executing SQL:", statement);
		try {
			this.#proc.stdin.write(statement + EOL + END_SIGNAL);
		} catch (error) {
			this.#handleFatalError(error);
		}
	}

	#handleLine(line) {
		if (END_MARKERS.has(line)) {
			this.#finalizeCurrent();
		} else {
			this.#stdoutBuffer.push(line);
		}
	}

	#handleStdoutChunk(chunk) {
		this.#stdoutChunkRemainder += chunk;

		let lineStart = 0;
		for (let i = 0; i < this.#stdoutChunkRemainder.length; i++) {
			if (this.#stdoutChunkRemainder[i] !== "\n") continue;

			let line = this.#stdoutChunkRemainder.slice(lineStart, i);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.#handleLine(line.trim());
			lineStart = i + 1;
		}

		this.#stdoutChunkRemainder = this.#stdoutChunkRemainder.slice(lineStart);
	}

	#finalizeCurrent() {
		const result = this.#stdoutBuffer.join(EOL).trim();
		const error = this.#stderrBuffer.join("").trim();

		this.#stdoutBuffer = [];
		this.#stderrBuffer = [];

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

	#rejectPending(error) {
		if (this.#current) {
			this.#current.reject(error);
			this.#current = null;
		}

		while (!this.#queue.isEmpty()) {
			const task = this.#queue.dequeue();
			task.reject(error);
		}

		this.#stdoutBuffer = [];
		this.#stdoutChunkRemainder = "";
		this.#stderrBuffer = [];
	}

	#handleFatalError(error) {
		if (this.#closed) return;

		this.#closed = true;
		this.#rejectPending(new Error("sqlite3 process error: " + error.message, { cause: error }));
		this.#proc?.stdin?.end();
		this.#proc?.kill();
	}

	[Symbol.dispose]() {
		this.#queue.clear();
		this.close();
	}
}
