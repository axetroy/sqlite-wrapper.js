/// <reference lib="esnext" />

/**
 * 主控制器，管理 sqlite3 子进程，提供 execute/query/stream/transaction 等 API。
 * 当 `database` 为文件路径且 `poolSize > 0` 时，自动启用读写分离：
 * - 读操作（SELECT/WITH/VALUES/EXPLAIN）路由到 ReaderPool 中的空闲 worker
 * - 写操作（其余语句）始终由主 writer 进程执行
 */
export { SQLiteExecutor } from "./core/executor.js";
export type { Logger, SQLiteExecutorOptions, StatementOptions, TransactionOptions, TransactionHandle } from "./core/executor.js";

/**
 * 双端队列，支持 O(1) 的首尾操作。
 */
export { Queue } from "./core/queue.js";

/**
 * JSON 流式解析器。
 * - `createJsonValueParser`：从 JSON 数组中逐个提取完整值（用于 query 结果）
 * - `createRowStreamParser`：从 JSON 数组中逐行提取原始字符串（用于 stream）
 */
export { createJsonValueParser, createRowStreamParser } from "./core/parser.js";
export type { JsonValueParser, RowStreamParser } from "./core/parser.js";

/**
 * 底层通信协议工具。
 * - `buildPayload`：将 SQL 和标记 token 组装为发送给子进程的 payload
 * - `isSentinelRow`：判断一行是否为结束标记行
 * - `TOKEN_COLUMN`：标记列名
 */
export { buildPayload, isSentinelRow, TOKEN_COLUMN } from "./core/protocol.js";

/**
 * sqlite3 子进程管理器，负责启动、写入、销毁进程。
 */
export { ProcessManager } from "./core/process.js";

/**
 * 有效的事务隔离级别列表。
 */
export { VALID_TRANSACTION_MODES } from "./transaction/transaction.js";

/**
 * 生成一次性的唯一标记 token，用于标记查询结果末尾。
 */
export { generateToken } from "./utils/token.js";

/**
 * 默认语句超时时间（30 秒）。
 * `createTimeoutError` 用于构造带 SQL 上下文的超时错误。
 */
export { DEFAULT_STATEMENT_TIMEOUT, createTimeoutError } from "./utils/timeout.js";

/**
 * SQL 工具函数。
 * - `escapeValue`：对值进行 SQL 转义
 * - `interpolateSQL`：将参数插值到 SQL 中（带转义）
 * - `normalizeSQL`：规范化 SQL，移除多余空白
 */
export { escapeValue, interpolateSQL, normalizeSQL } from "./utils.js";

/**
 * 在系统 PATH 中查找可执行文件。
 */
export { which } from "./which.js";
