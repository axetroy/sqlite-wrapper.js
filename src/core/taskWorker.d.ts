export class TaskWorker {
	constructor(options: {
		binary: string;
		database: string;
		statementTimeout: number;
		logger?: import("./executor.js").Logger;
		name?: string;
		initMode?: "wal" | "none";
	});
	get name(): string;
	get idle(): boolean;
	get pendingStatements(): number;
	enqueue(config: object): void;
	kill(): void;
}
