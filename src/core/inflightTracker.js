import { INFLIGHT_COMPACT_THRESHOLD } from "../constants.js";

/**
 * Inflight 任务数组管理器。
 *
 * 封装了变长数组 + 头指针的 push/shift 操作和自动压缩逻辑，
 * PipelineEngine 和 TaskWorker 共享此类，避免重复实现 inflight 管理。
 *
 * 设计：
 * - shift() 出队时将对应槽位置为 null，仅移动头指针
 * - 头指针超过阈值时通过 slice() 物理回收已消费的前部空间
 * - 不需使用者关心 #tasks / #head 的内部细节
 */
export class InflightTracker {
	#tasks = [];
	#head = 0;

	/** 当前 inflight 任务数。 */
	get count() {
		return this.#tasks.length - this.#head;
	}

	/** 第一个（最旧的）inflight 任务，无任务时返回 null。 */
	get first() {
		return this.#head < this.#tasks.length ? this.#tasks[this.#head] : null;
	}

	/** 将一个或多个任务追加到队尾。 */
	push(...items) {
		this.#tasks.push(...items);
	}

	/** 移除并返回第一个 inflight 任务。空时返回 null。 */
	shift() {
		if (this.#tasks.length === this.#head) return null;
		const task = this.#tasks[this.#head];
		this.#tasks[this.#head] = null;
		this.#head++;
		if (this.#head >= this.#tasks.length) {
			this.#tasks = [];
			this.#head = 0;
		} else if (this.#head > INFLIGHT_COMPACT_THRESHOLD) {
			this.#tasks = this.#tasks.slice(this.#head);
			this.#head = 0;
		}
		return task;
	}

	/** 清空所有 inflight 任务。 */
	clear() {
		this.#tasks = [];
		this.#head = 0;
	}

	/** 对每个 inflight 任务调用 fn(task)。 */
	forEach(fn) {
		for (let i = this.#head; i < this.#tasks.length; i++) {
			fn(this.#tasks[i]);
		}
	}

	/** 返回所有 inflight 任务的浅拷贝数组（不含 null 槽位）。 */
	toArray() {
		return this.#tasks.slice(this.#head);
	}

	/** 测试用：获取内部数组长度。 */
	get _tasksLength() {
		return this.#tasks.length;
	}

	/** 测试用：获取头指针位置。 */
	get _head() {
		return this.#head;
	}
}
