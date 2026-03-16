import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { Queue } from "./queue.js";

describe("Queue", () => {
	test("maintains FIFO order", () => {
		const queue = new Queue();
		queue.enqueue(1);
		queue.enqueue(2);
		queue.enqueue(3);

		assert.equal(queue.dequeue(), 1);
		assert.equal(queue.dequeue(), 2);
		assert.equal(queue.dequeue(), 3);
		assert.equal(queue.dequeue(), null);
	});

	test("tracks size and clear", () => {
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
});
