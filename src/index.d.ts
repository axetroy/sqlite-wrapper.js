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
 * 运行时指标收集器。
 * 追踪 SQL 执行任务的吞吐、耗时、错误、超时和进程重启。
 */
export { Metrics } from "./core/metrics.js";
export type { MetricsSnapshot } from "./core/metrics.js";

/**
 * 有效的事务隔离级别列表。
 */
export { VALID_TRANSACTION_MODES } from "./transaction/transaction.js";

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
