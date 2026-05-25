/// <reference lib="esnext" />

export { SQLiteExecutor } from "./core/executor.js";
export { Queue } from "./core/queue.js";
export { ProcessManager } from "./core/process.js";

export declare function escapeValue(value: any): string;
export declare function interpolateSQL(sql: string, params: any[]): string;
export declare function normalizeSQL(sql: string): string;
export declare function which(command: string): string | null;
export declare function generateToken(): string;
export declare function createTimeoutError(timeout: number, sql: string): Error;

export const DEFAULT_STATEMENT_TIMEOUT: 30000;
export const TOKEN_COLUMN: "__sqlite_executor_token__";
export const VALID_TRANSACTION_MODES: readonly ["DEFERRED", "IMMEDIATE", "EXCLUSIVE"];

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
}

export declare class SQLiteExecutor implements AsyncDisposable, Disposable {
	constructor(options?: SQLiteExecutorOptions);
	get pendingStatements(): number;
	execute(sql: string, params?: any[], options?: StatementOptions): Promise<void>;
	query<T = any>(sql: string, params?: any[], options?: StatementOptions): Promise<T[]>;
	queryStream<T = any>(sql: string, onRow: (row: T) => void, params?: any[], options?: StatementOptions): Promise<void>;
	transaction<T>(fn: (tx: TransactionHandle) => Promise<T>, options?: TransactionOptions): Promise<T>;
	close(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
	[Symbol.dispose](): void;
}
