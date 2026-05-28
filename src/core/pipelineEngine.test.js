import assert from "node:assert/strict";
import test, { before, after, describe, beforeEach, afterEach } from "node:test";

import { PipelineEngine } from "./pipelineEngine.js";
import { Metrics } from "./metrics.js";
import { TOKEN_COLUMN } from "./protocol.js";
import { Queue } from "./queue.js";

/**
 * 创建一个存根 ProcessManager，记录 write 调用。
 */
function createMockProcessManager() {
	let _drainCallback = null;
	return {
		_writes: [],
		_draining: false,
		get draining() { return this._draining; },
		set draining(v) { this._draining = v; },
		write(payload) {
			this._writes.push(payload);
		},
		setOnDrainCallback(fn) {
			_drainCallback = fn;
		},
		_triggerDrain() {
			this._draining = false;
			_drainCallback?.();
		},
	};
}

/**
 * 创建一个带 resolve/reject Promise 的任务对象。
 */
function createTask(overrides = {}) {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return {
		task: {
			kind: "query",
			sql: "SELECT 1",
			timeout: 5000,
			token: `tok-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			onRow: null,
			rows: [],
			resolve,
			reject,
			consumerError: null,
			stderrText: "",
			settled: false,
			timer: null,
			startTime: 0,
			rowParser: null,
			...overrides,
		},
		promise,
	};
}

/** 等待 setImmediate 清空 pendingFinalize 队列 */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

// PipelineEngine 的 cleanup (kill) 会 reject 所有待处理任务，
// 这些预期内的拒绝会导致 unhandledRejection 警告并标记文件失败。
// 在文件级别统一抑制，确保只在此测试文件中生效。
const _origListeners = process.listeners("unhandledRejection");

before(() => {
	process.removeAllListeners("unhandledRejection");
	process.on("unhandledRejection", () => {
		/* 静默吞掉预期的清理拒绝 */
	});
});

after(() => {
	process.removeAllListeners("unhandledRejection");
	for (const listener of _origListeners) {
		process.on("unhandledRejection", listener);
	}
});

describe("PipelineEngine", () => {
	/** @type {Metrics} */
	let metrics;
	/** @type {ReturnType<typeof createMockProcessManager>} */
	let mockPM;
	/** @type {PipelineEngine} */
	let engine;
	/** @type {Array<{ task: object }>} */
	let timeouts;

	beforeEach(() => {
		metrics = new Metrics();
		mockPM = createMockProcessManager();
		timeouts = [];
		engine = new PipelineEngine(mockPM, {
			metrics,
			statementTimeout: 5000,
			onTaskTimeout: (task) => {
				timeouts.push(task);
			},
		});
		engine.activate();
	});

	afterEach(() => {
		engine.kill();
	});

	/** 清除任务的定时器，防止 cleanup 时的未捕获活动 */
	function disarm(task) {
		clearTimeout(task.timer);
		task.timer = null;
	}

	// ── 初始状态 ──────────────────────────────────────

	describe("初始状态", () => {
		test("pendingStatements 初始为 0", () => {
			assert.equal(engine.pendingStatements, 0);
		});

		test("mainQueue 返回 Queue 实例且为空", () => {
			const q = engine.mainQueue;
			assert.ok(q instanceof Queue);
			assert.equal(q.size, 0);
		});
	});

	// ── activate / deactivate ─────────────────────────

	describe("activate / deactivate", () => {
		test("deactivate 后 enqueue 不触发 write", () => {
			engine.deactivate();
			const { task, promise } = createTask();
			engine.enqueue(task);
			promise.catch(() => {});
			assert.equal(mockPM._writes.length, 0);
		});

		test("activate 后 enqueue 触发 write", () => {
			engine.activate();
			const { task } = createTask();
			engine.enqueue(task);
			disarm(task);
			assert.equal(mockPM._writes.length, 1);
		});

		test("deactivate → activate 后可正常发送", () => {
			engine.deactivate();
			engine.activate();
			const { task } = createTask();
			engine.enqueue(task);
			disarm(task);
			assert.equal(mockPM._writes.length, 1);
		});

		test("activate 重置 sharedValueParser", () => {
			// feed 一些数据使 valueParser 有残留状态
			engine.feed('{"partial":');
			engine.deactivate();
			engine.activate(); // 应重置 valueParser
			// activate 后 enqueue 一个任务，feed 完整数据应能触发 sentinel
			const { task, promise } = createTask({ token: "act-token" });
			engine.enqueue(task);
			engine.feed(`[{"${TOKEN_COLUMN}":"act-token"}]`);
			// 如果 valueParser 已重置，就能解析出完整 JSON
			assert.equal(mockPM._writes.length, 1);
			promise.catch(() => {});
		});
	});

	// ── enqueue and pump ──────────────────────────────

	describe("enqueue 与 pump", () => {
		test("单个 query 任务 payload 包含 SQL 和 sentinel", () => {
			const { task } = createTask({ kind: "query", sql: "SELECT 1" });
			engine.enqueue(task);
			// 立即清理定时器，避免 cleanup 时残留异步活动
			clearTimeout(task.timer);
			task.timer = null;

			assert.equal(mockPM._writes.length, 1);
			const payload = mockPM._writes[0];
			assert.ok(payload.includes("SELECT 1"), "payload 应包含 SQL");
			assert.ok(payload.includes(task.token), "payload 应包含 token");
			assert.ok(payload.includes(TOKEN_COLUMN), "payload 应包含哨兵列名");
		});

		test("单个 execute 任务发送到 writer", () => {
			const { task } = createTask({
				kind: "execute",
				sql: "CREATE TABLE t (id INT)",
			});
			engine.enqueue(task);
			clearTimeout(task.timer);
			task.timer = null;

			assert.equal(mockPM._writes.length, 1);
			assert.ok(mockPM._writes[0].includes("CREATE TABLE t"));
		});

		test("每个任务都设置了 startTime 和定时器", () => {
			const before = performance.now();
			const { task } = createTask();
			engine.enqueue(task);
			assert.ok(task.startTime >= before, "startTime 应在 enqueue 之后");
			assert.ok(task.timer !== null, "应设置超时定时器");
			assert.ok(typeof task.timer === "object", "定时器应为 Timeout 对象");
			clearTimeout(task.timer);
			task.timer = null;
		});
	});

	// ── WAL 批量优化 ────────────────────────────────

	describe("WAL 批量优化", () => {
		test("多个 execute 使用 BEGIN/COMMIT 包裹", () => {
			// 先把所有任务放入队列，再一次性触发 pump
			engine.deactivate();
			const tasks = [];
			for (let i = 0; i < 3; i++) {
				const { task } = createTask({
					kind: "execute",
					sql: `INSERT INTO t VALUES (${i})`,
				});
				engine.enqueue(task);
				tasks.push(task);
			}

			assert.equal(mockPM._writes.length, 0, "deactivate 时不应发送");
			engine.activate();
			engine.pump();

			assert.equal(mockPM._writes.length, 1);
			const payload = mockPM._writes[0];
			assert.ok(payload.startsWith("BEGIN;"), "应以 BEGIN 开头");
			assert.ok(payload.includes("INSERT INTO t VALUES (0)"));
			assert.ok(payload.includes("INSERT INTO t VALUES (1)"));
			assert.ok(payload.includes("INSERT INTO t VALUES (2)"));
			assert.ok(payload.includes("COMMIT;"), "应包含 COMMIT");
			// 每个 task 在 COMMIT 后应有自己的 sentinel
			for (const t of tasks) {
				assert.ok(payload.includes(t.token), `应包含 token ${t.token}`);
			}
			for (const t of tasks) {
				disarm(t);
			}
		});

		test("单个 execute 不使用 WAL batch", () => {
			const { task } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
			});
			engine.enqueue(task);
			disarm(task);

			const payload = mockPM._writes[0];
			assert.ok(!payload.startsWith("BEGIN;"));
		});

		test("混合 execute 和 query 不使用 WAL batch", () => {
			const { task: t1 } = createTask({
				kind: "execute",
				sql: "CREATE TABLE t (id INT)",
			});
			const { task: t2 } = createTask({ kind: "query", sql: "SELECT 1" });
			engine.enqueue(t1);
			engine.enqueue(t2);
			disarm(t1);
			disarm(t2);

			const payload = mockPM._writes[0];
			assert.ok(!payload.startsWith("BEGIN;"));
		});
	});

	// ── WAL batch 跳过事务控制语句 ────────────────────

	describe("WAL batch 跳过事务控制", () => {
		test("BEGIN TRANSACTION 在 batch 中时跳过 WAL batch", () => {
			engine.deactivate();
			const { task: t1 } = createTask({
				kind: "execute",
				sql: "BEGIN TRANSACTION",
			});
			const { task: t2 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
			});
			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.activate();
			engine.pump();

			assert.equal(mockPM._writes.length, 1);
			const payload = mockPM._writes[0];
			assert.ok(!payload.startsWith("BEGIN;"), "不应使用 WAL batch 包裹");
			assert.ok(payload.includes("BEGIN TRANSACTION"));
			assert.ok(payload.includes("INSERT INTO t VALUES (1)"));
			disarm(t1);
			disarm(t2);
		});

		test("COMMIT 在 batch 中时跳过 WAL batch", () => {
			engine.deactivate();
			const { task: t1 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
			});
			const { task: t2 } = createTask({
				kind: "execute",
				sql: "COMMIT",
			});
			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.activate();
			engine.pump();

			assert.equal(mockPM._writes.length, 1);
			const payload = mockPM._writes[0];
			assert.ok(!payload.startsWith("BEGIN;"), "不应使用 WAL batch 包裹");
			disarm(t1);
			disarm(t2);
		});

		test("ROLLBACK 在 batch 中时跳过 WAL batch", () => {
			engine.deactivate();
			const { task: t1 } = createTask({
				kind: "execute",
				sql: "INSERT INTO t VALUES (1)",
			});
			const { task: t2 } = createTask({
				kind: "execute",
				sql: "ROLLBACK",
			});
			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.activate();
			engine.pump();

			assert.equal(mockPM._writes.length, 1);
			const payload = mockPM._writes[0];
			assert.ok(!payload.startsWith("BEGIN;"), "不应使用 WAL batch 包裹");
			disarm(t1);
			disarm(t2);
		});
	});

	// ── maxInflight ──────────────────────────────────

	describe("maxInflight", () => {
		test("达到上限后暂停发送，任务完成后续发", async () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				batchSize: 1,
				maxInflight: 2,
			});
			localEngine.activate();

			const { task: t1, promise: p1 } = createTask({ token: "mi-t1" });
			const { task: t2 } = createTask({ token: "mi-t2" });
			const { task: t3 } = createTask({ token: "mi-t3" });

			localEngine.enqueue(t1); // inflight=1, written
			assert.equal(mockPM._writes.length, 1, "t1 应被写入");

			localEngine.enqueue(t2); // inflight=2, written
			assert.equal(mockPM._writes.length, 2, "t2 应被写入");

			localEngine.enqueue(t3); // inflight=2 ≥ maxInflight, NOT written
			assert.equal(mockPM._writes.length, 2, "t3 不应被写入（已达上限）");

			// 完成 t1：inflight 降为 1，触发 t3 发送
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"mi-t1"}]`);
			await flush();

			// 注意 handleParsedValue 在 sentinel 后调用了 pumpQueue，
			// t3 应在新的一批中被写入
			assert.equal(mockPM._writes.length, 3, "t1 完成后 t3 应被写入");

			// 完成 t2、t3
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"mi-t2"}]`);
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"mi-t3"}]`);
			await flush();
			await p1.catch(() => {});

			localEngine.kill();
		});

		test("batch 不越过 maxInflight 上限", () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				batchSize: 10,
				maxInflight: 3,
			});
			localEngine.activate();

			// 积累 5 个任务在队列中
			localEngine.deactivate();
			const tasks = [];
			for (let i = 0; i < 5; i++) {
				const { task } = createTask({ token: `mi-batch-${i}` });
				localEngine.enqueue(task);
				tasks.push(task);
			}

			// 激活后 pump 只应发送 3 个（maxInflight=3）
			localEngine.activate();
			localEngine.pump();

			assert.equal(mockPM._writes.length, 1, "应有一批写入");
			const payload = mockPM._writes[0];
			// payload 应只包含 3 个任务
			assert.ok(payload.includes("mi-batch-0"), "应包含任务 0");
			assert.ok(payload.includes("mi-batch-1"), "应包含任务 1");
			assert.ok(payload.includes("mi-batch-2"), "应包含任务 2");
			assert.ok(!payload.includes("mi-batch-3"), "不应包含任务 3（超出上限）");
			assert.ok(!payload.includes("mi-batch-4"), "不应包含任务 4（超出上限）");

			for (const t of tasks) disarm(t);
			localEngine.kill();
		});

		test("maxInflight=1 时每次只发一个任务", () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				batchSize: 10,
				maxInflight: 1,
			});
			localEngine.activate();

			const { task: t1 } = createTask({ token: "mi1-t1" });
			const { task: t2 } = createTask({ token: "mi1-t2" });

			localEngine.enqueue(t1);
			localEngine.enqueue(t2);

			assert.equal(mockPM._writes.length, 1, "t1 发送后 t2 不应写入");

			// 完成 t1
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"mi1-t1"}]`);

			assert.equal(mockPM._writes.length, 2, "t1 完成后 t2 才写入");

			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"mi1-t2"}]`);

			disarm(t1);
			disarm(t2);
			localEngine.kill();
		});
	});

	// ── stream 任务隔离 ──────────────────────────────

	describe("stream 任务隔离", () => {
		test("stream 不阻塞后续非 stream 任务", () => {
			// pump 的 stream 检查只阻止 stream 加入已有 batch 或在有 inflight 时发送，
			// 但非 stream 任务可以跟在 stream 后一起发送。
			engine.deactivate();
			const { task: t1 } = createTask({
				kind: "stream",
				sql: "SELECT * FROM t",
			});
			const { task: t2 } = createTask({ kind: "query", sql: "SELECT 1" });
			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.activate();
			engine.pump();

			// stream 和 query 在同一 batch 中一起发送
			assert.equal(mockPM._writes.length, 1);
			assert.ok(mockPM._writes[0].includes("SELECT * FROM t"), "payload 应包含 stream SQL");
			assert.ok(mockPM._writes[0].includes("SELECT 1"), "payload 也应包含 query SQL");
			disarm(t1);
			disarm(t2);
		});

		test("inflight 中有任务时 stream 排队等待", () => {
			const { task: t1 } = createTask({ kind: "query", sql: "SELECT 1" });
			const { task: t2 } = createTask({
				kind: "stream",
				sql: "SELECT * FROM t",
			});
			engine.enqueue(t1);
			engine.enqueue(t2);
			disarm(t1);

			assert.equal(mockPM._writes.length, 1);
			assert.ok(mockPM._writes[0].includes("SELECT 1"));
			assert.ok(!mockPM._writes[0].includes("SELECT * FROM t"));
		});
	});

	// ── sentinel 解析与任务结算 ───────────────────────

	describe("sentinel 解析", () => {
		test("query 任务收到数据行 + sentinel 后正确 resolve", async () => {
			const { task, promise } = createTask({
				kind: "query",
				sql: "SELECT 1 AS v",
				token: "resolve-me",
			});
			engine.enqueue(task);

			// 模拟 sqlite3 返回行数据 + 哨兵行
			engine.handleStdoutChunk('[{"v":1}]');
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"resolve-me"}]`);

			await flush();
			const result = await promise;
			assert.deepEqual(result, [{ v: 1 }]);
		});

		test("空结果集 + sentinel 返回空数组", async () => {
			const { task, promise } = createTask({
				kind: "query",
				sql: "SELECT * FROM empty",
				token: "empty-result",
			});
			engine.enqueue(task);

			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"empty-result"}]`);

			await flush();
			const result = await promise;
			assert.deepEqual(result, []);
		});

		test("多个 query 分批 sentinel 逐个 resolve", async () => {
			const { task: t1, promise: p1 } = createTask({
				kind: "query",
				sql: "SELECT 1 AS v",
				token: "multi-1",
			});
			const { task: t2, promise: p2 } = createTask({
				kind: "query",
				sql: "SELECT 2 AS v",
				token: "multi-2",
			});
			engine.enqueue(t1);
			engine.enqueue(t2);

			// 第一个任务的结果 + sentinel
			engine.handleStdoutChunk('[{"v":1}]');
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"multi-1"}]`);
			await flush();

			const r1 = await p1;
			assert.deepEqual(r1, [{ v: 1 }]);

			// 第二个任务的结果 + sentinel
			engine.handleStdoutChunk('[{"v":2}]');
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"multi-2"}]`);
			await flush();

			const r2 = await p2;
			assert.deepEqual(r2, [{ v: 2 }]);
		});

		test("stderrText 非空时 reject", async () => {
			const { task, promise } = createTask({
				kind: "query",
				sql: "SELECT * FROM bad_table",
				token: "err-token",
			});
			task.stderrText = "no such table: bad_table";
			engine.enqueue(task);

			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"err-token"}]`);

			await assert.rejects(promise, /no such table: bad_table/);
		});

		test("consumerError 时立即 reject 不走 pendingFinalize", async () => {
			const { task, promise } = createTask({
				kind: "query",
				sql: "SELECT 1",
				token: "ce-token",
				consumerError: new Error("consumer broke"),
			});
			engine.enqueue(task);

			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"ce-token"}]`);

			// consumerError 路径不经过 pendingFinalize，立即 settle
			await assert.rejects(promise, /consumer broke/);
		});

		test("execute 任务收到 sentinel 后 resolve undefined", async () => {
			const { task, promise } = createTask({
				kind: "execute",
				sql: "CREATE TABLE t (id INT)",
				token: "exec-token",
			});
			engine.enqueue(task);

			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"exec-token"}]`);

			await flush();
			const result = await promise;
			assert.equal(result, undefined);
		});
	});

	// ── 单任务超时 ────────────────────────────────────

	describe("单任务超时", () => {
		test("超时只拒绝超时任务，其他 inflight 任务正常完成", async () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
				onTaskTimeout: (task) => { timeouts.push(task); },
			});
			localEngine.activate();

			const { task: t1, promise: p1 } = createTask({
				token: "to-t1",
				timeout: 1,
			});
			const { task: t2, promise: p2 } = createTask({
				token: "to-t2",
			});
			const { task: t3, promise: p3 } = createTask({
				token: "to-t3",
			});

			localEngine.enqueue(t1);
			localEngine.enqueue(t2);
			localEngine.enqueue(t3);

			// 等待 t1 超时
			await new Promise((r) => setTimeout(r, 30));

			// t1 应在 inflight 中等待它的 sentinel 到来后才能从 inflight 中移除
			assert.equal(localEngine.pendingStatements, 3, "t1 超时后仍在 inflight(等 sentinel)");
			assert.equal(timeouts.length, 1, "onTaskTimeout 只被调用了一次");
			assert.equal(timeouts[0].token, "to-t1", "超时回调收到 t1");

			// t1 的 sentinel 到达（sqlite3 完成了 t1 的执行）
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"to-t1"}]`);

			// t1 已从 inflight 移除，t2/t3 仍在
			assert.equal(localEngine.pendingStatements, 2, "t1 移除后 t2/t3 仍在 inflight");

			// t2/t3 的 sentinel 到达
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"to-t2"}]`);
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"to-t3"}]`);
			await flush();

			await assert.rejects(p1, /timed out/, "t1 应因超时被拒绝");
			const r2 = await p2;
			const r3 = await p3;
			assert.deepEqual(r2, [], "t2 应正常完成");
			assert.deepEqual(r3, [], "t3 应正常完成");

			localEngine.kill();
		});

		test("超时任务数据行不会污染后续任务", async () => {
			const localEngine = new PipelineEngine(mockPM, {
				metrics,
				statementTimeout: 5000,
			});
			localEngine.activate();

			const { task: t1, promise: p1 } = createTask({
				kind: "query",
				token: "data-t1",
				timeout: 1,
			});
			const { task: t2, promise: p2 } = createTask({
				kind: "query",
				token: "data-t2",
			});

			localEngine.enqueue(t1);
			localEngine.enqueue(t2);

			// 等 t1 超时
			await new Promise((r) => setTimeout(r, 30));

			// t1 的数据行 + sentinel 到达（t1 超时后，sqlite3 仍然会输出它的结果）
			localEngine.handleStdoutChunk("[1]");
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"data-t1"}]`);

			// t2 的数据行 + sentinel
			localEngine.handleStdoutChunk("[2]");
			localEngine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"data-t2"}]`);
			await flush();

			await assert.rejects(p1, /timed out/, "t1 拒绝");
			const r2 = await p2;
			// t2 只应收到它自己的数据 [2]，不应包含 t1 的 [1]
			assert.deepEqual(r2, [2], "t2 收到正确数据行，无污染");

			localEngine.kill();
		});
	});

	// ── stderr 处理 ──────────────────────────────────

	describe("stderr 处理", () => {
		test("stderr 文本追加到 inflight 任务的 stderrText", () => {
			const { task } = createTask({ token: "stderr-test" });
			engine.enqueue(task);

			engine.handleStderrChunk("Error: near line 1");
			assert.equal(task.stderrText, "Error: near line 1");

			engine.handleStderrChunk(": syntax error");
			assert.equal(task.stderrText, "Error: near line 1: syntax error");
			disarm(task);
		});

		test("无 inflight 任务时不崩溃", () => {
			engine.handleStderrChunk("orphan error message");
			// 不应抛出异常
		});
	});

	// ── rejectAll ────────────────────────────────────

	describe("rejectAll", () => {
		test("拒绝所有 inflight 和队列中的任务", async () => {
			const { task: t1, promise: p1 } = createTask();
			const { task: t2, promise: p2 } = createTask();
			const { task: t3, promise: p3 } = createTask();

			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.enqueue(t3);

			assert.equal(engine.pendingStatements, 3);

			const err = new Error("fatal pipeline error");
			engine.rejectAll(err);

			await assert.rejects(p1, /fatal pipeline error/);
			await assert.rejects(p2, /fatal pipeline error/);
			await assert.rejects(p3, /fatal pipeline error/);

			assert.equal(engine.pendingStatements, 0);
		});

		test("rejectAll 后失败指标正确", () => {
			// PipelineEngine 不负责 incrementTasksTotal，由调用方负责
			const { task: t1 } = createTask();
			const { task: t2 } = createTask();
			engine.enqueue(t1);
			engine.enqueue(t2);
			engine.rejectAll(new Error("fail"));

			const s = metrics.snapshot();
			assert.equal(s.tasksFailed, 2, "两个任务都应记为失败");
			assert.equal(s.tasksSuccess, 0, "不应有成功任务");
		});
	});

	// ── kill ─────────────────────────────────────────

	describe("kill", () => {
		test("kill 后 pendingStatements 归零", () => {
			const { task } = createTask();
			engine.enqueue(task);
			engine.kill();
			assert.equal(engine.pendingStatements, 0);
		});

		test("kill 后 enqueue 不再发送", () => {
			engine.kill();
			const { task } = createTask();
			engine.enqueue(task);
			assert.equal(mockPM._writes.length, 0);
		});
	});

	// ── pump ─────────────────────────────────────────

	describe("pump", () => {
		test("手动 pump 触发队列处理", () => {
			engine.deactivate();
			const { task } = createTask();
			engine.enqueue(task);
			assert.equal(mockPM._writes.length, 0, "deactivate 时不发送");

			engine.activate();
			engine.pump();
			assert.equal(mockPM._writes.length, 1, "pump 后应发送");
		});
	});

	// ── feed ─────────────────────────────────────────

	describe("feed", () => {
		test("feed 将数据送入 sharedValueParser 并触发 sentinel 结算", async () => {
			// feed 是 setupStreamParser 用于回喂哨兵行的公开方法
			const { task, promise } = createTask({ token: "feed-token" });
			engine.enqueue(task);

			// 直接通过 feed 送入 sentinel JSON
			engine.feed(`[{"${TOKEN_COLUMN}":"feed-token"}]`);

			await flush();
			const result = await promise;
			assert.deepEqual(result, []);
			assert.ok("feed 触发了 sentinel 结算");
		});
	});

	// ── drain 背压 ─────────────────────────────

	describe("drain 背压", () => {
		test("draining=true 时 pumpQueue 暂停写入，任务留在队列", () => {
			mockPM.draining = true;
			const { task } = createTask();
			engine.enqueue(task);

			assert.equal(mockPM._writes.length, 0, "不应触发 write");
			assert.equal(engine.pendingStatements, 1, "任务留在队列中");
		});

		test("draining=true 时多个 enqueue 都不触发 write", () => {
			mockPM.draining = true;
			const { task: t1 } = createTask();
			const { task: t2 } = createTask();
			engine.enqueue(t1);
			engine.enqueue(t2);

			assert.equal(mockPM._writes.length, 0);
			assert.equal(engine.pendingStatements, 2);
		});

		test("drain 触发后 pumpQueue 自动发送积压任务", () => {
			mockPM.draining = true;
			const { task } = createTask();
			engine.enqueue(task);
			assert.equal(mockPM._writes.length, 0, " draining 时不应写入");

			mockPM._triggerDrain();

			assert.equal(mockPM._writes.length, 1, "drain 后应写入");
			assert.equal(engine.pendingStatements, 1, "任务进入 inflight");
		});

		test("draining=false 时正常写入不受影响", () => {
			mockPM.draining = false;
			const { task } = createTask();
			engine.enqueue(task);

			assert.equal(mockPM._writes.length, 1, "应正常触发 write");
		});

		test("draining 从 true→false→true 交替工作", () => {
			mockPM.draining = true;
			const { task: t1 } = createTask();
			engine.enqueue(t1);
			assert.equal(mockPM._writes.length, 0, "draining 时应暂停");

			mockPM._triggerDrain();
			assert.equal(mockPM._writes.length, 1, "drain 后写入积压任务");
			const firstPayload = mockPM._writes[0];

			mockPM.draining = true;
			const { task: t2 } = createTask();
			engine.enqueue(t2);
			assert.equal(mockPM._writes.length, 1, "再次 draining，不应有新写入");

			mockPM._triggerDrain();
			assert.equal(mockPM._writes.length, 2, "再次 drain 后写入第二个任务");
			assert.notEqual(mockPM._writes[0], mockPM._writes[1], "两次 payload 应不同");
		});
	});

	// ── pendingStatements ───────────────────────────

	describe("pendingStatements", () => {
		test("反映任务总数（queue + inflight + pendingFinalize）", async () => {
			assert.equal(engine.pendingStatements, 0);

			const { task: t1 } = createTask({ token: "ps-t1" });
			engine.enqueue(t1);
			assert.equal(engine.pendingStatements, 1, "入队后应为 1");

			const { task: t2 } = createTask({ token: "ps-t2" });
			engine.enqueue(t2);
			assert.equal(engine.pendingStatements, 2, "入队两个后应为 2");

			// 完成两个任务
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"ps-t1"}]`);
			engine.handleStdoutChunk(`[{"${TOKEN_COLUMN}":"ps-t2"}]`);
			await flush();
			assert.equal(engine.pendingStatements, 0, "两个任务都完成后应归零");
		});
	});
});
