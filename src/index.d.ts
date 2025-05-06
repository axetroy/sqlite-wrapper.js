export declare class SQLiteWrapper {
	constructor(exePath: string, dbPath: string);

	exec(sql: string): Promise<void>;

	query(sql: string): Promise<any[]>;

	close(): Promise<void>;
}
