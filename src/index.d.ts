export declare class SQLiteWrapper {
	constructor(exePath: string, dbPath: string);

	exec(sql: string, params?: any[]): Promise<void>;

	query(sql: string, params?: any[]): Promise<any[]>;

	close(): Promise<void>;
}
