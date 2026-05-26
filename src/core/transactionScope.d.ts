import { Queue } from "./queue.js";

/**
 * 事务作用域的进入结果。
 * - scopeId：唯一作用域标识符
 * - release：释放作用域锁定的回调
 */
export interface TransactionScopeResult {
	/** 事务作用域的唯一标识符号 */
	scopeId: symbol;
	/** 释放事务作用域锁，允许后续任务继续执行 */
	release: () => void;
}

/**
 * 事务作用域管理器。
 *
 * 确保事务内的所有 SQL 操作绑定到同一个子进程（通过 scopeId），
 * 避免在读写分离模式下事务内的读操作被分发到其他进程。
 *
 * 实现原理：
 * - 事务开始前调用 `enter()` 获取 scopeId，后续所有语句携带该 scopeId
 * - 事务外的语句不携带 scopeId（scopeId 为 null），可由任务调度器自由分发
 * - 事务内的语句暂存（defer）到独立的队列，事务结束后恢复（restoreDeferred）
 */
export class TransactionScope {
	/** 当前作用域标识，无活跃事务时为 null */
	get scopeId(): symbol | null;

	/** 是否有活跃的事务正在执行 */
	get active(): boolean;

	/** 事务队列中等待执行的语句数量 */
	get pendingStatements(): number;

	/**
	 * 判断给定的 scopeId 是否与当前事务作用域匹配。
	 * scopeId 为 null 表示不在事务中，返回 true。
	 *
	 * @param scopeId - 待判断的作用域标识
	 * @returns 如果匹配或传入 null 则返回 true
	 */
	isDeferred(scopeId: symbol | null): boolean;

	/**
	 * 将任务暂存到事务延迟队列。
	 * 事务提交前不会实际执行这些任务。
	 *
	 * @param task - 待暂存的任务对象
	 */
	defer(task: any): void;

	/**
	 * 进入事务作用域。
	 * 锁定一个 scopeId，后续所有语句将被关联到该作用域。
	 * 同时暂停主队列的正常分发，将新语句转入 defer 队列。
	 *
	 * @returns 包含 scopeId 和 release 回调的结果对象
	 */
	enter(): Promise<TransactionScopeResult>;

	/**
	 * 退出事务作用域。
	 * 将 defer 队列中的任务恢复到目标队列，然后清空作用域。
	 */
	exit(): void;

	/**
	 * 恢复之前暂存（defer）的所有任务到目标队列。
	 * 通常在事务提交后调用。
	 *
	 * @param targetQueue - 接收暂存任务的目标队列
	 */
	restoreDeferred(targetQueue: Queue): void;

	/**
	 * 拒绝事务作用域内所有暂存的任务。
	 * 通常在事务回滚或发生错误时调用。
	 *
	 * @param error - 拒绝原因
	 */
	rejectAll(error: Error): void;
}
