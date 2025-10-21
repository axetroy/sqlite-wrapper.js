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
	/** 数据库文件路径 */
	dbPath?: string;
	/** 日志记录器对象 */
	logger?: Logger;
	/** 操作超时时间（毫秒），默认不超时 */
	timeout?: number;
}

/**
 * 批量操作类型
 */
type BatchOperation = string | [sql: string, params?: any[]] | { sql: string; params?: any[] };

/**
 * SQLite 包装器类
 * 提供安全的 SQLite 进程管理和查询执行
 */
declare class SQLiteWrapper {
	/**
	 * 创建 SQLiteWrapper 实例
	 * @param sqlite3ExePath - SQLite3 可执行文件路径
	 * @param options - 配置选项
	 */
	constructor(sqlite3ExePath: string, options?: SQLiteWrapperOptions);

	/**
	 * 执行 SQL 语句（不返回结果）
	 * @param sql - SQL 语句
	 * @param params - 参数数组
	 * @returns Promise<string> 执行结果
	 * @example
	 * ```typescript
	 * await sqlite.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
	 * await sqlite.exec('INSERT INTO users (name) VALUES (?)', ['Alice']);
	 * ```
	 */
	exec(sql: string, params?: any[]): Promise<string>;

	/**
	 * 执行查询并返回 JSON 结果
	 * @param sql - SQL 查询语句
	 * @param params - 参数数组
	 * @returns Promise<any[]> 查询结果数组
	 * @example
	 * ```typescript
	 * const users = await sqlite.query('SELECT * FROM users WHERE age > ?', [18]);
	 * console.log(users); // [{ id: 1, name: 'Alice', age: 25 }, ...]
	 * ```
	 */
	query(sql: string, params?: any[]): Promise<any[]>;

	/**
	 * 批量执行多个操作
	 * @param operations - 操作数组，支持多种格式
	 * @returns Promise<any[]> 所有操作的结果数组
	 * @example
	 * ```typescript
	 * const results = await sqlite.batch([
	 *   'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)',
	 *   ['INSERT INTO users (name) VALUES (?)', ['Alice']],
	 *   { sql: 'INSERT INTO users (name) VALUES (?)', params: ['Bob'] }
	 * ]);
	 * ```
	 */
	batch(operations: BatchOperation[]): Promise<any[]>;

	/**
	 * 关闭 SQLite 包装器并清理资源
	 * @returns Promise<void>
	 * @example
	 * ```typescript
	 * await sqlite.close();
	 * ```
	 */
	close(): Promise<void>;

	/**
	 * 获取包装器是否已关闭
	 * @returns boolean 是否已关闭
	 * @example
	 * ```typescript
	 * if (sqlite.isClosed) {
	 *   console.log('SQLite wrapper is closed');
	 * }
	 * ```
	 */
	get isClosed(): boolean;

	/**
	 * 获取当前队列长度
	 * @returns number 等待执行的操作数量
	 * @example
	 * ```typescript
	 * console.log(`Queue length: ${sqlite.queueLength}`);
	 * ```
	 */
	get queueLength(): number;

	/**
	 * 异步资源清理（用于显式资源管理）
	 * @example
	 * ```typescript
	 * using sqlite = new SQLiteWrapper('sqlite3', { dbPath: 'test.db' });
	 * // 自动调用 [Symbol.asyncDispose]() 当离开作用域时
	 * ```
	 */
	[Symbol.asyncDispose](): Promise<void>;
}
