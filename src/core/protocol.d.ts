/** 标记列名，用于在查询结果中插入结束标记行 */
export const TOKEN_COLUMN: "__sqlite_executor_token__";

/**
 * 构造发送给子进程的 payload 字符串。
 * 将 SQL 语句和 token 包装为 sqlite3 能够执行的格式，
 * 使结果末尾包含一个标记行用于判断查询是否结束。
 *
 * @param sql   - 原始 SQL 语句
 * @param token - 唯一标记值
 * @returns 组装后的 payload 字符串
 */
export function buildPayload(sql: string, token: string): string;

/**
 * 判断一个值是否为结束标记行。
 * 用于在解析查询结果时识别语句执行完毕的信号。
 *
 * @param value - 待判断的值（通常为对象行）
 * @param token - 期望的标记值
 * @returns 如果是标记行则返回 true
 */
export function isSentinelRow(value: unknown, token: string): boolean;
