export declare class Queue<T = unknown> implements Iterable<T> {
	/**
	 * Add a value to the tail of the queue.
	 */
	enqueue(value: T): void;

	/**
	 * Remove and return the value at the head of the queue.
	 */
	dequeue(): T | null;

	/**
	 * Remove all queued values.
	 */
	clear(): void;

	/**
	 * Find the first value that matches the predicate.
	 */
	find(predicate: (value: T) => boolean): T | null;

	/**
	 * Return a snapshot array of all values in FIFO order.
	 */
	toArray(): T[];

	/**
	 * Iterate values in FIFO order without consuming the queue.
	 */
	values(): IterableIterator<T>;

	/**
	 * Return the value at the head of the queue without removing it.
	 */
	peek(): T | null;

	/**
	 * Number of values currently in the queue.
	 */
	readonly size: number;

	/**
	 * Whether the queue is empty.
	 */
	isEmpty(): boolean;

	[Symbol.iterator](): IterableIterator<T>;
}
