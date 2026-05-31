import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { Queue } from "./core/queue.js";

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

	test("扩容后仍保持正确顺序", () => {
		const queue = new Queue();
		const count = 1000;
		for (let i = 0; i < count; i++) {
			queue.enqueue(i);
		}
		assert.equal(queue.size, count);
		for (let i = 0; i < count; i++) {
			assert.equal(queue.dequeue(), i);
		}
		assert.equal(queue.dequeue(), null);
	});

	test("dequeue 再 enqueue 触发 wrap-around 后顺序正确", () => {
		const queue = new Queue();
		for (let i = 0; i < 20; i++) queue.enqueue(i);
		for (let i = 0; i < 10; i++) assert.equal(queue.dequeue(), i);
		for (let i = 20; i < 40; i++) queue.enqueue(i);
		assert.equal(queue.size, 30);
		const expected = [];
		for (let i = 10; i < 40; i++) expected.push(i);
		assert.deepEqual(queue.toArray(), expected);
	});

	test("grow 在 wrap-around 后正确复制元素", () => {
		// 初始 16 slots，塞满后触发第一次 grow（head=0 的简单扩展）
		const queue = new Queue();
		for (let i = 0; i < 16; i++) queue.enqueue(i);
		// dequeue 8 个 → head=8
		for (let i = 0; i < 8; i++) assert.equal(queue.dequeue(), i);
		// 再塞 24 个填满 32 slots（从 tail=16 开始，到 31 后 wrap 到 0~7）
		for (let i = 16; i < 40; i++) queue.enqueue(i);
		// 再塞 1 个 → head=8 时触发第二次 grow，进入 else 分支
		queue.enqueue(40);

		const expected = [];
		for (let i = 8; i < 41; i++) expected.push(i);
		assert.deepEqual(queue.toArray(), expected);
		assert.equal(queue.size, 33);
	});

	test("remove 删除中间元素", () => {
		const queue = new Queue();
		queue.enqueue(1);
		queue.enqueue(2);
		queue.enqueue(3);
		assert.equal(queue.remove(2), true);
		assert.deepEqual(queue.toArray(), [1, 3]);
		assert.equal(queue.size, 2);
	});

	test("remove 不存在的元素返回 false", () => {
		const queue = new Queue();
		queue.enqueue(1);
		assert.equal(queue.remove(999), false);
		assert.equal(queue.size, 1);
	});

	test("remove 空队列返回 false", () => {
		const queue = new Queue();
		assert.equal(queue.remove(1), false);
	});

	test("find 返回匹配元素", () => {
		const queue = new Queue();
		queue.enqueue({ id: 1 });
		queue.enqueue({ id: 2 });
		const found = queue.find((v) => v.id === 2);
		assert.deepEqual(found, { id: 2 });
	});

	test("find 无匹配时返回 null", () => {
		const queue = new Queue();
		queue.enqueue({ id: 1 });
		assert.equal(queue.find((v) => v.id === 999), null);
	});

	test("find 空队列返回 null", () => {
		const queue = new Queue();
		assert.equal(queue.find(() => true), null);
	});

	test("prependAll 将另一个队列的元素放到前面", () => {
		const a = new Queue();
		const b = new Queue();
		a.enqueue(3);
		a.enqueue(4);
		b.enqueue(1);
		b.enqueue(2);
		a.prependAll(b);
		assert.deepEqual(a.toArray(), [1, 2, 3, 4]);
		assert.equal(b.size, 0);
	});

	test("prependAll 空队列到非空队列", () => {
		const a = new Queue();
		const b = new Queue();
		a.enqueue(1);
		a.prependAll(b);
		assert.deepEqual(a.toArray(), [1]);
	});

	test("prependAll 非空队列到空队列", () => {
		const a = new Queue();
		const b = new Queue();
		b.enqueue(1);
		b.enqueue(2);
		a.prependAll(b);
		assert.deepEqual(a.toArray(), [1, 2]);
	});

	test("prependAll 总大小超过初始容量触发扩容", () => {
		const a = new Queue();
		const b = new Queue();
		for (let i = 0; i < 10; i++) a.enqueue(i);
		for (let i = 10; i < 20; i++) b.enqueue(i);
		// totalSize = 20 > 默认容量 16，触发 while (newCap < totalSize) newCap *= 2
		a.prependAll(b);
		const expected = [];
		for (let i = 10; i < 20; i++) expected.push(i);
		for (let i = 0; i < 10; i++) expected.push(i);
		assert.deepEqual(a.toArray(), expected);
		assert.equal(b.size, 0);
	});

	test("空队列 peek 和 dequeue 返回 null", () => {
		const queue = new Queue();
		assert.equal(queue.peek(), null);
		assert.equal(queue.dequeue(), null);
	});

	test("单元素队列正确操作", () => {
		const queue = new Queue();
		queue.enqueue(42);
		assert.equal(queue.peek(), 42);
		assert.equal(queue.size, 1);
		assert.equal(queue.dequeue(), 42);
		assert.equal(queue.size, 0);
		assert.equal(queue.peek(), null);
	});

	test("clear 后队列为空", () => {
		const queue = new Queue();
		queue.enqueue(1);
		queue.enqueue(2);
		queue.clear();
		assert.equal(queue.size, 0);
		assert.equal(queue.isEmpty(), true);
		assert.equal(queue.dequeue(), null);
		queue.enqueue(3);
		assert.equal(queue.dequeue(), 3);
	});

	test("clear 大队列触发内部数组收缩", () => {
		// 写入 257 项使内部数组扩容到 512（16→32→64→128→256→512）
		const queue = new Queue();
		for (let i = 0; i < 257; i++) {
			queue.enqueue(i);
		}
		assert.equal(queue.size, 257);

		// clear 触发 #shrinkIfNeeded：items.length(512) >= SHRINK_THRESHOLD(256)
		queue.clear();
		assert.equal(queue.size, 0);

		// 收缩后仍能正常使用
		for (let i = 0; i < 100; i++) {
			queue.enqueue(i);
		}
		assert.equal(queue.size, 100);
		for (let i = 0; i < 100; i++) {
			assert.equal(queue.dequeue(), i);
		}
	});
});
