import { spawn } from "node:child_process";
import { EOL } from "node:os";
import { performance } from "node:perf_hooks";
import { END_SIGNAL, END_MARKERS } from "./constants.js";
import { Queue } from "./queue.js";
import { interpolateSQL, normalizeSQL } from "./utils.js";
export { escapeValue, interpolateSQL } from "./utils.js";

export class AbortError extends Error {
	constructor(message = "This operation was aborted", reason = undefined) {
		super(message);
		this.name = "AbortError";
		this.reason = reason;
	}

	static is(err) {
		return err instanceof AbortError || (err != null && err.name === "AbortError");
	}
}

const DEFAULT_MAX_IN_FLIGHT = 128;
const DEFAULT_MAX_BATCH_CHARS = 128 * 1024;

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
	#maxInFlight = DEFAULT_MAX_IN_FLIGHT;
	#maxBatchChars = DEFAULT_MAX_BATCH_CHARS;
	#proc;
	#logger;
	#onTiming;

	constructor(sqlite3ExePath, { dbPath, logger, onTiming, maxInFlight, maxBatchChars } = {}) {
		this.#logger = logger;
		this.#onTiming = onTiming;
		this.#maxInFlight = this.#normalizePositiveInteger(maxInFlight, DEFAULT_MAX_IN_FLIGHT, "maxInFlight");
		this.#maxBatchChars = this.#normalizePositiveInteger(maxBatchChars, DEFAULT_MAX_BATCH_CHARS, "maxBatchChars");
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

	async exec(sql, params = [], options = {}) {
		return this.#enqueueSQL(sql, params, { isQuery: false, signal: options?.signal });
	}

	async query(sql, params = [], options = {}) {
		const raw = await this.#enqueueSQL(sql, params, { isQuery: true, signal: options?.signal });
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
		this.#proc?.stdin?.destroy();
		this.#proc?.kill();
	}

	// ----------------------------
	// 队列系统
	// ----------------------------
	#enqueueSQL(sql, params, { isQuery, signal }) {
		if (this.#closed) return Promise.reject(new Error("Cannot enqueue SQL on closed SQLiteWrapper"));

		if (signal?.aborted) {
			return Promise.reject(new AbortError(undefined, signal.reason));
		}

		const formatted = params.length === 0 && !sql.includes("?") ? sql : interpolateSQL(sql, params);

		return new Promise((resolve, reject) => {
			let abortHandler = null;

			const task = {
				sql: formatted,
				isQuery,
				enqueuedAt: this.#now(),
				dispatchedAt: 0,
				timingEmitted: false,
				resolve: (...args) => {
					if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
					this.#emitTiming(task, "fulfilled");
					resolve(...args);
				},
				reject: (...args) => {
					if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
					this.#emitTiming(task, "rejected");
					reject(...args);
				},
			};

			if (signal) {
				abortHandler = () => {
					if (task.dispatchedAt === 0) {
						this.queue.remove(task);
						task.reject(new AbortError(undefined, signal.reason));
					}
				};
				signal.addEventListener("abort", abortHandler, { once: true });
			}

			this.queue.enqueue(task);
			this.#pumpQueue();
		});
	}

	#pumpQueue() {
		if (this.#closed || this.#isWaitingDrain || this.#queryInFlight > 0) return;

		const queue = this.queue;
		if (queue.isEmpty()) return;

		const inflight = this.#inflight;
		if (inflight.length > 0 && queue.peek()?.isQuery) return;

		const payloadParts = [];
		let payloadChars = 0;
		let inflightCount = inflight.length;

		while (!queue.isEmpty() && inflightCount < this.#maxInFlight && payloadChars < this.#maxBatchChars) {
			const nextTask = queue.peek();
			if (!nextTask) break;
			if (nextTask.isQuery && inflightCount > 0) break;

			const task = queue.dequeue();
			const statement = normalizeSQL(task.sql);

			this.#logger?.debug?.("Queue SQL for execution:", statement);
			task.dispatchedAt = this.#now();
			inflight.push(task);
			inflightCount++;

			if (task.isQuery) {
				this.#queryInFlight++;
			}

			payloadParts.push(statement, END_SIGNAL);
			payloadChars += statement.length + END_SIGNAL.length + EOL.length;

			if (task.isQuery) break;
		}

		if (payloadParts.length === 0) return;

		const payload = payloadParts.join(EOL) + EOL;

		try {
			if (!this.#proc.stdin.write(payload)) {
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
		this.#proc?.stdin?.destroy();
		this.#proc?.kill();
	}

	#emitTiming(task, status) {
		if (task.timingEmitted) return;
		task.timingEmitted = true;

		const finishedAt = this.#now();
		const dispatchedAt = task.dispatchedAt || finishedAt;
		const queueMs = Math.max(0, Math.round(dispatchedAt - task.enqueuedAt));
		const runMs = Math.max(0, Math.round(finishedAt - dispatchedAt));
		const totalMs = queueMs + runMs;

		this.#logger?.debug?.("SQL execution completed in", totalMs, "ms (queue:", queueMs, "ms, run:", runMs, "ms)");

		this.#onTiming?.({
			sql: task.sql,
			isQuery: task.isQuery,
			status,
			queueMs,
			runMs,
			totalMs,
		});
	}

	#now() {
		return performance.now();
	}

	#normalizePositiveInteger(value, fallback, name) {
		if (value === undefined) return fallback;
		if (!Number.isInteger(value) || value <= 0) {
			throw new TypeError(`${name} must be a positive integer`);
		}

		return value;
	}

	[Symbol.dispose]() {
		this.queue.clear();
		this.close();
	}
}
