/**
 * 双端队列，基于双向链表实现。
 * 支持 O(1) 的首尾入队/出队操作，以及查找、删除、迭代等功能。
 */
export declare class Queue<T = any> {
	/** 将值加入队尾 */
	enqueue(value: T): void;

	/** 移除并返回队首元素；队列为空时返回 null */
	dequeue(): T | null;

	/** 返回队首元素但不移除；队列为空时返回 null */
	peek(): T | null;

	/** 移除队列中第一个匹配的值，返回是否成功移除 */
	remove(value: T): boolean;

	/** 查找第一个满足条件的元素，未找到时返回 null */
	find(predicate: (value: T) => boolean): T | null;

	/** 清空队列 */
	clear(): void;

	/** 将队列转为数组（从队首到队尾） */
	toArray(): T[];

	/** 遍历队列元素 */
	values(): Generator<T, void, unknown>;

	/** 将另一个队列的所有元素追加到当前队尾 */
	prependAll(other: Queue<T>): void;

	/** 队列是否为空 */
	isEmpty(): boolean;

	/** 队列中的元素数量 */
	get size(): number;

	[Symbol.iterator](): Generator<T, void, unknown>;
}
