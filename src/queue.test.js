import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { Queue } from "./queue.js";

describe("Queue", () => {
	test("保持先进先出顺序", () => {
		const queue = new Queue();
		queue.enqueue(1);
		queue.enqueue(2);
		queue.enqueue(3);

		assert.equal(queue.dequeue(), 1);
		assert.equal(queue.dequeue(), 2);
		assert.equal(queue.dequeue(), 3);
		assert.equal(queue.dequeue(), null);
	});

	test("跟踪大小并支持清空", () => {
		const queue = new Queue();
		assert.equal(queue.size, 0);
		assert.equal(queue.isEmpty(), true);

		queue.enqueue("a");
		queue.enqueue("b");
		assert.equal(queue.size, 2);
		assert.equal(queue.isEmpty(), false);

		queue.clear();
		assert.equal(queue.size, 0);
		assert.equal(queue.isEmpty(), true);
		assert.equal(queue.dequeue(), null);
	});

	test("将所有值导出为数组", () => {
		const queue = new Queue();
		queue.enqueue(1);
		queue.enqueue(2);
		queue.enqueue(3);

		assert.deepEqual(queue.toArray(), [1, 2, 3]);
		assert.equal(queue.size, 3);
		assert.equal(queue.peek(), 1);
	});

	test("支持惰性迭代而不消耗队列", () => {
		const queue = new Queue();
		queue.enqueue("a");
		queue.enqueue("b");
		queue.enqueue("c");

		const values = [];
		for (const value of queue.values()) {
			values.push(value);
		}

		assert.deepEqual(values, ["a", "b", "c"]);
		assert.deepEqual([...queue], ["a", "b", "c"]);
		assert.equal(queue.size, 3);
		assert.equal(queue.dequeue(), "a");
	});
});
