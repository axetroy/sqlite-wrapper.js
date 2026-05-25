export interface Logger {
	log?(...messages: unknown[]): void;
	info?(...messages: unknown[]): void;
	warn?(...messages: unknown[]): void;
	error?(...messages: unknown[]): void;
	debug?(...messages: unknown[]): void;
}

export interface SQLiteExecutorOptions {
	binary?: string;
	database?: string;
	logger?: Logger;
	statementTimeout?: number;
	autoRestart?: boolean;
}

export interface StatementOptions {
	timeout?: number;
}

export interface TransactionOptions {
	mode?: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE";
}

export interface TransactionHandle {
	execute(sql: string, params?: any[], options?: StatementOptions): Promise<void>;
	query<T = any>(sql: string, params?: any[], options?: StatementOptions): Promise<T[]>;
	queryStream<T = any>(sql: string, onRow: (row: T) => void, params?: any[], options?: StatementOptions): Promise<void>;
	stream<T = any>(sql: string, params?: any[], options?: StatementOptions): AsyncIterable<T>;
}

export declare class SQLiteExecutor implements AsyncDisposable, Disposable {
	constructor(options?: SQLiteExecutorOptions);
	get pendingStatements(): number;
	execute(sql: string, params?: any[], options?: StatementOptions): Promise<void>;
	query<T = any>(sql: string, params?: any[], options?: StatementOptions): Promise<T[]>;
	queryStream<T = any>(sql: string, onRow: (row: T) => void, params?: any[], options?: StatementOptions): Promise<void>;
	stream<T = any>(sql: string, params?: any[], options?: StatementOptions): AsyncIterable<T>;
	transaction<T>(fn: (tx: TransactionHandle) => Promise<T>, options?: TransactionOptions): Promise<T>;
	close(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
	[Symbol.dispose](): void;
}
