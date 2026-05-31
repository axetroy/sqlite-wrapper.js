/**
 * 轻量级运行时指标收集器。
 * 用于追踪 SQL 执行任务的吞吐、耗时、错误、超时和进程重启。
 *
 * 设计原则：
 * - 仅使用数字计数器，避免高频路径上的对象分配
 * - 所有 increment 方法 O(1)、无 throw
 * - 可被多个 TaskWorker / Executor 共享（通过引用传递）
 */
export class Metrics {
	#tasksTotal = 0;
	#tasksSuccess = 0;
	#tasksFailed = 0;
	#tasksTimeout = 0;
	#processRestarts = 0;
	#executeCount = 0;
	#queryCount = 0;
	#streamCount = 0;
	#totalDuration = 0;
	#startTime = Date.now();

	get tasksTotal() {
		return this.#tasksTotal;
	}

	get tasksSuccess() {
		return this.#tasksSuccess;
	}

	get tasksFailed() {
		return this.#tasksFailed;
	}

	get tasksTimeout() {
		return this.#tasksTimeout;
	}

	get processRestarts() {
		return this.#processRestarts;
	}

	get executeCount() {
		return this.#executeCount;
	}

	get queryCount() {
		return this.#queryCount;
	}

	get streamCount() {
		return this.#streamCount;
	}

	/** 累计任务耗时（毫秒），用于计算 avgQueryTime。 */
	get totalDuration() {
		return this.#totalDuration;
	}

	/** Metrics 实例的创建时间（Unix 时间戳）。 */
	get startTime() {
		return this.#startTime;
	}

	/**
	 * 记录一个任务入队。
	 * @param {"execute" | "query" | "stream"} kind
	 */
	incrementTasksTotal(kind) {
		this.#tasksTotal++;
		if (kind === "execute") this.#executeCount++;
		else if (kind === "query") this.#queryCount++;
		else if (kind === "stream") this.#streamCount++;
	}

	/**
	 * 记录一个任务成功完成。
	 * @param {number} duration 实际执行耗时（毫秒）
	 */
	incrementTasksSuccess(duration) {
		this.#tasksSuccess++;
		this.#totalDuration += duration;
	}

	/** 记录一个任务失败。 */
	incrementTasksFailed() {
		this.#tasksFailed++;
	}

	/** 记录一个任务超时。 */
	incrementTasksTimeout() {
		this.#tasksTimeout++;
	}

	/** 记录 sqlite3 进程重启次数。 */
	incrementProcessRestarts() {
		this.#processRestarts++;
	}

	/**
	 * 返回当前所有指标的只读快照。
	 * @returns {{
	 *   tasksTotal: number,
	 *   tasksSuccess: number,
	 *   tasksFailed: number,
	 *   tasksTimeout: number,
	 *   processRestarts: number,
	 *   executeCount: number,
	 *   queryCount: number,
	 *   streamCount: number,
	 *   avgTaskDuration: number,
	 *   throughput: number,
	 *   uptime: number,
	 * }}
	 */
	snapshot() {
		const elapsed = (Date.now() - this.#startTime) / 1000;
		return {
			tasksTotal: this.#tasksTotal,
			tasksSuccess: this.#tasksSuccess,
			tasksFailed: this.#tasksFailed,
			tasksTimeout: this.#tasksTimeout,
			processRestarts: this.#processRestarts,
			executeCount: this.#executeCount,
			queryCount: this.#queryCount,
			streamCount: this.#streamCount,
			avgTaskDuration: this.#tasksSuccess > 0 ? (this.#totalDuration / this.#tasksSuccess) : 0,
			throughput: elapsed > 0 ? (this.#tasksTotal / elapsed) : 0,
			uptime: elapsed,
		};
	}
}
