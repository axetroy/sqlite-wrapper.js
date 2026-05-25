/** Metrics.snapshot() 返回的快照结构 */
export interface MetricsSnapshot {
	tasksTotal: number;
	tasksSuccess: number;
	tasksFailed: number;
	tasksTimeout: number;
	processRestarts: number;
	executeCount: number;
	queryCount: number;
	streamCount: number;
	avgQueryTime: number;
	qps: number;
	uptime: number;
}

/** 运行时指标收集器。 */
export declare class Metrics {
	get tasksTotal(): number;
	get tasksSuccess(): number;
	get tasksFailed(): number;
	get tasksTimeout(): number;
	get processRestarts(): number;
	get executeCount(): number;
	get queryCount(): number;
	get streamCount(): number;
	get totalDuration(): number;
	get startTime(): number;

	incrementTasksTotal(kind: "execute" | "query" | "stream"): void;
	incrementTasksSuccess(duration: number): void;
	incrementTasksFailed(): void;
	incrementTasksTimeout(): void;
	incrementProcessRestarts(): void;

	snapshot(): MetricsSnapshot;
}
