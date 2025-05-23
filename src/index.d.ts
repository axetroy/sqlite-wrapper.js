export interface Logger {
	log(...messages: unknown[]): void;

	info(...messages: unknown[]): void;

	warn(...messages: unknown[]): void;

	error(...messages: unknown[]): void;

	debug(...messages: unknown[]): void;

	scope(name: string): Logger;
}

interface SQLiteWrapperOptions {
	dbPath?: string;
	logger?: Logger;
}

export declare class SQLiteWrapper {
	constructor(exePath: string, options?: SQLiteWrapperOptions);

	exec(sql: string, params?: any[]): Promise<void>;

	query(sql: string, params?: any[]): Promise<any[]>;

	close(): Promise<void>;
}
