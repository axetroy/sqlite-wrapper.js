import { ChildProcess } from "node:child_process";

/**
 * sqlite3 子进程管理器。
 * 封装 spawn、stdin 写入和进程销毁，提供统一的进程生命周期管理。
 */
export declare class ProcessManager {
	/**
	 * @param options.binary   sqlite3 可执行文件路径
	 * @param options.database 数据库文件路径，不传则不打开数据库
	 * @param options.initMode 初始化模式
	 *   - `"wal"` （默认）：启动时通过 `-cmd` 设置 WAL 模式 + busy_timeout
	 *   - `"none"`：不添加任何初始化参数（适用于 reader，直接继承数据库已有 WAL 模式）
	 * @param options.onDrain  drain 回调，当 stdin pipe 重新可写时调用
	 */
	constructor(options?: {
		binary?: string;
		database?: string;
		initMode?: "wal" | "none";
		onDrain?: () => void;
	});

	/** 当前使用的 sqlite3 可执行文件路径 */
	get binary(): string;

	/** 底层子进程实例，未启动时为 null */
	get process(): ChildProcess | null;

	/**
	 * drain 状态，true 表示 OS pipe 已满，应暂停写入 stdin。
	 * 当 pipe 重新可写时 drain 事件触发，draining 恢复为 false。
	 */
	get draining(): boolean;

	/**
	 * 启动子进程（json 模式），返回 ChildProcess 实例。
	 * @throws {Error} 如果 binary 路径为空或文件不存在
	 */
	start(): ChildProcess;

	/** 向子进程的 stdin 写入数据 */
	write(data: string): void;

	/** 注册 drain 回调，当 pipe 重新可写时被调用。 */
	setOnDrainCallback(fn: () => void): void;

	/**
	 * 终止子进程。
	 * 先尝试 SIGTERM，3 秒后未退出则 SIGKILL。
	 * 返回被终止的 ChildProcess 或 null。
	 */
	kill(): ChildProcess | null;
}
