export class ReaderPool {
	constructor(options: {
		binary: string;
		database: string;
		poolSize: number;
		statementTimeout: number;
		logger?: import("./executor.js").Logger;
	});
	get size(): number;
	get pendingStatements(): number;
	enqueue(task: object): void;
	kill(): void;
}
