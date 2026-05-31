import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { finalizePendingTasks, prepareTaskTimeout, handleParsedValue, createSweeper, createFinalizeScheduler } from "./pipelineUtils.js";
import { InflightTracker } from "./inflightTracker.js";

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
			timer: null,
			timeout: 100,
			sql: "SELECT 1",
			...overrides,
		};
	}

	test("返回 TimeoutError，标记 timedout", () => {
		const task = makeTask();
		const error = prepareTaskTimeout(task, null);
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes("timed out"));
		assert.equal(task.timedout, true);
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

describe("createSweeper", () => {
	test("schedule 创建定时器，getSweepTimer 返回非 null", () => {
		const inflight = new InflightTracker();
		const sweeper = createSweeper({
			inflight,
			sweepIntervalMs: 1000,
			handleTaskTimeout: () => {},
		});
		assert.equal(sweeper.getSweepTimer(), null, "尚未 schedule");
		sweeper.schedule();
		assert.ok(sweeper.getSweepTimer() !== null, "schedule 后应有定时器");
		sweeper.clear();
		assert.equal(sweeper.getSweepTimer(), null, "clear 后定时器应清除");
	});

	test("多次 schedule 不会创建多个定时器", () => {
		const inflight = new InflightTracker();
		const sweeper = createSweeper({
			inflight,
			sweepIntervalMs: 1000,
			handleTaskTimeout: () => {},
		});
		sweeper.schedule();
		const timer1 = sweeper.getSweepTimer();
		sweeper.schedule();
		const timer2 = sweeper.getSweepTimer();
		assert.equal(timer1, timer2, "多次 schedule 应返回同一定时器");
		sweeper.clear();
	});

	test("clear 在不活动时不会报错", () => {
		const inflight = new InflightTracker();
		const sweeper = createSweeper({
			inflight,
			sweepIntervalMs: 1000,
			handleTaskTimeout: () => {},
		});
		sweeper.clear(); // 首次 clear 无定时器
		sweeper.clear(); // 再次 clear
		assert.equal(sweeper.getSweepTimer(), null);
	});

	test("超时任务触发 handleTaskTimeout", async () => {
		const inflight = new InflightTracker();
		const timedoutTasks = [];

		// 创建一个已超时的任务
		const task = {
			startTime: performance.now() - 5000, // 5 秒前
			timeout: 100, // 100ms 超时 → 肯定已超时
			settled: false,
		};
		inflight.push(task);

		const sweeper = createSweeper({
			inflight,
			sweepIntervalMs: 10, // 10ms 扫描一次
			handleTaskTimeout: (t) => {
				// 模拟真实行为：标记已结算防止重复触发
				if (t.settled) return;
				t.settled = true;
				timedoutTasks.push(t);
			},
		});

		sweeper.schedule();
		// 等待 sweep 触发多次，但只应结算一次
		await sleep(50);
		sweeper.clear();

		assert.equal(timedoutTasks.length, 1, "超时任务应只被结算一次");
		assert.equal(timedoutTasks[0], task);
	});

	test("未超时任务不触发 handleTaskTimeout", async () => {
		const inflight = new InflightTracker();
		const timedoutTasks = [];

		const task = {
			startTime: performance.now(), // 刚加入
			timeout: 10000, // 10s 超时
		};
		inflight.push(task);

		const sweeper = createSweeper({
			inflight,
			sweepIntervalMs: 10,
			handleTaskTimeout: (t) => timedoutTasks.push(t),
		});

		sweeper.schedule();
		await sleep(50);
		sweeper.clear();

		assert.equal(timedoutTasks.length, 0, "未超时任务不应被触发");
	});
});

describe("createFinalizeScheduler", () => {
	test("调度后触发 finalizePendingTasks", async () => {
		const calls = [];
		const pending = new Set([
			{ kind: "execute", rows: undefined, stderrText: "", consumerError: null },
		]);

		const schedule = createFinalizeScheduler({
			pendingFinalizeTasks: pending,
			settleTask: (t, e, v) => calls.push({ type: "settle", error: e, value: v }),
			pumpQueue: () => calls.push({ type: "pump" }),
		});

		schedule();
		assert.equal(calls.length, 0, "schedule 后不应立即调用 settle");

		// 等待 setImmediate 触发
		await sleep(0);
		assert.equal(calls.length, 2, "setImmediate 后应完成结算");
		assert.equal(calls[0].type, "settle");
		assert.equal(calls[0].value, undefined);
		assert.equal(calls[1].type, "pump");
	});

	test("多次调度合并为一次 setImmediate", async () => {
		let settleCount = 0;
		const pending = new Set([
			{ kind: "execute", rows: undefined, stderrText: "", consumerError: null },
		]);

		const schedule = createFinalizeScheduler({
			pendingFinalizeTasks: pending,
			settleTask: () => { settleCount++; },
			pumpQueue: () => {},
		});

		schedule();
		schedule();
		schedule();

		await sleep(0);
		assert.equal(settleCount, 1, "多次调度只应结算一次");
	});
});

describe("handleParsedValue", () => {
	function makeMockInflight(task = null) {
		let current = task;
		return {
			get first() { return current; },
			shift() {
				const t = current;
				current = null;
				return t;
			},
			// toArray 不为 handleParsedValue 使用，但保持兼容
			toArray() { return current ? [current] : []; },
		};
	}

	test("无 inflight 任务时直接返回", () => {
		let called = false;
		handleParsedValue('{"a":1}', makeMockInflight(null), {
			afterSentinel: () => { called = true; },
			rejectAll: () => { called = true; },
		});
		assert.equal(called, false);
	});

	test("原始字符串匹配 sentinel 时调用 afterSentinel", () => {
		const task = { token: "tok-1" };
		let afterCalled = false;
		handleParsedValue(`[{"__sqlite_executor_token__":"tok-1"}]`, makeMockInflight(task), {
			afterSentinel: (t) => {
				afterCalled = true;
				assert.equal(t, task);
			},
			rejectAll: () => {},
		});
		assert.equal(afterCalled, true);
	});

	test("空数组 [] 直接返回，不触发回调", () => {
		let called = false;
		const task = { token: "tok-1" };
		handleParsedValue("[]", makeMockInflight(task), {
			afterSentinel: () => { called = true; },
			rejectAll: () => { called = true; },
		});
		assert.equal(called, false);
	});

	test("JSON 解析失败时调用 rejectAll", () => {
		const task = { token: "tok-1" };
		let rejectCalled = false;
		handleParsedValue("{invalid json}", makeMockInflight(task), {
			afterSentinel: () => {},
			rejectAll: (err) => {
				rejectCalled = true;
				assert.ok(err instanceof Error);
				assert.ok(err.message.includes("Invalid JSON from sqlite3"));
			},
		});
		assert.equal(rejectCalled, true);
	});

	test("sentinel 行匹配时调用 afterSentinel", () => {
		const task = { token: "tok-2" };
		let afterCalled = false;
		handleParsedValue(`[{"__sqlite_executor_token__":"tok-2"}]`, makeMockInflight(task), {
			afterSentinel: (t) => {
				afterCalled = true;
				assert.equal(t, task);
			},
			rejectAll: () => {},
		});
		assert.equal(afterCalled, true);
	});

	test("timedout 任务跳过行收集", () => {
		const rows = [];
		const task = { token: "tok-1", kind: "query", timedout: true, rows };
		handleParsedValue(`[{"id":1}]`, makeMockInflight(task), {
			afterSentinel: () => {},
			rejectAll: () => {},
		});
		assert.equal(rows.length, 0, "timedout 任务不应收集行");
	});

	test("query 任务收集行数据", () => {
		const rows = [];
		const task = { token: "tok-1", kind: "query", rows };
		handleParsedValue(`[{"id":1},{"id":2}]`, makeMockInflight(task), {
			afterSentinel: () => {},
			rejectAll: () => {},
		});
		assert.equal(rows.length, 2);
		assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
	});

	test("stream 任务逐行回调", () => {
		const streamRows = [];
		const task = {
			token: "tok-1",
			kind: "stream",
			onRow: (row) => streamRows.push(row),
			consumerError: null,
		};
		handleParsedValue(`["a","b","c"]`, makeMockInflight(task), {
			afterSentinel: () => {},
			rejectAll: () => {},
		});
		assert.deepEqual(streamRows, ["a", "b", "c"]);
	});
});
