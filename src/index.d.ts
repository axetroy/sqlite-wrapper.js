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

export declare class AbortError extends Error {
	readonly name: "AbortError";
	/** The reason provided to `AbortController.abort(reason)`, if any. */
	readonly reason: unknown;
	constructor(message?: string, reason?: unknown);
	/**
	 * Returns true if the given value is an AbortError (either an instance of
	 * AbortError or any error whose `.name` is "AbortError").
	 */
	static is(err: unknown): err is AbortError;
}

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

export interface RunResult {
	/** Number of rows affected by the last INSERT, UPDATE, or DELETE statement. */
	changes: number;
	/** Row ID of the last successful INSERT. 0 if no INSERT was performed. */
	lastInsertRowid: number;
}

/**
 * The isolation level for a transaction.
 * - `DEFERRED` (default): Acquires the lock lazily on first read/write.
 * - `IMMEDIATE`: Acquires a write lock immediately, blocking concurrent writers.
 * - `EXCLUSIVE`: Acquires the most exclusive lock, blocking all other connections.
 */
export type TransactionType = "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE";

/**
 * A restricted database handle passed to the `exclusive()` callback.
 * Only SQL issued through this handle will execute during the exclusive zone;
 * all other SQL is queued until the zone ends.
 * Exposes `exec`, `run`, and `query`. Does not expose `exclusive()` or
 * `transaction()` to prevent nesting.
 */
export interface ExclusiveZone {
	exec(sql: string, params?: any[], options?: SQLiteOperationOptions): Promise<void>;
	run(sql: string, params?: any[], options?: SQLiteOperationOptions): Promise<RunResult>;
	query<T = any>(sql: string, params?: any[], options?: SQLiteOperationOptions): Promise<T[]>;
}

/**
 * A restricted database handle passed to the `transaction()` callback.
 * Alias for `ExclusiveZone`.
 */
export type Transaction = ExclusiveZone;

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
	 * Executes a write SQL statement and returns execution metadata (affected rows and last insert rowid).
	 * Use for INSERT, UPDATE, or DELETE when you need to know how many rows were affected or what rowid was inserted.
	 * @param sql SQL statement to execute
	 * @param params Query parameters
	 * @param options Operation options
	 * @param options.signal AbortSignal to cancel the operation before it is dispatched
	 */
	run(sql: string, params?: any[], options?: SQLiteOperationOptions): Promise<RunResult>;

	/**
	 * Executes a SQL query and returns the result.
	 * @param sql SQL query to execute
	 * @param params Query parameters
	 * @param options Operation options
	 * @param options.signal AbortSignal to cancel the operation before it is dispatched
	 */
	query<T = any>(sql: string, params?: any[], options?: SQLiteOperationOptions): Promise<T[]>;

	/**
	 * Runs `fn` inside an exclusive zone.
	 *
	 * While the zone is active, only SQL issued through the provided `zone`
	 * handle is allowed to execute. Any other SQL (bare `exec`, `run`, `query`,
	 * or SQL from another `exclusive`/`transaction` call) is automatically
	 * queued and will execute after the zone ends.
	 *
	 * Concurrent calls are automatically serialized — they never interleave.
	 *
	 * The callback receives a restricted `zone` handle that exposes `exec`,
	 * `run`, and `query`. Do **not** call `db.exclusive()` or `db.transaction()`
	 * recursively inside the callback; doing so will deadlock.
	 *
	 * `transaction()` is built on top of `exclusive()` and wraps the zone body
	 * with `BEGIN … COMMIT / ROLLBACK`.
	 *
	 * @param fn Async callback that performs database work using `zone`
	 * @returns The value returned by `fn`
	 */
	exclusive<T = void>(fn: (zone: ExclusiveZone) => Promise<T>): Promise<T>;

	/**
	 * Runs `fn` inside a serialized transaction.
	 *
	 * Internally calls `exclusive()` and wraps the zone body with
	 * `BEGIN … COMMIT / ROLLBACK`.
	 *
	 * Concurrent calls are automatically queued and executed one at a time,
	 * so it is safe to call `transaction()` from multiple concurrent async
	 * contexts — they will never interleave.
	 *
	 * The callback receives a restricted `tx` handle that exposes `exec`,
	 * `run`, and `query`. Do **not** call `db.exclusive()` or `db.transaction()`
	 * recursively inside the callback; doing so will deadlock.
	 *
	 * @param fn Async callback that performs database work using `tx`
	 * @param type SQLite transaction isolation type (default: `"DEFERRED"`)
	 * @returns The value returned by `fn`
	 */
	transaction<T = void>(fn: (tx: Transaction) => Promise<T>, type?: TransactionType): Promise<T>;

	/**
	 * Closes the SQLite connection (Process).
	 */
	close(): void;

	[Symbol.dispose](): void;
}
