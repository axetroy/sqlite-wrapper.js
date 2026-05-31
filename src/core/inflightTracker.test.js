import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { InflightTracker } from "./inflightTracker.js";

describe("InflightTracker", () => {
	// ─── 初始状态 ───

	test("初始时 count 为 0，first 为 null", () => {
		const t = new InflightTracker();
		assert.equal(t.count, 0);
		assert.equal(t.first, null);
	});

	// ─── push / shift 基本 ───

	test("push 后 count 递增，first 返回第一个", () => {
		const t = new InflightTracker();
		t.push("a");
		assert.equal(t.count, 1);
		assert.equal(t.first, "a");

		t.push("b");
		assert.equal(t.count, 2);
		assert.equal(t.first, "a");
	});

	test("shift 按 FIFO 顺序返回", () => {
		const t = new InflightTracker();
		t.push("a");
		t.push("b");
		t.push("c");

		assert.equal(t.shift(), "a");
		assert.equal(t.shift(), "b");
		assert.equal(t.shift(), "c");
		assert.equal(t.count, 0);
	});

	test("支持 push(...items) 批量入队", () => {
		const t = new InflightTracker();
		t.push("a", "b", "c");
		assert.equal(t.count, 3);
		assert.equal(t.shift(), "a");
		assert.equal(t.shift(), "b");
		assert.equal(t.shift(), "c");
	});

	test("shift 空队列返回 null", () => {
		const t = new InflightTracker();
		assert.equal(t.shift(), null);
	});

	test("全部 shift 后自动重置内部数组", () => {
		const t = new InflightTracker();
		t.push("a");
		t.shift();
		// 内部已被重置：_tasksLength 应为 0
		assert.equal(t._tasksLength, 0);
		assert.equal(t._head, 0);
	});

	test("全部 shift 后仍可继续 push/shift", () => {
		const t = new InflightTracker();
		t.push("a");
		t.shift();

		t.push("b");
		t.push("c");
		assert.equal(t.count, 2);
		assert.equal(t.shift(), "b");
		assert.equal(t.shift(), "c");
	});

	// ─── clear ───

	test("clear 清空所有任务", () => {
		const t = new InflightTracker();
		t.push("a", "b", "c");
		t.clear();
		assert.equal(t.count, 0);
		assert.equal(t.first, null);
	});

	test("clear 后可继续使用", () => {
		const t = new InflightTracker();
		t.push("a");
		t.clear();
		t.push("b");
		assert.equal(t.shift(), "b");
	});

	// ─── forEach ───

	test("forEach 遍历所有 inflight 任务", () => {
		const t = new InflightTracker();
		t.push("a", "b", "c");
		const result = [];
		t.forEach((v) => result.push(v));
		assert.deepEqual(result, ["a", "b", "c"]);
	});

	test("forEach 只遍历未 shift 的任务", () => {
		const t = new InflightTracker();
		t.push("a", "b", "c");
		t.shift(); // 移除 a
		const result = [];
		t.forEach((v) => result.push(v));
		assert.deepEqual(result, ["b", "c"]);
	});

	test("forEach 空队列不调用回调", () => {
		const t = new InflightTracker();
		let called = false;
		t.forEach(() => { called = true; });
		assert.equal(called, false);
	});

	// ─── toArray ───

	test("toArray 返回所有未 shift 任务的拷贝", () => {
		const t = new InflightTracker();
		t.push("a", "b", "c");
		t.shift(); // 移除 a
		assert.deepEqual(t.toArray(), ["b", "c"]);
	});

	test("toArray 的返回值修改不影响内部", () => {
		const t = new InflightTracker();
		t.push("a");
		const arr = t.toArray();
		arr.push("x");
		assert.equal(t.count, 1);
		assert.equal(t.first, "a");
	});

	test("空队列 toArray 返回空数组", () => {
		const t = new InflightTracker();
		assert.deepEqual(t.toArray(), []);
	});

	// ─── 混合操作 ───

	test("push / shift / forEach / clear 组合工作", () => {
		const t = new InflightTracker();

		t.push("a", "b");
		assert.equal(t.count, 2);
		assert.equal(t.shift(), "a");
		assert.equal(t.first, "b");

		t.push("c");
		assert.equal(t.count, 2);
		assert.deepEqual(t.toArray(), ["b", "c"]);

		t.clear();
		assert.equal(t.count, 0);

		t.push("d");
		assert.equal(t.shift(), "d");
	});

	// ─── 压缩阈值 ───
	// 当 head > 128 时触发 slice 压缩，验证压缩后数据正确

	test("head 超过压缩阈值后触发数组压缩，数据正确", () => {
		const t = new InflightTracker();
		const N = 135; // > INFLIGHT_COMPACT_THRESHOLD(128) + 余量

		// push N 个任务
		for (let i = 0; i < N; i++) {
			t.push({ id: i });
		}

		// shift 129 个：head 从 127→128（第 128 次）时不触发，
		// 第 129 次时 head 从 128→129 (>128) 触发压缩
		// 压缩后 head=0，内部数组从 135 缩减到 6（项 129~134）
		for (let i = 0; i < 129; i++) {
			assert.equal(t.shift()?.id, i);
		}

		// 压缩已触发：head 重置为 0，内部数组缩小
		assert.equal(t._head, 0);
		assert.ok(t._tasksLength <= N - 129);

		// 剩余元素顺序正确（项 129 ~ 134）
		assert.equal(t.count, 6);
		assert.equal(t.first?.id, 129);

		const remaining = t.toArray();
		assert.equal(remaining.length, 6);
		assert.equal(remaining[0].id, 129);
		assert.equal(remaining[5].id, 134);
	});

	test("压缩后继续 push/shift 工作正常", () => {
		const t = new InflightTracker();

		// 触发压缩
		for (let i = 0; i < 130; i++) {
			t.push({ id: i });
		}
		for (let i = 0; i < 130; i++) {
			t.shift();
		}

		// 压缩后继续使用
		t.push("new");
		assert.equal(t.first, "new");
		assert.equal(t.count, 1);
		assert.equal(t.shift(), "new");
	});

	// ─── 边界：恰好未触发压缩 ───

	test("head = 128 时不触发压缩（head > 128 才触发）", () => {
		const t = new InflightTracker();

		// push 130 个，shift 128 个 → head=128, length=130（还剩 2 个）
		for (let i = 0; i < 130; i++) {
			t.push({ id: i });
		}
		for (let i = 0; i < 128; i++) {
			t.shift();
		}

		// head=128，不大于 128，不触发压缩；但 head < length（130），也不触发重置
		assert.equal(t._head, 128);
		assert.equal(t.count, 2);

		// 再 shift 一次：head=129 > 128 → 触发压缩
		const last = t.shift();
		assert.equal(last?.id, 128);
		assert.equal(t._head, 0);
		assert.equal(t.count, 1);
		assert.equal(t.first?.id, 129);
	});

	// ─── 大量数据下的稳定性 ───

	test("反复 push + shift 不丢失数据", () => {
		const t = new InflightTracker();

		for (let round = 0; round < 5; round++) {
			for (let i = 0; i < 50; i++) {
				t.push(`r${round}-${i}`);
			}
			for (let i = 0; i < 50; i++) {
				assert.equal(t.shift(), `r${round}-${i}`);
			}
			assert.equal(t.count, 0);
		}
	});
});
