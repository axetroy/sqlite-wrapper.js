/** 默认语句超时时间 30 秒 */
export const DEFAULT_STATEMENT_TIMEOUT: 30000;

/**
 * 创建包含 SQL 上下文的超时错误。
 *
 * @param timeout - 超时时间（毫秒）
 * @param sql     - 超时发生时正在执行的 SQL 语句
 * @returns 包含超时时间和 SQL 信息的 Error 实例
 */
export function createTimeoutError(timeout: number, sql: string): Error;
