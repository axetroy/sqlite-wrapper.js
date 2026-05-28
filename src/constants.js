export const TOKEN_COLUMN = "__sqlite_executor_token__";

/** 管线化批量发送的默认 batch 大小 */
export const DEFAULT_BATCH_SIZE = 10;

/**
 * 管线最大并发数（inflight 任务上限）。
 * 防止大量任务一次性写入 stdin 撑爆 OS 管道缓冲区
 * （Windows 管道 buffer 仅 4KB，Unix 为 64KB）。
 */
export const DEFAULT_MAX_INFLIGHT = 50;
