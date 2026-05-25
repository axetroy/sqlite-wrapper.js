export const TOKEN_COLUMN: "__sqlite_executor_token__";

export function buildPayload(sql: string, token: string): string;
export function isSentinelRow(value: unknown, token: string): boolean;
