export declare class Queue<T = any> {
	enqueue(value: T): void;
	dequeue(): T | null;
	peek(): T | null;
	remove(value: T): boolean;
	find(predicate: (value: T) => boolean): T | null;
	clear(): void;
	toArray(): T[];
	values(): Generator<T, void, unknown>;
	prependAll(other: Queue<T>): void;
	isEmpty(): boolean;
	get size(): number;
	[Symbol.iterator](): Generator<T, void, unknown>;
}
