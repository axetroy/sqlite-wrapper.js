/**
 * 替换 SQL 语句中的 `?` 占位符为转义后的参数值。
 *
 * @param sql    - 包含 `?` 占位符的 SQL 模板
 * @param params - 要插值的参数数组
 * @returns 插值后的完整 SQL 字符串
 */
export function interpolateSQL(sql: string, params: any[]): string;
