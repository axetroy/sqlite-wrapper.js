export const VALID_TRANSACTION_MODES: readonly ["DEFERRED", "IMMEDIATE", "EXCLUSIVE"];

export function isTransactionMode(value: unknown): boolean;

export interface TransactionHandle {
	execute(sql: string, params?: any[], options?: { timeout?: number }): Promise<void>;
	query<T = any>(sql: string, params?: any[], options?: { timeout?: number }): Promise<T[]>;
	queryStream<T = any>(sql: string, onRow: (row: T) => void, params?: any[], options?: { timeout?: number }): Promise<void>;
}

export function createTransactionHandle(scopeId: symbol, executor: { enqueue(kind: string, sql: string, params: any[], options: object, scopeId: symbol | null): Promise<any> }): TransactionHandle;
