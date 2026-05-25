import { ProcessManager } from "./process.js";
import { Queue } from "./queue.js";
import { createJsonValueParser, toError } from "./parser.js";
import { setupStreamParser } from "../stream/queryStream.js";
import { isSentinelRow, buildPayload } from "./protocol.js";
import { createTimeoutError } from "../utils/timeout.js";

/**
 * 单个 sqlite3 进程的任务执行器。
 * 内部维护一个串行 Queue，依次执行任务并解析 stdout 输出。
 *
 * TaskWorker 不关心任务是读还是写——它只负责发送 SQL、解析输出、完成 Promise。
 * 由上层（SQLiteExecutor / ReaderPool）决定如何分发任务。
 */
export class TaskWorker {
	#processManager;
	#queue = new Queue();
	#currentTask = null;
	#statementTimeout;
	#logger;
	#name;

	/**
	 * @param {{
	 *   binary: string
	 *   database: string
	 *   statementTimeout: number
	 *   logger?: import("../index.js").Logger
	 *   name?: string
	 * }} options
	 */
	constructor({ binary, database, statementTimeout, logger, name, initMode }) {
		this.#name = name ?? "worker";
		this.#statementTimeout = statementTimeout;
		this.#logger = logger;
		this.#processManager = new ProcessManager({ binary, database, initMode });
		this.#startProcess();
	}

	get name() {
		return this.#name;
	}

	get idle() {
		return this.#currentTask === null && this.#queue.isEmpty();
	}

	get pendingStatements() {
		return this.#queue.size + (this.#currentTask ? 1 : 0);
	}

	/**
	 * 接收一个任务配置并加入队列。
	 * 任务配置应包含：kind, sql, timeout, token, resolve, reject, onRow
	 * 内部会自动创建 valueParser 和 rowParser。
	 * @param {object} config
	 */
	enqueue(config) {
		const task = {
			kind: config.kind,
			sql: config.sql,
			timeout: config.timeout,
			token: config.token,
			rows: [],
			resolve: config.resolve,
			reject: config.reject,
			onRow: config.onRow ?? null,
			consumerError: null,
			stderrText: "",
			errorScheduled: false,
			timer: null,
			valueParser: null,
			rowParser: null,
		};

		task.valueParser = createJsonValueParser((raw) => {
			this.#handleJsonValue(task, raw);
		});

		task.rowParser = setupStreamParser(task);

		this.#queue.enqueue(task);
		this.#pumpQueue();
	}

	/** 终止进程并清理。 */
	kill() {
		this.#rejectQueues(new Error(`${this.#name} is killed`));
		this.#processManager.kill();
	}

	// ---- 内部 ----

	#startProcess() {
		const proc = this.#processManager.start();

		proc.stdout.on("data", (chunk) => {
			this.#handleStdoutChunk(chunk);
		});

		proc.stderr.on("data", (chunk) => {
			this.#handleStderrChunk(chunk);
		});

		proc.on("error", (error) => {
			this.#logger?.error?.(`${this.#name} process error`, error);
			this.#rejectQueues(toError(error));
		});

		proc.on("close", (code, signal) => {
			const err = new Error(`${this.#name} exited unexpectedly (code=${code}, signal=${signal ?? "none"})`);
			this.#rejectQueues(err);
		});
	}

	#pumpQueue() {
		if (this.#currentTask || this.#queue.isEmpty()) return;
		const task = this.#queue.dequeue();
		if (!task) return;

		this.#currentTask = task;
		task.timer = setTimeout(() => {
			if (task !== this.#currentTask) return;
			this.#rejectCurrentTask(createTimeoutError(task.timeout, task.sql));
		}, task.timeout ?? this.#statementTimeout);

		this.#processManager.write(buildPayload(task.sql, task.token));
	}

	#handleStdoutChunk(chunk) {
		const task = this.#currentTask;
		if (!task) return;

		if (task.kind === "stream" && task.rowParser && !task.rowParser.finished) {
			const leftover = task.rowParser.feed(chunk);
			if (leftover) task.valueParser.feed(leftover);
			return;
		}

		task.valueParser.feed(chunk);
	}

	#handleStderrChunk(chunk) {
		const task = this.#currentTask;
		if (!task) {
			this.#logger?.error?.(String(chunk).trim());
			return;
		}
		task.stderrText += String(chunk);
	}

	/** @param {object} task */
	#handleJsonValue(task, raw) {
		if (task !== this.#currentTask) return;

		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			this.#finalizeTask(task, { error: new Error(`Invalid JSON from sqlite3: ${toError(error).message}`) });
			return;
		}

		if (isSentinelRow(parsed, task.token)) {
			if (task.stderrText) {
				this.#finalizeTask(task, { error: new Error(task.stderrText.trim()) });
				return;
			}

			if (task.consumerError) {
				this.#finalizeTask(task, { error: task.consumerError });
				return;
			}

			this.#scheduleFinalizeCheck(task);
			return;
		}

		if (task.kind === "query") {
			if (Array.isArray(parsed)) task.rows.push(...parsed);
			return;
		}

		if (task.kind === "stream") {
			if (!Array.isArray(parsed)) return;
			for (const row of parsed) {
				if (task.consumerError) break;
				try {
					task.onRow(row);
				} catch (error) {
					task.consumerError = toError(error);
				}
			}
		}
	}

	#scheduleFinalizeCheck(task) {
		if (task.errorScheduled) return;
		task.errorScheduled = true;
		setImmediate(() => {
			task.errorScheduled = false;
			if (task.stderrText) {
				this.#finalizeTask(task, { error: new Error(task.stderrText.trim()) });
				return;
			}

			if (task.consumerError) {
				this.#finalizeTask(task, { error: task.consumerError });
				return;
			}

			if (task.kind === "query") {
				this.#finalizeTask(task, { value: task.rows });
				return;
			}

			this.#finalizeTask(task, { value: undefined });
		});
	}

	/** @param {{ error?: Error | null, value?: any }} result */
	#finalizeTask(task, { error = null, value = undefined }) {
		if (task !== this.#currentTask) return;
		this.#settleTask(task, error, value);
		this.#currentTask = null;
		this.#pumpQueue();
	}

	#settleTask(task, error, value) {
		clearTimeout(task.timer);
		task.valueParser?.reset?.();
		task.rowParser?.reset?.();

		if (error) {
			task.reject(toError(error));
			return;
		}

		task.resolve(value);
	}

	#rejectCurrentTask(error) {
		if (!this.#currentTask) return;
		this.#settleTask(this.#currentTask, error, undefined);
		this.#currentTask = null;
		this.#pumpQueue();
	}

	#rejectQueues(error) {
		if (this.#currentTask) {
			this.#settleTask(this.#currentTask, error, undefined);
			this.#currentTask = null;
		}

		let queued = this.#queue.dequeue();
		while (queued) {
			this.#settleTask(queued, error, undefined);
			queued = this.#queue.dequeue();
		}
	}
}
