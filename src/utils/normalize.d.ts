/**
 * 规范化 SQL 语句：移除多余空白、注释、重复分号，并确保末尾有分号。
 *
 * @param sql - 原始 SQL 语句
 * @returns 规范化后的 SQL 语句
 */
export function normalizeSQL(sql: string): string;
