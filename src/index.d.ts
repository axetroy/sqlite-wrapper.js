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

export interface SQLiteWrapperOptions {
	dbPath?: string;
	logger?: Logger;
}

export declare class SQLiteWrapper {
	/**
	 *
	 * @param exePath Path to the SQLite executable
	 * @param options Options for the SQLite wrapper
	 * @param options.dbPath Path to the SQLite database file
	 * @param options.logger Logger instance for logging
	 */
	constructor(exePath: string, options?: SQLiteWrapperOptions);

	/**
	 * Executes a SQL query.
	 * @param sql SQL query to execute
	 * @param params Query parameters
	 */
	exec(sql: string, params?: any[]): Promise<void>;

	/**
	 * Executes a SQL query and returns the result.
	 * @param sql SQL query to execute
	 * @param params Query parameters
	 */
	query<T = any>(sql: string, params?: any[]): Promise<T[]>;

	/**
	 * Closes the SQLite connection (Process).
	 */
	close(): Promise<void>;
}
