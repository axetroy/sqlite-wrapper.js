export const TOKEN_COLUMN = "__sqlite_executor_token__";

/** 管线化批量发送的默认 batch 大小 */
export const DEFAULT_BATCH_SIZE = 10;

/**
 * 管线最大并发数（inflight 任务上限）。
 * 防止大量任务一次性写入 stdin 撑爆 OS 管道缓冲区
 * （Windows 管道 buffer 仅 4KB，Unix 为 64KB）。
 */
export const DEFAULT_MAX_INFLIGHT = 50;

/**
 * Inflight 任务数组压缩阈值。
 * 当 #shiftInflight() 中 #inflightHead 超过此值时，
 * 通过 slice() 压缩 inflightTasks 数组以回收已被消费的前部 null 条目所占内存。
 */
export const INFLIGHT_COMPACT_THRESHOLD = 128;
