import { Queue } from "./queue.js";

/**
 * Escape a single SQL value.
 * @param value
 */
export declare function escapeValue(value: any): string;

/**
 * Escape SQL values in the given SQL string with the provided parameters.
 * @param sql
 * @param params
 */
export declare function interpolateSQL(sql: string, params: any[]): string;

export interface Logger {
	log(...messages: unknown[]): void;

	info(...messages: unknown[]): void;

	warn(...messages: unknown[]): void;

	error(...messages: unknown[]): void;

	debug(...messages: unknown[]): void;
}

export interface SQLiteWrapperTiming {
	sql: string;
	isQuery: boolean;
	status: "fulfilled" | "rejected";
	queueMs: number;
	runMs: number;
	totalMs: number;
}

export interface SQLiteWrapperOptions {
	dbPath?: string;
	logger?: Logger;
	onTiming?: (timing: SQLiteWrapperTiming) => void;
	maxInFlight?: number;
	maxBatchChars?: number;
}

export interface SQLiteOperationOptions {
	signal?: AbortSignal;
}

export declare class SQLiteWrapper implements Disposable {
	/**
	 * Queue for pending SQL queries
	 */
	queue: Queue

	/**
	 *
	 * @param exePath Path to the SQLite executable
	 * @param options Options for the SQLite wrapper
	 * @param options.dbPath Path to the SQLite database file
	 * @param options.logger Logger instance for logging
	 * @param options.onTiming Callback for per-SQL timing metrics
	 * @param options.maxInFlight Maximum number of inflight statements in one dispatch cycle
	 * @param options.maxBatchChars Maximum SQL payload size (characters) per write
	 */
	constructor(exePath: string, options?: SQLiteWrapperOptions);

	/**
	 * Get pending SQL queries in the queue.
	 */
	get pendingQueries(): number;


	/**
	 * Executes a SQL query.
	 * @param sql SQL query to execute
	 * @param params Query parameters
	 * @param options Operation options
	 * @param options.signal AbortSignal to cancel the operation before it is dispatched
	 */
	exec(sql: string, params?: any[], options?: SQLiteOperationOptions): Promise<void>;

	/**
	 * Executes a SQL query and returns the result.
	 * @param sql SQL query to execute
	 * @param params Query parameters
	 * @param options Operation options
	 * @param options.signal AbortSignal to cancel the operation before it is dispatched
	 */
	query<T = any>(sql: string, params?: any[], options?: SQLiteOperationOptions): Promise<T[]>;

	/**
	 * Closes the SQLite connection (Process).
	 */
	close(): void;

	[Symbol.dispose](): void;
}
