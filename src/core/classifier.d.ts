/**
 * 对 SQL 语句进行分类，判断它是只读还是写入操作。
 *
 * 分类规则：
 * - 以 SELECT / WITH / VALUES / EXPLAIN 开头 → `"read"`
 * - 其余（INSERT、UPDATE、CREATE、DELETE 等）→ `"write"`
 * - 多语句（以 `;` 分隔）中若包含任意写语句，整体返回 `"write"`
 * - 空字符串或非字符串输入返回 `"write"`
 *
 * @param sql - 要分类的 SQL 语句
 * @returns `"read"` 或 `"write"`
 */
export function classifySQL(sql: string): "read" | "write";
