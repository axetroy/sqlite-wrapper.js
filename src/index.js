import { spawn } from "node:child_process";
import { EOL } from "node:os";
import { performance } from "node:perf_hooks";
import { END_SIGNAL, END_MARKERS } from "./constants.js";
import { Queue } from "./queue.js";
import { interpolateSQL, normalizeSQL } from "./utils.js";
import { ReaderPool } from "./reader-pool.js";
export { escapeValue, interpolateSQL } from "./utils.js";
export { AbortError } from "./errors.js";
import { AbortError } from "./errors.js";

const DEFAULT_MAX_IN_FLIGHT = 128;
const DEFAULT_MAX_BATCH_CHARS = 128 * 1024;
const END_PACKET_CHARS = END_SIGNAL.length + EOL.length;
const CHAR_LF = 10;
const CHAR_CR = 13;
const CHAR_SPACE = 32;
const CHAR_TAB = 9;

const VALID_TRANSACTION_TYPES = ["DEFERRED", "IMMEDIATE", "EXCLUSIVE"];

// Maximum number of task objects retained in the per-instance pool.
// Sized at 2× the default max-in-flight to cover steady-state cycling.
const TASK_POOL_MAX_SIZE = 256;

export class SQLiteWrapper {
	queue = new Queue();
	#inflight = [];
	#closed = false;
	#exclusiveChain = Promise.resolve();
	// Symbol of the exclusive zone currently holding the lock.
	// Null when no zone is active.
	#activeZoneId = null;
	// Tasks that arrived while an exclusive zone was active and do not belong to it.
	// Re-enqueued (with priority) once the zone ends.
	#deferredQueue = new Queue();
	#stdoutResult = [];
	#stdoutChunkRemainder = "";
	#stderrResult = [];
	#stderrChunkRemainder = "";
	#isWaitingDrain = false;
	#isFinalizeScheduled = false;
	#isPumpScheduled = false;
	#queryInFlight = 0;
	#maxInFlight = DEFAULT_MAX_IN_FLIGHT;
	#maxBatchChars = DEFAULT_MAX_BATCH_CHARS;
	// Reusable array for #pumpQueue payload construction; avoids per-pump allocation.
	#payloadParts = [];
	// Object pool for task descriptors; reduces GC pressure under high-frequency use.
	#taskPool = [];
	// 读进程池（仅在 readPoolSize > 0 且使用文件数据库时启用）
	#readerPool = null;
	#proc;
	#logger;
	#onTiming;

