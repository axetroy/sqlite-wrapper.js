/** Metrics.snapshot() 返回的快照结构 */
export interface MetricsSnapshot {
	/** 总任务数 */
	tasksTotal: number;
	/** 成功任务数 */
	tasksSuccess: number;
	/** 失败任务数 */
	tasksFailed: number;
	/** 超时任务数 */
	tasksTimeout: number;
	/** 子进程重启次数 */
	processRestarts: number;
	/** execute 操作执行次数 */
	executeCount: number;
	/** query 操作执行次数 */
	queryCount: number;
	/** stream 操作执行次数 */
	streamCount: number;
	/** 所有成功任务的平均耗时（毫秒） */
	avgTaskDuration: number;
	/** 每秒处理任务数（含 execute/query/stream） */
	throughput: number;
	/** 运行时长（秒） */
	uptime: number;
}

/**
 * 运行时指标收集器。
 *
 * 追踪 SQL 执行任务的吞吐、耗时、错误、超时和进程重启。
 * 可通过 `snapshot()` 获取当前快照用于监控和告警。
 */
export declare class Metrics {
	/** 总任务数 */
	get tasksTotal(): number;
	/** 成功任务数 */
	get tasksSuccess(): number;
	/** 失败任务数 */
	get tasksFailed(): number;
	/** 超时任务数 */
	get tasksTimeout(): number;
	/** 子进程重启次数 */
	get processRestarts(): number;
	/** execute 操作执行次数 */
	get executeCount(): number;
	/** query 操作执行次数 */
	get queryCount(): number;
	/** stream 操作执行次数 */
	get streamCount(): number;
	/** 所有成功任务的总耗时（毫秒） */
	get totalDuration(): number;
	/** Metrics 实例的创建时间戳 */
	get startTime(): number;

	/**
	 * 增加任务总数计数。
	 *
	 * @param kind - 任务类型：execute（写操作）、query（查询）、stream（流式查询）
	 */
	incrementTasksTotal(kind: "execute" | "query" | "stream"): void;

	/**
	 * 增加成功任务计数，并累加耗时。
	 *
	 * @param duration - 任务执行耗时（毫秒）
	 */
	incrementTasksSuccess(duration: number): void;

	/** 增加失败任务计数。 */
	incrementTasksFailed(): void;

	/** 增加超时任务计数。 */
	incrementTasksTimeout(): void;

	/** 增加子进程重启次数计数。 */
	incrementProcessRestarts(): void;

	/**
	 * 获取当前运行时指标快照。
	 *
	 * @returns 当前所有指标的汇总快照
	 */
	snapshot(): MetricsSnapshot;
}
