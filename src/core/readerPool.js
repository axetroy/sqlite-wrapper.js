import { TaskWorker } from "./taskWorker.js";

/**
 * 读取器连接池。
 * 维护多个 TaskWorker 实例，每个连接一个独立的 sqlite3 进程。
 * 通过 round-robin 分发只读任务，实现并发读取。
 */
export class ReaderPool {
	#workers = [];
	#rrIndex = 0;

	/**
	 * @param {{
	 *   binary: string
	 *   database: string
	 *   poolSize: number
	 *   statementTimeout: number
	 *   logger?: import("../index.js").Logger
	 *   metrics?: import("./metrics.js").Metrics
	 * }} options
	 */
	constructor({ binary, database, poolSize, statementTimeout, logger, metrics }) {
		if (poolSize < 1) throw new RangeError("poolSize must be >= 1");
		for (let i = 0; i < poolSize; i++) {
			const worker = new TaskWorker({
				binary,
				database,
				statementTimeout,
				logger,
				metrics,
				name: `reader-${i}`,
				initMode: database !== ":memory:" ? "none" : "wal",
			});
			this.#workers.push(worker);
		}
	}

	get size() {
		return this.#workers.length;
	}

	get pendingStatements() {
		return this.#workers.reduce((sum, w) => sum + w.pendingStatements, 0);
	}

	/**
	 * Round-robin 选择一个 reader 并执行任务。
	 * @param {object} task
	 */
	enqueue(task) {
		const worker = this.#workers[this.#rrIndex % this.#workers.length];
		this.#rrIndex = (this.#rrIndex + 1) >>> 0;
		worker.enqueue(task);
	}

	/** 测试用：获取内部 worker 列表。 */
	get _workers() {
		return this.#workers;
	}

	/** 终止所有 reader 进程。 */
	kill() {
		for (const worker of this.#workers) {
			worker.kill();
		}
	}
}
