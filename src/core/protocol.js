import { normalizeSQL } from "../utils/normalize.js";
import { TOKEN_COLUMN } from "../constants.js";

export { TOKEN_COLUMN } from "../constants.js";

/**
 * 构建发送给 sqlite3 进程的完整载荷。
 * 在原始 SQL 末尾追加一条 sentinel 查询，用于标记该任务输出的结束。
 *
 * @param {string} sql - 要执行的 SQL 语句（已规范化时设 skipNormalize=true）
 * @param {string} token - 唯一 sentinel token
 * @param {{ skipNormalize?: boolean }} [options]
 * @returns {string} 追加了 sentinel 查询后的完整载荷
 */
export function buildPayload(sql, token, { skipNormalize = false } = {}) {
	const normalized = skipNormalize ? sql : normalizeSQL(sql);
	const suffix = normalized.endsWith(";") ? "" : ";";
	// 模板字面量在 V8 中会优化为 join，保持原状即可
	return `${normalized}${suffix}\nSELECT '${token}' AS ${TOKEN_COLUMN};\n`;
}

/**
 * 判断 SQL 是否为事务控制语句（BEGIN / COMMIT / ROLLBACK）。
 * WAL batch 不应包裹事务控制语句，否则会破坏事务嵌套层级。
 * @param {string} sql
 * @returns {boolean}
 */
function isTransactionControl(sql) {
	const s = sql.trim().toUpperCase();
	return (
		s === "BEGIN" ||
		s === "BEGIN TRANSACTION" ||
		s === "COMMIT" ||
		s === "COMMIT TRANSACTION" ||
		s === "ROLLBACK" ||
		s === "ROLLBACK TRANSACTION" ||
		s.startsWith("BEGIN ") ||
		s.startsWith("COMMIT ") ||
		s.startsWith("ROLLBACK ")
	);
}

/**
 * 将一批任务合并为单个发送给 sqlite3 进程的载荷字符串。
 * 由 PipelineEngine 和 TaskWorker 共享，避免 25 行重复 payload 构建逻辑。
 *
 * 如果全是 execute 类型且数量 > 1，自动使用 WAL 批量优化：
 * 将多条 INSERT/UPDATE 用 BEGIN/COMMIT 包裹后再追加各自的 sentinel token。
 *
 * WAL batch 会自动跳过事务控制语句（BEGIN / COMMIT / ROLLBACK），
 * 避免 BEGIN/COMMIT 被 WAL batch 的 BEGIN/COMMIT 再次包裹导致事务嵌套异常。
 *
 * @param {Array<{ kind: string, sql: string, token: string }>} batch
 * @returns {string}
 */
export function buildBatchPayload(batch) {
	const useWalBatch =
		batch.length > 1 &&
		batch.every(t => t.kind === "execute" && !isTransactionControl(t.sql));
	if (useWalBatch) {
		const parts = ["BEGIN;\n"];
		for (const task of batch) {
			parts.push(task.sql, "\n");
		}
		parts.push("COMMIT;\n");
		for (const task of batch) {
			parts.push(`SELECT '${task.token}' AS ${TOKEN_COLUMN};\n`);
		}
		return parts.join("");
	}

	const parts = [];
	for (const task of batch) {
		parts.push(buildPayload(task.sql, task.token, { skipNormalize: true }));
	}
	return parts.join("");
}

/**
 * 通过原始字符串模式检测 sentinel 行，避免 JSON.parse。
 * sentinel 原始格式固定为 [{"__sqlite_executor_token__":"TOKEN"}]，
 * token 由 crypto.randomUUID() 生成（hex UUID，不含特殊 JSON 字符），
 * 因此精确字符串匹配即可安全判断。
 *
 * @param {string} raw - 流式解析器提取的原始 JSON 文本
 * @param {string} token - 当前任务的唯一 token
 * @returns {boolean}
 */
export function isSentinelRaw(raw, token) {
	return raw === `[{"${TOKEN_COLUMN}":"${token}"}]`;
}

/**
 * 检查解析出的 JSON 行是否为当前任务的 sentinel 结束标记行。
 *
 * @param {unknown} value - 已解析的 JSON 值
 * @param {string} token - 当前任务的唯一 token
 * @returns {boolean}
 */
export function isSentinelRow(value, token) {
	return Array.isArray(value) && value.length === 1 && value[0]?.[TOKEN_COLUMN] === token;
}
