/**
 * 单个 sqlite3 子进程 Worker。
 *
 * 维护一个内部任务队列，按 FIFO 顺序依次执行。
 * 每个任务对应一条 SQL 语句，结果通过 Promise 回调返回。
 * 支持超时控制和自动重启。
 */
export class TaskWorker {
	/**
	 * @param options.binary            sqlite3 可执行文件路径
	 * @param options.database          数据库文件路径
	 * @param options.statementTimeout  单条语句超时（毫秒）
	 * @param options.logger            日志记录器
	 * @param options.name              Worker 名称，用于日志和调试
	 * @param options.initMode          子进程初始化模式（参考 ProcessManager）
	 */
	constructor(options: {
		binary: string;
		database: string;
		statementTimeout: number;
		logger?: import("./executor.js").Logger;
		name?: string;
		initMode?: "wal" | "none";
	});

	/** Worker 名称 */
	get name(): string;

	/** 当前是否空闲（无排队任务且无运行中的任务） */
	get idle(): boolean;

	/** 当前排队等待的语句数量 */
	get pendingStatements(): number;

	/**
	 * 加入一个任务到队列。
	 * @param config - 任务配置对象，包含 kind、sql、params、resolve、reject 等字段
	 */
	enqueue(config: object): void;

	/** 立即终止子进程，丢弃所有排队任务 */
	kill(): void;
}
