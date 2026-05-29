/**
 * 规范化 SQL 语句：移除多余空白、注释、重复分号，并确保末尾有分号。
 *
 * @param sql - 原始 SQL 语句
 * @returns 规范化后的 SQL 语句
 */
export function normalizeSQL(sql: string): string;

export interface SQLTemplate {
	/** 规范化后的完整 SQL 字符串 */
	normalized: string;
	/**
	 * 以 `?` 为分隔符的片段数组。
	 * - segments[0] 为第一个 `?` 之前的部分
	 * - segments[n] 为第 n 个 `?` 之后、第 n+1 个 `?` 之前的部分
	 * - 最后一个元素为最后一个 `?` 之后的部分
	 * - 无 `?` 时 segments 为 [normalized]
	 */
	segments: string[];
	/** `?` 占位符的数量 */
	paramCount: number;
}

/**
 * 单次扫描同时完成 SQL 规范化和 `?` 占位符追踪。
 * 避免 `normalizeSQL` + `_parseTemplate` 两次扫描的重复开销。
 *
 * @param sql - 原始 SQL 语句
 * @returns 包含规范化结果和占位符信息的模板对象
 */
export function normalizeSQLTemplate(sql: string): SQLTemplate;
