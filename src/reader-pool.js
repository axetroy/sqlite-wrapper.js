import { spawn } from "node:child_process";
import { EOL } from "node:os";
import { performance } from "node:perf_hooks";
import { END_SIGNAL, END_MARKERS } from "./constants.js";
import { Queue } from "./queue.js";
import { normalizeSQL } from "./utils.js";
import { AbortError } from "./errors.js";

const CHAR_LF = 10;
const CHAR_CR = 13;
const CHAR_SPACE = 32;
const CHAR_TAB = 9;

/**
 * 单个只读 sqlite3 进程，每次只执行一条查询语句。
 * 通过 onAvailable 回调通知进程池该 worker 已空闲。
 */
class ReaderWorker {
	#proc;
	#busy = false;
	#task = null;
	#stdoutResult = [];
	#stderrResult = [];
	#stdoutRemainder = "";
	#stderrRemainder = "";
	#isFinalizeScheduled = false;
	#closed = false;
	#onAvailable;
	#onFatalError;

	constructor(exePath, dbPath, { onAvailable, onFatalError } = {}) {
		this.#onAvailable = onAvailable;
		this.#onFatalError = onFatalError;
		this.#spawn(exePath, dbPath);
	}

	#spawn(exePath, dbPath) {
		const args = ["-cmd", ".mode json"];
		if (dbPath) args.push(dbPath);

		this.#proc = spawn(exePath, args, { stdio: "pipe" });
		this.#proc.stdin.setDefaultEncoding("utf-8");
		this.#proc.stdout.setEncoding("utf-8");
		this.#proc.stderr.setEncoding("utf-8");

		// 让读 worker 进程不阻止 Node.js 正常退出；
		// 显式调用 close() 时仍会通过 kill() 强制终止。
		this.#proc.unref();
		this.#proc.stdout.unref();
		this.#proc.stderr.unref();

		this.#proc.on("error", (err) => {
			if (!this.#closed) this.#onFatalError?.(err);
		});

		this.#proc.stdout.on("data", (chunk) => this.#handleStdoutChunk(chunk));
		this.#proc.stderr.on("data", (chunk) => this.#handleStderrChunk(chunk));

		this.#proc.on("close", () => {
			if (!this.#closed && this.#task) {
				this.#onFatalError?.(new Error("sqlite3 读取进程意外关闭"));
			}
		});
	}

	get isBusy() {
		return this.#busy;
	}

	get isClosed() {
		return this.#closed;
	}

	execute(task) {
		this.#busy = true;
		this.#task = task;
		task.dispatched = true;
		task.dispatchedAt = task.enqueuedAt > 0 ? performance.now() : 0;

		const statement = normalizeSQL(task.sql);
		const payload = statement + EOL + END_SIGNAL + EOL;
		this.#proc.stdin.write(payload);
	}

	close() {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#task) {
			const task = this.#task;
			this.#task = null;
			this.#busy = false;
			task.reject(new Error("读取 worker 已关闭"));
		}
		this.#proc?.stdin?.destroy();
		this.#proc?.stdout?.destroy();
		this.#proc?.stderr?.destroy();
		this.#proc?.kill();
	}

	#handleLine(line) {
		if (END_MARKERS.has(line)) {
			this.#scheduleFinalize();
		} else {
			this.#stdoutResult.push(line);
		}
	}

	#scheduleFinalize() {
		if (this.#isFinalizeScheduled) return;
		this.#isFinalizeScheduled = true;
		setImmediate(() => {
			this.#isFinalizeScheduled = false;
			this.#finalize();
		});
	}

	#finalize() {
		// 将 stderr 缓冲区中剩余内容刷入结果
		const normalized = this.#stderrRemainder.trim();
		if (normalized) this.#stderrResult.push(normalized);
		this.#stderrRemainder = "";

		const task = this.#task;
		if (!task) return;

		this.#task = null;
		this.#busy = false;

		const result = this.#stdoutResult.join(EOL).trim();
		const error = this.#stderrResult.length > 0 ? this.#stderrResult.join(EOL).trim() : "";

		this.#stdoutResult.length = 0;
		this.#stderrResult.length = 0;

		if (error) {
			task.reject(new Error(error));
		} else {
			task.resolve(result);
		}

		// 通知进程池该 worker 已空闲
		this.#onAvailable?.(this);
	}

	#handleStdoutChunk(chunk) {
		let chunkStart = 0;

		if (this.#stdoutRemainder) {
			const nlPos = chunk.indexOf("\n");
			if (nlPos === -1) {
				this.#stdoutRemainder += chunk;
				return;
			}
			const combined = this.#stdoutRemainder + chunk.slice(0, nlPos + 1);
			const nl = combined.length - 1;
			const lineEnd = nl > 0 && combined.charCodeAt(nl - 1) === CHAR_CR ? nl - 1 : nl;
			this.#handleLine(combined.slice(0, lineEnd));
			this.#stdoutRemainder = "";
			chunkStart = nlPos + 1;
		}

		let pos = chunk.indexOf("\n", chunkStart);
		while (pos !== -1) {
			const lineEnd = pos > chunkStart && chunk.charCodeAt(pos - 1) === CHAR_CR ? pos - 1 : pos;
			this.#handleLine(chunk.slice(chunkStart, lineEnd));
			chunkStart = pos + 1;
			pos = chunk.indexOf("\n", chunkStart);
		}

		this.#stdoutRemainder = chunk.slice(chunkStart);
	}

	#handleStderrChunk(chunk) {
		const hasTask = this.#task !== null;
		let chunkStart = 0;

		if (this.#stderrRemainder) {
			const nlPos = chunk.indexOf("\n");
			if (nlPos === -1) {
				this.#stderrRemainder += chunk;
				return;
			}
			const combined = this.#stderrRemainder + chunk.slice(0, nlPos + 1);
			const nl = combined.length - 1;
			const lineEnd = nl > 0 && combined.charCodeAt(nl - 1) === CHAR_CR ? nl - 1 : nl;
			if (hasTask) this.#appendStderrRange(combined, 0, lineEnd);
			this.#stderrRemainder = "";
			chunkStart = nlPos + 1;
		}

		let pos = chunk.indexOf("\n", chunkStart);
		while (pos !== -1) {
			const lineEnd = pos > chunkStart && chunk.charCodeAt(pos - 1) === CHAR_CR ? pos - 1 : pos;
			if (hasTask) this.#appendStderrRange(chunk, chunkStart, lineEnd);
			chunkStart = pos + 1;
			pos = chunk.indexOf("\n", chunkStart);
		}

		this.#stderrRemainder = chunk.slice(chunkStart);
	}

	#appendStderrRange(source, start, endExclusive) {
		if (start >= endExclusive) return;

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
		this.#stderrResult.push(source.slice(s, e));
	}
}

