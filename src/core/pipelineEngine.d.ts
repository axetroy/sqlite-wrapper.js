import { ProcessManager } from "./process.js";
import { Metrics } from "./metrics.js";
import { Queue } from "./queue.js";

export interface PipelineEngineOptions {
	metrics: Metrics;
	statementTimeout: number;
	logger?: { error?: (...args: any[]) => void };
	batchSize?: number;
	onTaskTimeout?: (task: any) => void;
}

export declare class PipelineEngine {
	constructor(processManager: ProcessManager, options: PipelineEngineOptions);

	get mainQueue(): Queue;
	get pendingStatements(): number;

	feed(raw: string): void;
	pump(): void;
	activate(): void;
	deactivate(): void;
	enqueue(task: any): void;
	handleStdoutChunk(chunk: string): void;
	handleStderrChunk(chunk: string): void;
	rejectAll(error: Error): void;
	kill(): void;
}
