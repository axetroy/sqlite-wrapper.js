import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { finalizePendingTasks, prepareTaskTimeout } from "./pipelineUtils.js";

describe("finalizePendingTasks", () => {
	test("query 任务调用 settle(null, task.rows)", () => {
		const calls = [];
		const tasks = new Set([
			{ kind: "query", rows: [{ id: 1 }], stderrText: "", consumerError: null },
		]);
		finalizePendingTasks(
			tasks,
			(task, error, value) => calls.push({ error, value }),
			() => calls.push({ pump: true }),
		);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].error, null);
		assert.deepEqual(calls[0].value, [{ id: 1 }]);
		assert.deepEqual(calls[1], { pump: true });
	});

	test("execute 任务调用 settle(null, undefined)", () => {
		const calls = [];
		const tasks = new Set([
			{ kind: "execute", rows: undefined, stderrText: "", consumerError: null },
		]);
		finalizePendingTasks(
			tasks,
			(task, error, value) => calls.push({ error, value }),
			() => calls.push({ pump: true }),
		);
		assert.equal(calls[0].error, null);
		assert.equal(calls[0].value, undefined);
	});

	test("stderrText 非空时 reject 为该文本", () => {
		const calls = [];
		const tasks = new Set([
			{ kind: "query", rows: [], stderrText: "error msg\n", consumerError: null },
		]);
		finalizePendingTasks(
			tasks,
			(task, error, value) => calls.push({ error, value }),
			() => calls.push({ pump: true }),
		);
		assert.ok(calls[0].error instanceof Error);
		assert.ok(calls[0].error.message.includes("error msg"));
	});

	test("consumerError 优先于 rows（stderrText 优先级最高）", () => {
		const calls = [];
		const consumerErr = new Error("consumer broke");
		const tasks = new Set([
			{ kind: "query", rows: [{ id: 1 }], stderrText: "", consumerError: consumerErr },
		]);
		finalizePendingTasks(
			tasks,
			(task, error, value) => calls.push({ error, value }),
			() => calls.push({ pump: true }),
		);
		assert.equal(calls[0].error, consumerErr);
	});

	test("多个任务全部结算，集合被清空", () => {
		const calls = [];
		const tasks = new Set([
			{ kind: "execute", rows: undefined, stderrText: "", consumerError: null },
			{ kind: "query", rows: [1], stderrText: "", consumerError: null },
			{ kind: "stream", rows: undefined, stderrText: "", consumerError: null },
		]);
		finalizePendingTasks(
			tasks,
			(task, error, value) => calls.push({ kind: task.kind, error, value }),
			() => {},
		);
		assert.equal(calls.length, 3);
		assert.equal(tasks.size, 0, "集合应在处理后清空");
	});

	test("空集合不调用 settle（无任务），pumpQueue 仍被调用", () => {
		let settleCalled = false;
		let pumpCalled = false;
		finalizePendingTasks(
			new Set(),
			() => { settleCalled = true; },
			() => { pumpCalled = true; },
		);
		assert.equal(settleCalled, false, "空集合不调用 settle");
		assert.equal(pumpCalled, true, "pumpQueue 仍被调用");
	});
});

describe("prepareTaskTimeout", () => {
	function makeTask(overrides = {}) {
		return {
			settled: false,
			timedout: false,
			timer: setTimeout(() => {}, 100000).unref(),
			timeout: 100,
			sql: "SELECT 1",
			...overrides,
		};
	}

	test("返回 TimeoutError，标记 timedout，清除定时器", () => {
		const timer = setTimeout(() => {}, 100000).unref();
		const task = makeTask({ timer });
		const error = prepareTaskTimeout(task, null);
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes("timed out"));
		assert.equal(task.timedout, true);
		assert.equal(task.timer, null, "timer 应被置 null");
	});

	test("指标递增", () => {
		let timeoutCount = 0;
		const metrics = { incrementTasksTimeout: () => { timeoutCount++; } };
		const task = makeTask();
		prepareTaskTimeout(task, metrics);
		assert.equal(timeoutCount, 1);
	});

	test("已结算任务返回 null，不递增指标", () => {
		let timeoutCount = 0;
		const metrics = { incrementTasksTimeout: () => { timeoutCount++; } };
		const task = makeTask({ settled: true });
		const result = prepareTaskTimeout(task, metrics);
		assert.equal(result, null);
		assert.equal(timeoutCount, 0, "已结算任务不应递增指标");
		assert.equal(task.timedout, false, "已结算任务不应修改 timedout");
	});

	test("metrics 为 null 时不崩溃", () => {
		const task = makeTask();
		const result = prepareTaskTimeout(task, null);
		assert.ok(result instanceof Error);
	});

	test("metrics 为 undefined 时不崩溃", () => {
		const task = makeTask();
		const result = prepareTaskTimeout(task, undefined);
		assert.ok(result instanceof Error);
	});
});