/**
 * 读进程池：管理 N 个只读 sqlite3 进程，并行处理查询请求。
 * 写操作（exec/run）及事务/排他区内的查询仍由主写进程处理。
 *
 * 使用条件：
 *  - 需要基于文件的数据库（dbPath 不为空且不为 :memory:）
 *  - 建议数据库已开启 WAL 模式，以最大化读写并发性能
 */
export class ReaderPool {
	#workers;
	#pendingQueue = new Queue();
	#closed = false;
	#onTiming;
	#logger;

	constructor(size, exePath, dbPath, { onTiming, logger } = {}) {
		this.#onTiming = onTiming;
		this.#logger = logger;
		this.#workers = Array.from(
			{ length: size },
			() =>
				new ReaderWorker(exePath, dbPath, {
					onAvailable: (worker) => this.#onWorkerAvailable(worker),
					onFatalError: (err) => this.#handleFatalError(err),
				}),
		);
	}

	/** 当前待处理任务数（包括正在执行中及排队中的） */
	get pendingCount() {
		return this.#pendingQueue.size + this.#workers.filter((w) => w.isBusy).length;
	}

	get isClosed() {
		return this.#closed;
	}

	/**
	 * 将查询请求路由到空闲 worker，若无空闲则入队等待。
	 * @param {string} sql 已插值的 SQL 字符串
	 * @param {object} [options]
	 * @param {AbortSignal} [options.signal]
	 * @param {number} [options.enqueuedAt] performance.now() 时的入队时间戳（用于计时）
	 */
	query(sql, { signal, enqueuedAt = 0 } = {}) {
		if (this.#closed) {
			return Promise.reject(new Error("读进程池已关闭，无法执行查询"));
		}

		if (signal?.aborted) {
			return Promise.reject(new AbortError(undefined, signal.reason));
		}

		return new Promise((resolve, reject) => {
			let abortHandler = null;

			const task = {
				sql,
				signal,
				enqueuedAt,
				dispatchedAt: 0,
				dispatched: false,
				timingEmitted: false,
				resolve: (raw) => {
					if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
					this.#emitTiming(task, "fulfilled");
					resolve(raw);
				},
				reject: (err) => {
					if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
					this.#emitTiming(task, "rejected");
					reject(err);
				},
			};

			if (signal) {
				abortHandler = () => {
					if (!task.dispatched) {
						this.#pendingQueue.remove(task);
						task.reject(new AbortError(undefined, signal.reason));
					}
				};
				signal.addEventListener("abort", abortHandler, { once: true });
			}

			const worker = this.#workers.find((w) => !w.isBusy && !w.isClosed);
			if (worker) {
				worker.execute(task);
			} else {
				this.#pendingQueue.enqueue(task);
			}
		});
	}

	close() {
		if (this.#closed) return;
		this.#closed = true;

		const error = new Error("读进程池已关闭");
		while (!this.#pendingQueue.isEmpty()) {
			const task = this.#pendingQueue.dequeue();
			task.reject(error);
		}

		for (const worker of this.#workers) {
			worker.close();
		}
	}

	#onWorkerAvailable(worker) {
		// 跳过已中止的任务
		while (!this.#pendingQueue.isEmpty()) {
			const peeked = this.#pendingQueue.peek();
			if (peeked.signal?.aborted) {
				this.#pendingQueue.dequeue();
				peeked.reject(new AbortError(undefined, peeked.signal.reason));
				continue;
			}
			break;
		}

		if (this.#pendingQueue.isEmpty()) return;
		const task = this.#pendingQueue.dequeue();
		worker.execute(task);
	}

	#handleFatalError(err) {
		if (this.#closed) return;
		this.#closed = true;
		this.#logger?.error("sqlite3 读取进程错误:", err);

		const error = new Error("sqlite3 reader process error: " + err.message, { cause: err });

		while (!this.#pendingQueue.isEmpty()) {
			const task = this.#pendingQueue.dequeue();
			task.reject(error);
		}

		for (const worker of this.#workers) {
			worker.close();
		}
	}

	#emitTiming(task, status) {
		if (!this.#onTiming || task.timingEmitted) return;
		task.timingEmitted = true;

		const finishedAt = performance.now();
		const dispatchedAt = task.dispatchedAt || finishedAt;
		const queueMs = Math.max(0, Math.round(dispatchedAt - task.enqueuedAt));
		const runMs = Math.max(0, Math.round(finishedAt - dispatchedAt));
		const totalMs = queueMs + runMs;

		this.#onTiming({
			sql: task.sql,
			isQuery: true,
			status,
			queueMs,
			runMs,
			totalMs,
		});
	}
}
