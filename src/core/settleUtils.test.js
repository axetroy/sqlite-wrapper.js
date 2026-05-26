import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { collectQueryRows, processStreamRows, settleTask } from "./settleUtils.js";
import { Metrics } from "./metrics.js";

describe("collectQueryRows", () => {
	test("将数组元素追加到 task.rows", () => {
		const task = { rows: [{ id: 1 }] };
		collectQueryRows(task, [{ id: 2 }, { id: 3 }]);
		assert.deepEqual(task.rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
	});

	test("空数组不修改 rows", () => {
		const task = { rows: [{ id: 1 }] };
		collectQueryRows(task, []);
		assert.deepEqual(task.rows, [{ id: 1 }]);
	});

	test("非数组输入时不修改 rows", () => {
		const task = { rows: [{ id: 1 }] };
		collectQueryRows(task, { id: 2 });
		assert.deepEqual(task.rows, [{ id: 1 }]);

		collectQueryRows(task, null);
		assert.deepEqual(task.rows, [{ id: 1 }]);

		collectQueryRows(task, "string");
		assert.deepEqual(task.rows, [{ id: 1 }]);

		collectQueryRows(task, undefined);
		assert.deepEqual(task.rows, [{ id: 1 }]);
	});

	test("多次收集累积到 rows", () => {
		const task = { rows: [] };
		collectQueryRows(task, [{ a: 1 }]);
		collectQueryRows(task, [{ a: 2 }, { a: 3 }]);
		collectQueryRows(task, [{ a: 4 }]);
		assert.deepEqual(task.rows, [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]);
	});
});

describe("processStreamRows", () => {
	test("对数组每个元素调用 onRow", () => {
		const called = [];
		const task = {
			onRow: (row) => called.push(row),
			consumerError: null,
		};
		processStreamRows(task, [{ id: 1 }, { id: 2 }]);
		assert.deepEqual(called, [{ id: 1 }, { id: 2 }]);
	});

	test("非数组输入不调用 onRow", () => {
		let called = false;
		const task = {
			onRow: () => { called = true; },
			consumerError: null,
		};
		processStreamRows(task, { id: 1 });
		assert.equal(called, false);

		processStreamRows(task, null);
		assert.equal(called, false);

		processStreamRows(task, "text");
		assert.equal(called, false);
	});

	test("consumerError 时停止后续回调", () => {
		const called = [];
		const task = {
			onRow: (row) => {
				called.push(row.id);
				if (row.id === 2) throw new Error("consumer stopped");
			},
			consumerError: null,
		};
		processStreamRows(task, [{ id: 1 }, { id: 2 }, { id: 3 }]);
		assert.deepEqual(called, [1, 2]);
		assert.ok(task.consumerError instanceof Error);
		assert.ok(task.consumerError.message.includes("consumer stopped"));
	});

	test("consumerError 已设置时跳过所有回调", () => {
		const called = [];
		const task = {
			onRow: (row) => called.push(row),
			consumerError: new Error("previous error"),
		};
		processStreamRows(task, [{ id: 1 }, { id: 2 }]);
		assert.deepEqual(called, []);
	});

	test("空数组不调用 onRow", () => {
		const called = [];
		const task = {
			onRow: (row) => called.push(row),
			consumerError: null,
		};
		processStreamRows(task, []);
		assert.deepEqual(called, []);
	});
});

describe("settleTask", () => {
	test("任务成功时调用 resolve 并更新指标", () => {
		const metrics = new Metrics();
		let resolvedValue;
		const task = {
			timer: null,
			startTime: 100,
			rowParser: null,
			resolve: (v) => { resolvedValue = v; },
			reject: () => { assert.fail("不应调用 reject"); },
		};

		settleTask(task, null, "success", metrics);

		assert.equal(resolvedValue, "success");
		const s = metrics.snapshot();
		assert.equal(s.tasksSuccess, 1);
		assert.equal(s.tasksFailed, 0);
	});

	test("任务失败时调用 reject 并更新指标", () => {
		const metrics = new Metrics();
		let rejectedError;
		const task = {
			timer: null,
			startTime: 100,
			rowParser: null,
			resolve: () => { assert.fail("不应调用 resolve"); },
			reject: (err) => { rejectedError = err; },
		};

		const err = new Error("task failed");
		settleTask(task, err, undefined, metrics);

		assert.equal(rejectedError, err);
		const s = metrics.snapshot();
		assert.equal(s.tasksFailed, 1);
		assert.equal(s.tasksSuccess, 0);
	});

	test("非 Error 值被包装为 Error", () => {
		let rejectedError;
		const task = {
			timer: null,
			startTime: 100,
			rowParser: null,
			resolve: () => {},
			reject: (err) => { rejectedError = err; },
		};

		settleTask(task, "string error", undefined, null);

		assert.ok(rejectedError instanceof Error);
		assert.ok(rejectedError.message.includes("string error"));
	});

	test("metrics 为 null 时不崩溃", () => {
		const task = {
			timer: null,
			startTime: 100,
			rowParser: null,
			resolve: () => {},
			reject: () => {},
		};

		settleTask(task, null, "ok", null);
		settleTask(task, new Error("fail"), undefined, null);
		// 不应抛出异常
	});

	test("startTime 为 0 时 duration 计为 0", () => {
		const metrics = new Metrics();
		const task = {
			timer: null,
			startTime: 0,
			rowParser: null,
			resolve: () => {},
			reject: () => {},
		};

		settleTask(task, null, "ok", metrics);

		assert.equal(metrics.totalDuration, 0);
	});

	test("resetRowParser 选项调用 rowParser.reset()", () => {
		let resetCalled = false;
		const task = {
			timer: null,
			startTime: 100,
			rowParser: { reset: () => { resetCalled = true; } },
			resolve: () => {},
			reject: () => {},
		};

		settleTask(task, null, "ok", null, { resetRowParser: true });
		assert.equal(resetCalled, true);
	});

	test("resetRowParser 为 false 时不调用 reset", () => {
		let resetCalled = false;
		const task = {
			timer: null,
			startTime: 100,
			rowParser: { reset: () => { resetCalled = true; } },
			resolve: () => {},
			reject: () => {},
		};

		settleTask(task, null, "ok", null, { resetRowParser: false });
		assert.equal(resetCalled, false);
	});

	test("rowParser 为 null 时 resetRowParser 不崩溃", () => {
		const task = {
			timer: null,
			startTime: 100,
			rowParser: null,
			resolve: () => {},
			reject: () => {},
		};

		settleTask(task, null, "ok", null, { resetRowParser: true });
		// 不应抛出异常
	});

	test("清除定时器", () => {
		let timerCleared = false;
		const task = {
			timer: setTimeout(() => {}),
			startTime: 100,
			rowParser: null,
			resolve: () => {},
			reject: () => {},
		};
		// 劫持 clearTimeout 验证
		const origClear = global.clearTimeout;
		global.clearTimeout = (t) => { timerCleared = true; origClear(t); };
		try {
			settleTask(task, null, "ok", null);
			assert.equal(timerCleared, true);
		} finally {
			global.clearTimeout = origClear;
		}
	});
});
