import { ProcessManager } from "./process.js";
import { Metrics } from "./metrics.js";
import { Queue } from "./queue.js";

/** PipelineEngine 的构造选项 */
export interface PipelineEngineOptions {
	/** 运行时指标收集器 */
	metrics: Metrics;
	/** 单条语句超时时间（毫秒） */
	statementTimeout: number;
	/** 日志记录器（仅使用 error 级别） */
	logger?: { error?: (...args: any[]) => void };
	/** 管线化批量大小，控制一次 stdin.write 合并几条语句，默认 10 */
	batchSize?: number;
	/** 任务超时时的回调 */
	onTaskTimeout?: (task: any) => void;
}

/**
 * 管线化引擎。
 *
 * 核心调度组件，管理子进程的输入输出：
 * - 将任务的 SQL payload 批量写入子进程 stdin（管线化）
 * - 从 stdout 读取结果并路由到对应任务的 resolve/reject
 * - 处理超时、错误、进程输出分割与解析
 *
 * 内部维护 mainQueue（待发送队列）和 inflight 计数器。
 */
export declare class PipelineEngine {
	constructor(processManager: ProcessManager, options: PipelineEngineOptions);

	/** 主任务队列（待发送到子进程的任务列表） */
	get mainQueue(): Queue;

	/** 当前排队等待和正在执行的总语句数 */
	get pendingStatements(): number;

	/**
	 * 向引擎的缓冲区追加原始数据。
	 * 数据通常来自子进程的 stdout/stderr。
	 *
	 * @param raw - 原始数据块
	 */
	feed(raw: string): void;

	/**
	 * 泵送逻辑：将 mainQueue 中的任务批量写入子进程 stdin。
	 * 受 inflight 上限和 batchSize 控制，不会无限发送。
	 */
	pump(): void;

	/** 激活引擎，开始处理队列中的任务。 */
	activate(): void;

	/** 停用引擎，暂停处理新任务。 */
	deactivate(): void;

	/**
	 * 将任务加入主队列并触发泵送。
	 *
	 * @param task - 任务配置对象（包含 kind、sql、timeout、resolve、reject 等）
	 */
	enqueue(task: any): void;

	/**
	 * 处理子进程 stdout 数据块。
	 * 分割数据、解析 JSON 行、匹配 sentinel token 完成任务。
	 *
	 * @param chunk - stdout 数据块
	 */
	handleStdoutChunk(chunk: string): void;

	/**
	 * 处理子进程 stderr 数据块。
	 * 通常用于日志和调试信息。
	 *
	 * @param chunk - stderr 数据块
	 */
	handleStderrChunk(chunk: string): void;

	/**
	 * 拒绝所有尚未完成的任务。
	 * 通常在进程崩溃或主动关闭时调用。
	 *
	 * @param error - 拒绝原因
	 */
	rejectAll(error: Error): void;

	/** 销毁引擎，释放所有资源。 */
	kill(): void;
}
