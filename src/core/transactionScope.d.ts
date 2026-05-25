import { Queue } from "./queue.js";

export interface TransactionScopeResult {
	scopeId: symbol;
	release: () => void;
}

export class TransactionScope {
	get scopeId(): symbol | null;
	get active(): boolean;
	get pendingStatements(): number;

	isDeferred(scopeId: symbol | null): boolean;
	defer(task: any): void;
	enter(): Promise<TransactionScopeResult>;
	exit(): void;
	restoreDeferred(targetQueue: Queue): void;
	rejectAll(error: Error): void;
}
