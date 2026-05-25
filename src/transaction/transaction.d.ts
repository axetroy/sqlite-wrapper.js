/** 有效的事务隔离级别列表 */
export const VALID_TRANSACTION_MODES: readonly ["DEFERRED", "IMMEDIATE", "EXCLUSIVE"];

/**
 * 判断一个值是否为有效的事务隔离级别。
 *
 * @param value - 待判断的值
 * @returns 如果是 "DEFERRED"、"IMMEDIATE" 或 "EXCLUSIVE" 则返回 true
 */
export function isTransactionMode(value: unknown): boolean;

/** 事务句柄，在事务作用域内使用的执行接口 */
export interface TransactionHandle {
	execute(sql: string, params?: any[], options?: { timeout?: number }): Promise<void>;
	query<T = any>(sql: string, params?: any[], options?: { timeout?: number }): Promise<T[]>;
	stream<T = any>(sql: string, params?: any[], options?: { timeout?: number }): AsyncIterable<T>;
}

/**
 * 创建事务句柄。
 * 事务内所有语句都绑定到同一个 scopeId，强制走同一子进程执行。
 *
 * @param scopeId  - 事务作用域标识
 * @param executor - 底层执行器，需提供 enqueue 方法
 * @returns 事务句柄
 */
export function createTransactionHandle(
	scopeId: symbol,
	executor: {
		enqueue(kind: string, sql: string, params: any[], options: object, scopeId: symbol | null): Promise<any>;
	},
): TransactionHandle;
