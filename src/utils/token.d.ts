/**
 * 生成一次性的唯一标记字符串。
 * 用于标记查询结果末尾，格式为 `__executor_end__<timestamp>_<random>`。
 *
 * @returns 唯一的标记字符串
 */
export function generateToken(): string;
