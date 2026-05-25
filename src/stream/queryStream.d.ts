import { createRowStreamParser, RowStreamParser } from "../core/parser.js";

export { createRowStreamParser };

export function setupStreamParser(task: { kind: string; onRow?: Function; consumerError?: Error | null; valueParser?: { feed: Function }; token?: string }): RowStreamParser | null;

export declare class AsyncRowBuffer<T = any> implements AsyncIterable<T>, AsyncIterator<T> {
	push(row: T): void;
	end(): void;
	error(err: unknown): void;
	next(): Promise<IteratorResult<T>>;
	return(): Promise<IteratorResult<T>>;
	[Symbol.asyncIterator](): AsyncIterator<T>;
}
