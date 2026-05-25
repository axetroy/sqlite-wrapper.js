export function collectQueryRows(task: { rows: any[] }, parsed: any): void;
export function processStreamRows(task: { onRow: Function; consumerError?: Error | null }, parsed: any): void;
export function settleTask(
	task: any,
	error: Error | null,
	value: any,
	metrics?: import("./metrics.js").Metrics | null,
	options?: { resetRowParser?: boolean },
): void;
