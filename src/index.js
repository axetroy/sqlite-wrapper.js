import { spawn } from "node:child_process";
import { EOL } from "node:os";
import { END_SIGNAL, END_MARKERS } from "./constants.js";
import { Queue } from "./queue.js";
import { interpolateSQL } from "./utils.js";
export { escapeValue, interpolateSQL } from "./utils.js";

export class SQLiteWrapper {
	queue = new Queue();
	#inflight = [];
	#closed = false;
	#stdoutChunkBuffer = [];
	#stdoutChunkRemainder = "";
	#stderrChunkBuffer = [];
	#stderrChunkRemainder = "";
	#isWaitingDrain = false;
	#isFinalizeScheduled = false;
	#queryInFlight = 0;
	#maxInFlight = 128;
	#maxBatchChars = 128 * 1024;
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
			this.#handleStderrChunk(chunk.toString());
		});

		this.#proc.stdout.on("data", (chunk) => {
			this.#handleStdoutChunk(chunk.toString());
		});

		this.#proc.stdin.on("drain", () => {
			this.#isWaitingDrain = false;
			this.#pumpQueue();
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
		return this.queue.size + this.#inflight.length;
	}

	async exec(sql, params = []) {
		return this.#enqueueSQL(sql, params, { isQuery: false });
	}

	async query(sql, params = []) {
		const raw = await this.#enqueueSQL(sql, params, { isQuery: true });
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
	#enqueueSQL(sql, params, { isQuery }) {
		if (this.#closed) return Promise.reject(new Error("Cannot enqueue SQL on closed SQLiteWrapper"));

		const formatted = params.length === 0 && !sql.includes("?") ? sql : interpolateSQL(sql, params);

		return new Promise((resolve, reject) => {
			const startTime = Date.now();
			const end = () => {
				this.#logger?.debug?.("SQL execution completed in ", Date.now() - startTime, "ms");
			};

			this.queue.enqueue({
				sql: formatted,
				isQuery,
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
			this.#pumpQueue();
		});
	}

	#pumpQueue() {
		if (this.#closed || this.#isWaitingDrain) return;
		if (this.#queryInFlight > 0) return;
		if (this.queue.isEmpty()) return;
		if (this.#inflight.length > 0 && this.queue.peek()?.isQuery) return;

		let payload = "";

		while (!this.queue.isEmpty() && this.#inflight.length < this.#maxInFlight && payload.length < this.#maxBatchChars) {
			const nextTask = this.queue.peek();
			if (!nextTask) break;

			if (nextTask.isQuery && this.#inflight.length > 0) break;

			const task = this.queue.dequeue();
			const { sql, isRaw } = task;
			const statement = isRaw ? sql : sql.trim().replace(/;*$/, ";");

			this.#logger?.debug?.("Queue SQL for execution:", statement);
			this.#inflight.push(task);
			if (task.isQuery) this.#queryInFlight++;
			payload += statement + EOL + END_SIGNAL;

			if (task.isQuery) break;
		}

		if (!payload) return;

		try {
			const canContinueWrite = this.#proc.stdin.write(payload);
			if (!canContinueWrite) {
				this.#isWaitingDrain = true;
			}
		} catch (error) {
			this.#handleFatalError(error);
		}
	}

	#handleLine(line) {
		if (!this.#inflight.length) return;

		if (END_MARKERS.has(line)) {
			const current = this.#inflight[0];
			if (current?.isQuery) {
				this.#scheduleFinalizeCurrent();
			} else {
				this.#finalizeCurrent();
			}
		} else {
			this.#stdoutChunkBuffer.push(line);
		}
	}

	#scheduleFinalizeCurrent() {
		if (this.#isFinalizeScheduled) return;
		this.#isFinalizeScheduled = true;

		setImmediate(() => {
			this.#isFinalizeScheduled = false;
			this.#finalizeCurrent();
		});
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

	#handleStderrChunk(chunk) {
		this.#stderrChunkRemainder += chunk;

		let lineStart = 0;
		for (let i = 0; i < this.#stderrChunkRemainder.length; i++) {
			if (this.#stderrChunkRemainder[i] !== "\n") continue;

			let line = this.#stderrChunkRemainder.slice(lineStart, i);
			if (line.endsWith("\r")) line = line.slice(0, -1);

			const normalized = line.trim();
			if (normalized && this.#inflight.length > 0) this.#stderrChunkBuffer.push(normalized);
			lineStart = i + 1;
		}

		this.#stderrChunkRemainder = this.#stderrChunkRemainder.slice(lineStart);
	}

	#flushStderrRemainder() {
		const normalized = this.#stderrChunkRemainder.trim();
		if (!normalized || this.#inflight.length === 0) return;

		this.#stderrChunkBuffer.push(normalized);
		this.#stderrChunkRemainder = "";
	}

	#finalizeCurrent() {
		this.#flushStderrRemainder();

		const result = this.#stdoutChunkBuffer.join(EOL).trim();
		const error = this.#stderrChunkBuffer.join(EOL).trim();

		this.#stdoutChunkBuffer = [];
		this.#stderrChunkBuffer = [];

		const current = this.#inflight.shift();
		if (!current) return;
		if (current.isQuery) this.#queryInFlight--;
		const { resolve, reject } = current;

		if (error) {
			reject(new Error(error));
		} else {
			resolve(result);
		}
		this.#pumpQueue();
	}

	#rejectPending(error) {
		for (const task of this.#inflight) {
			task.reject(error);
		}
		this.#inflight = [];

		while (!this.queue.isEmpty()) {
			const task = this.queue.dequeue();
			task.reject(error);
		}

		this.#stdoutChunkBuffer = [];
		this.#stdoutChunkRemainder = "";
		this.#stderrChunkBuffer = [];
		this.#stderrChunkRemainder = "";
		this.#isWaitingDrain = false;
		this.#isFinalizeScheduled = false;
		this.#queryInFlight = 0;
	}

	#handleFatalError(error) {
		if (this.#closed) return;

		this.#closed = true;
		this.#rejectPending(new Error("sqlite3 process error: " + error.message, { cause: error }));
		this.#proc?.stdin?.end();
		this.#proc?.kill();
	}

	[Symbol.dispose]() {
		this.queue.clear();
		this.close();
	}
}
