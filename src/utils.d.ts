/**
 * 对 SQL 值进行转义，返回安全的 SQL 字符串字面量。
 * 处理字符串、数字、布尔、null、Buffer、Date 等常见类型。
 *
 * @param value - 要转义的值
 * @returns 转义后的 SQL 字符串字面量（包含引号）
 */
export function escapeValue(value: any): string;

/**
 * 将参数数组插值到 SQL 模板中（带自动转义）。
 * SQL 中使用 `$1`、`$2`、`$N` 作为占位符。
 *
 * @param sql    - 含占位符的 SQL 模板
 * @param params - 参数数组
 * @returns 插值后的完整 SQL
 */
export function interpolateSQL(sql: string, params: any[]): string;

/**
 * 规范化 SQL 语句，移除多余空白和注释。
 *
 * @param sql - 原始 SQL
 * @returns 规范化后的 SQL
 */
export function normalizeSQL(sql: string): string;
