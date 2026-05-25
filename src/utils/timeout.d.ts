export const DEFAULT_STATEMENT_TIMEOUT: 30000;

export function createTimeoutError(timeout: number, sql: string): Error;