	constructor(sqlite3ExePath, { dbPath, logger, onTiming, maxInFlight, maxBatchChars, readPoolSize } = {}) {
		this.#logger = logger;
		this.#onTiming = onTiming;
		this.#maxInFlight = this.#normalizePositiveInteger(maxInFlight, DEFAULT_MAX_IN_FLIGHT, "maxInFlight");
		this.#maxBatchChars = this.#normalizePositiveInteger(maxBatchChars, DEFAULT_MAX_BATCH_CHARS, "maxBatchChars");

		// 先校验 readPoolSize，避免进程启动后再抛出异常导致资源泄漏
		if (readPoolSize !== undefined && (!Number.isInteger(readPoolSize) || readPoolSize <= 0)) {
			throw new TypeError("readPoolSize must be a positive integer");
		}

		this.#initProcess(sqlite3ExePath, dbPath);

		// 启用读写分离进程池：需要正整数的 readPoolSize 且必须指定文件数据库
		if (readPoolSize !== undefined) {
			if (dbPath && dbPath !== ":memory:") {
				// 自动开启 WAL 模式，使读写进程可并发访问数据库
				this.exec("PRAGMA journal_mode=WAL").catch(() => {});
				this.#readerPool = new ReaderPool(readPoolSize, sqlite3ExePath, dbPath, { onTiming, logger });
			} else {
				this.#logger?.warn(
					"readPoolSize 被指定但未提供有效的 dbPath（文件路径），读进程池不会启用。" +
						"内存数据库（:memory:）无法跨进程共享。",
				);
			}
		}
	}

	// ----------------------------
	// 进程初始化与事件绑定
	// ----------------------------
	#initProcess(sqlite3ExePath, dbPath) {
		const args = ["-cmd", ".mode json"];

		if (dbPath) args.push(dbPath);

		this.#proc = spawn(sqlite3ExePath, args, { stdio: "pipe" });
		this.#proc.stdin.setDefaultEncoding("utf-8");
		this.#proc.stdout.setEncoding("utf-8");
		this.#proc.stderr.setEncoding("utf-8");

		this.#bindProcessEvents();
	}

	#bindProcessEvents() {
		const proc = this.#proc;

		proc.on("error", (err) => {
			this.#logger?.error("sqlite3 process error:", err);
			this.#handleFatalError(err);
		});

		proc.stderr.on("data", (chunk) => {
			this.#handleStderrChunk(chunk);
		});

		proc.stdout.on("data", (chunk) => {
			this.#handleStdoutChunk(chunk);
		});

		proc.stdin.on("drain", () => {
			this.#isWaitingDrain = false;
			this.#schedulePumpQueue();
		});

		proc.on("close", () => {
			if (this.#closed) return;
			this.#handleFatalError(new Error("sqlite3 process closed unexpectedly"));
		});
	}

	// ----------------------------
	// 主接口方法
	// ----------------------------
	get pendingQueries() {
		const readerPending = this.#readerPool ? this.#readerPool.pendingCount : 0;
		return this.queue.size + this.#deferredQueue.size + this.#inflight.length + readerPending;
	}

	async exec(sql, params = [], options = {}) {
		return this.#enqueueSQL(sql, params, { isQuery: false, signal: options?.signal, txId: null });
	}

	async run(sql, params = [], options = {}) {
		return this.#runWithTxId(sql, params, options, null);
	}

	async #runWithTxId(sql, params, options, txId) {
		const sqlWithMeta = sql + ";\nSELECT changes() as changes, last_insert_rowid() as lastInsertRowid;";
		const raw = await this.#enqueueSQL(sqlWithMeta, params, { isQuery: true, signal: options?.signal, txId });
		if (!raw) return { changes: 0, lastInsertRowid: 0 };

		try {
			const result = JSON.parse(raw);
			const row = result[0] ?? {};
			return {
				changes: row.changes ?? 0,
				lastInsertRowid: row.lastInsertRowid ?? 0,
			};
		} catch {
			throw new Error("Invalid JSON from sqlite3: " + raw);
		}
	}

	async query(sql, params = [], options = {}) {
		return this.#queryWithTxId(sql, params, options, null);
	}

	async #queryWithTxId(sql, params, options, txId) {
		// 路由到读进程池：仅当池可用、不在事务/排他区内（txId === null）
		if (this.#readerPool && !this.#readerPool.isClosed && txId === null) {
			if (this.#closed) return Promise.reject(new Error("Cannot enqueue SQL on closed SQLiteWrapper"));
			if (options?.signal?.aborted) {
				return Promise.reject(new AbortError(undefined, options.signal.reason));
			}

			const formatted = params.length === 0 && !sql.includes("?") ? sql : interpolateSQL(sql, params);
			const enqueuedAt = this.#onTiming ? performance.now() : 0;

			const raw = await this.#readerPool.query(formatted, { signal: options?.signal, enqueuedAt });
			if (!raw) return [];
			try {
				return JSON.parse(raw);
			} catch {
				throw new Error("Invalid JSON from sqlite3: " + raw);
			}
		}

		// 回退到写进程（事务内、排他区内，或读进程池未启用）
		const raw = await this.#enqueueSQL(sql, params, { isQuery: true, signal: options?.signal, txId });
		if (!raw) return [];

		try {
			return JSON.parse(raw);
		} catch {
			throw new Error("Invalid JSON from sqlite3: " + raw);
		}
	}

	async exclusive(fn) {
		const zoneId = Symbol();

		let releaseGate;
		const gate = new Promise((resolve) => {
			releaseGate = resolve;
		});

		const previous = this.#exclusiveChain;
		this.#exclusiveChain = gate;

		try {
			await previous;
		} catch {
			// The previous zone's error has already been delivered to its own caller.
			// We only need the gate to resolve so this zone can proceed.
		}

		// Claim the active slot synchronously (no await between here and fn).
		// Any bare exec/run/query calls enqueued from this point on will be deferred
		// until after the zone ends.
		this.#activeZoneId = zoneId;

		const zone = {
			exec: (sql, params = [], options = {}) =>
				this.#enqueueSQL(sql, params, { isQuery: false, signal: options?.signal, txId: zoneId }),
			run: (sql, params = [], options = {}) => this.#runWithTxId(sql, params, options, zoneId),
			query: (sql, params = [], options = {}) => this.#queryWithTxId(sql, params, options, zoneId),
		};

		try {
			return await fn(zone);
		} finally {
			// Release the active slot before unblocking the next zone so that
			// deferred tasks are restored while no zone holds the lock.
			this.#activeZoneId = null;
			this.#restoreDeferred();
			releaseGate();
		}
	}

	async transaction(fn, type = "DEFERRED") {
		if (!VALID_TRANSACTION_TYPES.includes(type)) {
			throw new TypeError(`transaction type must be one of: ${VALID_TRANSACTION_TYPES.join(", ")}`);
		}

		return this.exclusive(async (zone) => {
			await zone.exec(`BEGIN ${type}`);
			try {
				const result = await fn(zone);
				await zone.exec("COMMIT");
				return result;
			} catch (error) {
				// ROLLBACK errors (e.g. "no transaction is active") are intentionally
				// swallowed here: if BEGIN itself succeeded but fn threw, we always
				// attempt a ROLLBACK as best-effort cleanup, but we surface the
				// original error to the caller regardless of whether it succeeds.
				await zone.exec("ROLLBACK").catch(() => {});
				throw error;
			}
		});
	}

	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#rejectPending(new Error("SQLiteWrapper is closed"));
		this.#readerPool?.close();
		this.#proc?.stdin?.destroy();
		this.#proc?.kill();
	}

	// ----------------------------
	// 队列系统
	// ----------------------------
	#enqueueSQL(sql, params, { isQuery, signal, txId = null }) {
		if (this.#closed) return Promise.reject(new Error("Cannot enqueue SQL on closed SQLiteWrapper"));

		if (signal?.aborted) {
			return Promise.reject(new AbortError(undefined, signal.reason));
		}

		const formatted = params.length === 0 && !sql.includes("?") ? sql : interpolateSQL(sql, params);

		return new Promise((resolve, reject) => {
			let abortHandler = null;

			// Acquire a task object from the pool (or allocate a new one).
			const task = this.#acquireTask();
			task.sql = formatted;
			task.isQuery = isQuery;
			task.txId = txId;
			task.restoredFromDeferred = false;
			task.dispatched = false;
			task.enqueuedAt = this.#onTiming ? performance.now() : 0;
			task.dispatchedAt = 0;
			task.timingEmitted = false;
			task.resolve = (...args) => {
				if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
				this.#emitTiming(task, "fulfilled");
				resolve(...args);
				this.#releaseTask(task);
			};
			task.reject = (...args) => {
				if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
				this.#emitTiming(task, "rejected");
				reject(...args);
				this.#releaseTask(task);
			};

			if (signal) {
				abortHandler = () => {
					if (!task.dispatched) {
						// Task may have been moved to the deferred queue; check both.
						if (!this.queue.remove(task)) {
							this.#deferredQueue.remove(task);
						}
						task.reject(new AbortError(undefined, signal.reason));
					}
				};
				signal.addEventListener("abort", abortHandler, { once: true });
			}

			this.queue.enqueue(task);
			if (this.queue.size === 1 && this.#inflight.length === 0 && !this.#isWaitingDrain && this.#queryInFlight === 0) {
				this.#pumpQueue();
			} else {
				this.#schedulePumpQueue();
			}
		});
	}

	// Acquire a task descriptor from the pool, or allocate a fresh plain object.
	#acquireTask() {
		return this.#taskPool.length > 0 ? this.#taskPool.pop() : {};
	}

	// Reset a task descriptor and return it to the pool for reuse.
	// Called at the end of task.resolve() and task.reject() wrappers.
	//
	// Closure-safety: the resolve and reject wrappers capture `task` by reference and
	// are stored on task.resolve / task.reject.  Setting both to null here breaks the
	// self-referential cycle before the object enters the pool.  The only other live
	// reference to the wrapper at this point is the caller's (e.g. #finalizeCurrent's
	// destructured `const { resolve, reject } = current`), which is a local variable
	// that goes out of scope immediately after the call returns — it is never stored
	// anywhere and cannot be reached once its enclosing frame exits.  There is therefore
	// no risk of the pooled object retaining or being aliased through stale closures.
	#releaseTask(task) {
		if (this.#taskPool.length >= TASK_POOL_MAX_SIZE) return;
		task.sql = null;
		task.isQuery = false;
		task.txId = null;
		task.restoredFromDeferred = false;
		task.dispatched = false;
		task.enqueuedAt = 0;
		task.dispatchedAt = 0;
		task.timingEmitted = false;
		task.resolve = null;
		task.reject = null;
		this.#taskPool.push(task);
	}

	#schedulePumpQueue() {
		if (this.#closed || this.#isPumpScheduled) return;
		this.#isPumpScheduled = true;

		queueMicrotask(() => {
			this.#isPumpScheduled = false;
			this.#pumpQueue();
		});
	}

	/**
	 * Pump queued SQL into sqlite stdin in batches.
	 *
	 * Notes on payload construction:
	 * - We keep using string payloads because stdin encoding is configured as utf-8,
	 *   so writing strings avoids extra Buffer/Uint8Array creation per batch.
	 * - In this path, Buffer/Uint8Array usually adds one more conversion/copy and
	 *   increases GC pressure under high-frequency writes.
	 * - #payloadParts is a class-level reusable array; resetting via .length = 0 avoids
	 *   per-pump allocation and keeps the backing slots warm for the JIT.
	 */
	#pumpQueue() {
		if (this.#closed || this.#isWaitingDrain || this.#queryInFlight > 0) return;

		const queue = this.queue;
		if (queue.isEmpty()) return;

		const inflight = this.#inflight;
		const maxInFlight = this.#maxInFlight;
		const maxBatchChars = this.#maxBatchChars;
		const debug = this.#logger?.debug;
		const activeId = this.#activeZoneId;

		// Reuse the class-level array to avoid per-pump allocation.
		const payloadParts = this.#payloadParts;
		payloadParts.length = 0;
		let payloadChars = 0;
		let inflightCount = inflight.length;

		if (activeId === null) {
			// Hot path: no exclusive zone active — skip all zone-deferral logic.
			while (!queue.isEmpty() && inflightCount < maxInFlight && payloadChars < maxBatchChars) {
				const nextTask = queue.peek();
				if (!nextTask) break;

				// Equivalent to the former early-return guard:
				// `if (inflight.length > 0 && queue.peek()?.isQuery) return;`
				if (nextTask.isQuery && inflightCount > 0) break;

				const task = queue.dequeue();
				const statement = normalizeSQL(task.sql);

				debug?.("Queue SQL for execution:", statement);
				task.dispatched = true;
				task.dispatchedAt = this.#onTiming ? performance.now() : 0;
				inflight.push(task);
				inflightCount++;

				if (task.isQuery) {
					this.#queryInFlight++;
				}

				payloadParts.push(statement, END_SIGNAL);
				payloadChars += statement.length + END_PACKET_CHARS;

				if (task.isQuery) break;
			}
		} else {
			// Slow path: exclusive zone active — defer tasks that don't belong to it.
			while (!queue.isEmpty() && inflightCount < maxInFlight && payloadChars < maxBatchChars) {
				const nextTask = queue.peek();
				if (!nextTask) break;

				// Defer any task that does not belong to the active zone.
				// Tasks restored from the deferred queue bypass this check.
				if (nextTask.txId !== activeId && !nextTask.restoredFromDeferred) {
					this.#deferredQueue.enqueue(queue.dequeue());
					continue;
				}

				if (nextTask.isQuery && inflightCount > 0) break;

				const task = queue.dequeue();
				const statement = normalizeSQL(task.sql);

				debug?.("Queue SQL for execution:", statement);
				task.dispatched = true;
				task.dispatchedAt = this.#onTiming ? performance.now() : 0;
				inflight.push(task);
				inflightCount++;

				if (task.isQuery) {
					this.#queryInFlight++;
				}

				payloadParts.push(statement, END_SIGNAL);
				payloadChars += statement.length + END_PACKET_CHARS;

				if (task.isQuery) break;
			}
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

	/**
	 * Append one stdout line for the current in-flight query.
	 * Non-query tasks do not need stdout payload accumulation.
	 * @param {string} line
	 */
	#appendStdoutLine(current, line) {
		if (!current?.isQuery) return;

		this.#stdoutResult.push(line);
	}

	/**
	 * Append one stderr line for current in-flight task.
	 * @param {string} line
	 */
	#appendStderrLine(line) {
		this.#stderrResult.push(line);
	}

	/**
	 * Append stderr substring after index-based trim to avoid unnecessary full-string trim allocations.
	 * @param {string} source
	 * @param {number} start
	 * @param {number} endExclusive
	 * @param {boolean} hasInflight
	 */
	#appendStderrRange(source, start, endExclusive, hasInflight) {
		if (!hasInflight || start >= endExclusive) return;

		let s = start;
		let e = endExclusive;

		while (s < e) {
			const code = source.charCodeAt(s);
			if (code !== CHAR_SPACE && code !== CHAR_TAB && code !== CHAR_LF && code !== CHAR_CR) break;
			s++;
		}

		while (e > s) {
			const code = source.charCodeAt(e - 1);
			if (code !== CHAR_SPACE && code !== CHAR_TAB && code !== CHAR_LF && code !== CHAR_CR) break;
			e--;
		}

		if (s >= e) return;
		this.#appendStderrLine(source.slice(s, e));
	}

	#handleLine(line) {
		const current = this.#inflight[0];
		if (!current) return;

		if (END_MARKERS.has(line)) {
			if (current?.isQuery) {
				this.#scheduleFinalizeCurrent();
			} else {
				this.#finalizeCurrent();
			}
		} else {
			this.#appendStdoutLine(current, line);
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
		let chunkStart = 0;

		// Complete a partial line carried over from the previous chunk, if any.
		// We only concatenate the minimal prefix needed to finish that one line,
		// then scan the rest of `chunk` directly — avoiding the large
		// `remainder + chunk` string the original code allocated per event.
		if (this.#stdoutChunkRemainder) {
			const nlPos = chunk.indexOf("\n");
			if (nlPos === -1) {
				// No newline yet; keep accumulating the partial line.
				this.#stdoutChunkRemainder += chunk;
				return;
			}
			// Build just the first line: remainder + head of chunk up to (and including)
			// the newline, so the CR check can inspect both sides of the chunk boundary.
			const combined = this.#stdoutChunkRemainder + chunk.slice(0, nlPos + 1);
			const nl = combined.length - 1;
			const lineEnd = nl > 0 && combined.charCodeAt(nl - 1) === CHAR_CR ? nl - 1 : nl;
			this.#handleLine(combined.slice(0, lineEnd));
			this.#stdoutChunkRemainder = "";
			chunkStart = nlPos + 1;
		}

		// Scan the remainder of the chunk directly — no extra allocation.
		let pos = chunk.indexOf("\n", chunkStart);
		while (pos !== -1) {
			const lineEnd = pos > chunkStart && chunk.charCodeAt(pos - 1) === CHAR_CR ? pos - 1 : pos;
			this.#handleLine(chunk.slice(chunkStart, lineEnd));
			chunkStart = pos + 1;
			pos = chunk.indexOf("\n", chunkStart);
		}

		this.#stdoutChunkRemainder = chunk.slice(chunkStart);
	}

	#handleStderrChunk(chunk) {
		const hasInflight = this.#inflight.length > 0;
		let chunkStart = 0;

		// Same split-chunk optimization as #handleStdoutChunk: only concatenate the
		// minimal prefix needed to complete the partial line from the previous chunk.
		if (this.#stderrChunkRemainder) {
			const nlPos = chunk.indexOf("\n");
			if (nlPos === -1) {
				this.#stderrChunkRemainder += chunk;
				return;
			}
			const combined = this.#stderrChunkRemainder + chunk.slice(0, nlPos + 1);
			const nl = combined.length - 1;
			const lineEnd = nl > 0 && combined.charCodeAt(nl - 1) === CHAR_CR ? nl - 1 : nl;
			this.#appendStderrRange(combined, 0, lineEnd, hasInflight);
			this.#stderrChunkRemainder = "";
			chunkStart = nlPos + 1;
		}

		let pos = chunk.indexOf("\n", chunkStart);
		while (pos !== -1) {
			const lineEnd = pos > chunkStart && chunk.charCodeAt(pos - 1) === CHAR_CR ? pos - 1 : pos;
			this.#appendStderrRange(chunk, chunkStart, lineEnd, hasInflight);
			chunkStart = pos + 1;
			pos = chunk.indexOf("\n", chunkStart);
		}

		this.#stderrChunkRemainder = chunk.slice(chunkStart);
	}

	#flushStderrRemainder() {
		const normalized = this.#stderrChunkRemainder.trim();
		if (!normalized || this.#inflight.length === 0) return;

		this.#appendStderrLine(normalized);
		this.#stderrChunkRemainder = "";
	}

	/**
	 * Re-enqueue all deferred tasks back into the main queue with priority so they
	 * run before any new tasks but cannot be deferred again by the next transaction.
	 */
	#restoreDeferred() {
		if (this.#deferredQueue.isEmpty()) return;

		// Mark every deferred task before merging so the pump loop lets them through.
		for (const task of this.#deferredQueue) {
			task.restoredFromDeferred = true;
		}

		// Prepend deferred tasks before whatever is currently in the main queue,
		// preserving their original relative order.
		// prependAll() is O(n) and avoids an intermediate array allocation + repeated
		// enqueue() calls that the previous toArray()+clear()+enqueue loop required.
		this.queue.prependAll(this.#deferredQueue);
		this.#schedulePumpQueue();
	}

	#finalizeCurrent() {
		this.#flushStderrRemainder();
		const current = this.#inflight.shift();
		if (!current) return;

		const result = current.isQuery ? this.#stdoutResult.join(EOL).trim() : "";
		const error = this.#stderrResult.length > 0 ? this.#stderrResult.join(EOL).trim() : "";

		// Reuse the existing arrays to avoid repeated allocate/GC pressure under high-frequency queries.
		this.#stdoutResult.length = 0;
		this.#stderrResult.length = 0;
		if (current.isQuery) this.#queryInFlight--;
		const { resolve, reject } = current;

		if (error) {
			reject(new Error(error));
		} else {
			resolve(result);
		}
		this.#schedulePumpQueue();
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

		while (!this.#deferredQueue.isEmpty()) {
			const task = this.#deferredQueue.dequeue();
			task.reject(error);
		}

		this.#activeZoneId = null;
		this.#stdoutResult = [];
		this.#stdoutChunkRemainder = "";
		this.#stderrResult = [];
		this.#stderrChunkRemainder = "";
		this.#isWaitingDrain = false;
		this.#isFinalizeScheduled = false;
		this.#isPumpScheduled = false;
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

		const finishedAt = performance.now();
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

	#normalizePositiveInteger(value, fallback, name) {
		if (value === undefined) return fallback;
		if (!Number.isInteger(value) || value <= 0) {
			throw new TypeError(`${name} must be a positive integer`);
		}

		return value;
	}

	[Symbol.dispose]() {
		this.close();
	}
}
