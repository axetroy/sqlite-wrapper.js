import assert from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import test, { afterEach, beforeEach, describe } from "node:test";

import outdent from "outdent";

import { SQLiteWrapper, AbortError } from "./index.js";
import downloadSQLite3 from "../script/download-sqlite3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.join(__dirname, "..");

const SQLite3BinaryFile = path.join(root, "bin", "sqlite3");

/**
 * @type {import("./index.js").SQLiteWrapper}
 */
let sqlite;

beforeEach(async () => {
	// download the SQLite3 binary if it doesn't exist
	await downloadSQLite3();

	sqlite = new SQLiteWrapper(SQLite3BinaryFile);
});

afterEach(() => sqlite.close());

describe("SQLiteWrapper", () => {
	test("创建表", async () => {
		await sqlite.exec(
			outdent`
				CREATE TABLE IF NOT EXISTS users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT
				);

				INSERT INTO users (name) VALUES (?);
				INSERT INTO users (name) VALUES (?);
		`,
			["Alice", "Bob"],
		);
	});

	test("创建表并查询", async () => {
		await sqlite.exec(
			outdent`
				CREATE TABLE IF NOT EXISTS users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT
				);

				INSERT INTO users (name) VALUES (?);
				INSERT INTO users (name) VALUES (?);
		`,
			["Alice", "Bob"],
		);

		const rows = await sqlite.query("SELECT * FROM users");

		assert.deepEqual(rows, [
			{ id: 1, name: "Alice" },
			{ id: 2, name: "Bob" },
		]);
	});

	test("创建表、查询并更新", async () => {
		await sqlite.exec(
			outdent`
				CREATE TABLE IF NOT EXISTS users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT
				);

				INSERT INTO users (name) VALUES (?);
				INSERT INTO users (name) VALUES (?);
		`,
			["Alice", "Bob"],
		);

		const rows = await sqlite.query("SELECT * FROM users");

		assert.deepEqual(rows, [
			{ id: 1, name: "Alice" },
			{ id: 2, name: "Bob" },
		]);

		// Update
		await sqlite.exec("UPDATE users SET name = 'Charlie' WHERE id = ?", [1]);
		const updatedRows = await sqlite.query("SELECT * FROM users WHERE id = ?", [1]);
		assert.deepEqual(updatedRows, [{ id: 1, name: "Charlie" }]);
	});

	test("run 方法在 INSERT 时返回 changes 和 lastInsertRowid", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS run_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

		const result = await sqlite.run("INSERT INTO run_users (name) VALUES (?)", ["Alice"]);
		assert.equal(result.changes, 1);
		assert.equal(result.lastInsertRowid, 1);

		const result2 = await sqlite.run("INSERT INTO run_users (name) VALUES (?)", ["Bob"]);
		assert.equal(result2.changes, 1);
		assert.equal(result2.lastInsertRowid, 2);
	});

	test("run 方法在 UPDATE 时返回 changes", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS run_update_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
		await sqlite.exec("INSERT INTO run_update_users (name) VALUES (?)", ["Alice"]);
		await sqlite.exec("INSERT INTO run_update_users (name) VALUES (?)", ["Bob"]);

		const result = await sqlite.run("UPDATE run_update_users SET name = ? WHERE id = ?", ["Charlie", 1]);
		assert.equal(result.changes, 1);

		const noOpResult = await sqlite.run("UPDATE run_update_users SET name = ? WHERE id = ?", ["Dave", 999]);
		assert.equal(noOpResult.changes, 0);
	});

	test("run 方法在 DELETE 时返回 changes", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS run_delete_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
		await sqlite.exec("INSERT INTO run_delete_users (name) VALUES (?)", ["Alice"]);
		await sqlite.exec("INSERT INTO run_delete_users (name) VALUES (?)", ["Bob"]);

		const result = await sqlite.run("DELETE FROM run_delete_users WHERE id = ?", [1]);
		assert.equal(result.changes, 1);
	});

	test("创建表并使用中文字符查询", async () => {
		await sqlite.exec(
			outdent`
				CREATE TABLE IF NOT EXISTS chinese_users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT
				);

				INSERT INTO chinese_users (name) VALUES (?);
				INSERT INTO chinese_users (name) VALUES (?);
		`,
			["张三", "李四"],
		);

		const rows = await sqlite.query("SELECT * FROM chinese_users");

		assert.deepEqual(rows, [
			{ id: 1, name: "张三" },
			{ id: 2, name: "李四" },
		]);
	});

	test("正确处理并发写入队列", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS concurrent_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

		const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

		await Promise.all(names.map((name) => sqlite.exec("INSERT INTO concurrent_users (name) VALUES (?)", [name])));

		const rows = await sqlite.query("SELECT name FROM concurrent_users ORDER BY id ASC");
		assert.deepEqual(
			rows.map((row) => row.name),
			names,
		);
	});

	test("处理大批量并发写入", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS burst_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

		const total = 3000;
		const jobs = [];

		for (let i = 0; i < total; i++) {
			jobs.push(sqlite.exec("INSERT INTO burst_users (name) VALUES (?)", [`user-${i}`]));
		}

		await Promise.all(jobs);

		const countRows = await sqlite.query("SELECT COUNT(*) AS total FROM burst_users");
		assert.equal(countRows[0].total, total);
	});

	test("并发批量查询时结果集相互隔离", async () => {
		await sqlite.exec(
			outdent`
				CREATE TABLE IF NOT EXISTS query_users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT
				);

				INSERT INTO query_users (name) VALUES (?);
				INSERT INTO query_users (name) VALUES (?);
				INSERT INTO query_users (name) VALUES (?);
			`,
			["Alice", "Bob", "Carol"],
		);

		const [firstRows, secondRows, countRows] = await Promise.all([
			sqlite.query("SELECT id, name FROM query_users WHERE id <= ? ORDER BY id ASC", [2]),
			sqlite.query("SELECT id, name FROM query_users WHERE id > ? ORDER BY id ASC", [2]),
			sqlite.query("SELECT COUNT(*) AS total FROM query_users"),
		]);

		assert.deepEqual(firstRows, [
			{ id: 1, name: "Alice" },
			{ id: 2, name: "Bob" },
		]);

		assert.deepEqual(secondRows, [{ id: 3, name: "Carol" }]);
		assert.deepEqual(countRows, [{ total: 3 }]);
	});

	test("同批次中失败语句不影响后续成功语句", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS batch_isolation_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
		await sqlite.exec("INSERT INTO batch_isolation_users (name) VALUES (?)", ["Alice"]);

		const [failedResult, successResult] = await Promise.allSettled([
			sqlite.query("SELECT * FROM missing_batch_table"),
			sqlite.query("SELECT id, name FROM batch_isolation_users ORDER BY id ASC"),
		]);

		assert.equal(failedResult.status, "rejected");
		assert.match(failedResult.reason.message, /no such table: missing_batch_table/);

		assert.equal(successResult.status, "fulfilled");
		assert.deepEqual(successResult.value, [{ id: 1, name: "Alice" }]);
	});

	test("不将错误归因于成功的并发查询", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS mixed_isolation_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
		await sqlite.exec("DELETE FROM mixed_isolation_users");
		await sqlite.exec("INSERT INTO mixed_isolation_users (name) VALUES (?)", ["Alice"]);

		for (let i = 0; i < 50; i++) {
			const [failedResult, successResult] = await Promise.allSettled([
				sqlite.query(`SELECT * FROM missing_mixed_table_${i}`),
				sqlite.query("SELECT id, name FROM mixed_isolation_users ORDER BY id ASC"),
			]);

			assert.equal(failedResult.status, "rejected");
			assert.match(failedResult.reason.message, new RegExp(`missing_mixed_table_${i}`));

			assert.equal(successResult.status, "fulfilled");
			assert.deepEqual(successResult.value, [{ id: 1, name: "Alice" }]);
		}
	});

	test("sqlite 二进制文件缺失时拒绝请求", async () => {
		const missingPath = path.join(os.tmpdir(), "missing-sqlite3-binary");
		const wrapper = new SQLiteWrapper(missingPath);

		// Allow spawn error handler to mark the wrapper as closed
		await new Promise((resolve) => setImmediate(resolve));

		await assert.rejects(wrapper.exec("SELECT 1;"), /closed SQLiteWrapper/);
		wrapper.close();
	});

	test("调用 close 时拒绝待处理的队列请求", async () => {
		const p1 = sqlite.exec("SELECT 1;");
		const p2 = sqlite.exec("SELECT 2;");

		sqlite.close();

		const settled = await Promise.race([
			Promise.allSettled([p1, p2]),
			new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for promises")), 1000)),
		]);

		assert.deepEqual(
			settled.map((item) => item.status),
			["rejected", "rejected"],
		);
	});

	test("[Symbol.dispose] 拒绝队列中的任务而非静默丢弃", async () => {
		// Enqueue a query to occupy the process, then queue a second exec that stays in the queue
		const firstPromise = sqlite.query("SELECT 1");
		const secondPromise = sqlite.exec("SELECT 2");

		// Dispose while both are pending
		sqlite[Symbol.dispose]();

		const settled = await Promise.race([
			Promise.allSettled([firstPromise, secondPromise]),
			new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out — queued promise was never settled")), 1000)),
		]);

		assert.deepEqual(
			settled.map((item) => item.status),
			["rejected", "rejected"],
		);
	});

	test("执行含行注释的 SQL 而不挂起", async () => {
		await sqlite.exec(
			outdent`
				CREATE TABLE IF NOT EXISTS transfer (
					taskId INTEGER PRIMARY KEY NOT NULL,            -- task ID
					serverId INTEGER NOT NULL,                      -- server ID
					accountId INTEGER NOT NULL,                     -- account ID
					type INTEGER NOT NULL,                          -- task type
					status INTEGER NOT NULL DEFAULT 0               -- task status
				);

				-- create indexes outside table definition
				CREATE INDEX IF NOT EXISTS idx_transfer_server_id ON transfer (serverId);
				CREATE INDEX IF NOT EXISTS idx_transfer_account_id ON transfer (accountId);
			`,
		);

		await sqlite.exec(
			"INSERT INTO transfer (taskId, serverId, accountId, type, status) VALUES (?, ?, ?, ?, ?)",
			[1, 10, 20, 0, 0],
		);

		const rows = await sqlite.query("SELECT taskId, serverId FROM transfer WHERE taskId = ?", [1]);
		assert.deepEqual(rows, [{ taskId: 1, serverId: 10 }]);
	});

	test("接受自定义队列调优选项", async () => {
		sqlite.close();

		const tuned = new SQLiteWrapper(SQLite3BinaryFile, {
			maxInFlight: 16,
			maxBatchChars: 8 * 1024,
		});

		await tuned.exec("CREATE TABLE IF NOT EXISTS tuning_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
		await tuned.exec("INSERT INTO tuning_users (name) VALUES (?)", ["Alice"]);

		const rows = await tuned.query("SELECT name FROM tuning_users");
		assert.deepEqual(rows, [{ name: "Alice" }]);

		tuned.close();
	});

	test("传入无效队列调优选项时抛出错误", () => {
		assert.throws(() => new SQLiteWrapper(SQLite3BinaryFile, { maxInFlight: 0 }), /maxInFlight must be a positive integer/);
		assert.throws(
			() => new SQLiteWrapper(SQLite3BinaryFile, { maxBatchChars: -1 }),
			/maxBatchChars must be a positive integer/,
		);
	});

	test("触发 onTiming 回调并携带 queue/run/total 指标", async () => {
		sqlite.close();

		const timings = [];
		const measuredSQLite = new SQLiteWrapper(SQLite3BinaryFile, {
			onTiming: (timing) => timings.push(timing),
		});

		await measuredSQLite.exec("CREATE TABLE IF NOT EXISTS timing_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

		const settled = await Promise.allSettled([
			measuredSQLite.exec("INSERT INTO timing_users (name) VALUES (?)", ["Alice"]),
			measuredSQLite.query("SELECT * FROM missing_timing_table"),
		]);

		assert.equal(settled[0].status, "fulfilled");
		assert.equal(settled[1].status, "rejected");
		assert.ok(timings.length >= 3);

		for (const timing of timings) {
			assert.equal(typeof timing.sql, "string");
			assert.equal(typeof timing.isQuery, "boolean");
			assert.ok(timing.status === "fulfilled" || timing.status === "rejected");
			assert.equal(typeof timing.queueMs, "number");
			assert.equal(typeof timing.runMs, "number");
			assert.equal(typeof timing.totalMs, "number");
			assert.ok(timing.queueMs >= 0);
			assert.ok(timing.runMs >= 0);
			assert.ok(timing.totalMs >= 0);
			assert.equal(timing.totalMs, timing.queueMs + timing.runMs);
		}

		assert.ok(timings.some((timing) => timing.status === "rejected"));
		measuredSQLite.close();
	});
});

describe("transaction()", () => {
	test("成功提交并返回函数返回值", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_commit (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");

		const result = await sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_commit (val) VALUES (?)", ["hello"]);
			return 42;
		});

		assert.equal(result, 42);

		const rows = await sqlite.query("SELECT val FROM tx_commit");
		assert.deepEqual(rows, [{ val: "hello" }]);
	});

	test("发生错误时回滚并重新抛出", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_rollback (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
		await sqlite.exec("INSERT INTO tx_rollback (val) VALUES (?)", ["before"]);

		const boom = new Error("intentional failure");

		await assert.rejects(
			sqlite.transaction(async (tx) => {
				await tx.exec("INSERT INTO tx_rollback (val) VALUES (?)", ["during"]);
				throw boom;
			}),
			boom,
		);

		const rows = await sqlite.query("SELECT val FROM tx_rollback");
		assert.deepEqual(rows, [{ val: "before" }]);
	});

	test("串行化并发事务使其不会交错执行", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_serial (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");

		const order = [];

		const t1 = sqlite.transaction(async (tx) => {
			order.push("t1-start");
			await tx.exec("INSERT INTO tx_serial (val) VALUES (?)", ["t1-a"]);
			// yield to let t2 try to start
			await new Promise((r) => setImmediate(r));
			await tx.exec("INSERT INTO tx_serial (val) VALUES (?)", ["t1-b"]);
			order.push("t1-end");
		});

		const t2 = sqlite.transaction(async (tx) => {
			order.push("t2-start");
			await tx.exec("INSERT INTO tx_serial (val) VALUES (?)", ["t2-a"]);
			order.push("t2-end");
		});

		await Promise.all([t1, t2]);

		// t1 must fully complete before t2 starts
		assert.deepEqual(order, ["t1-start", "t1-end", "t2-start", "t2-end"]);

		const rows = await sqlite.query("SELECT val FROM tx_serial ORDER BY id ASC");
		assert.deepEqual(rows.map((r) => r.val), ["t1-a", "t1-b", "t2-a"]);
	});

	test("第一个事务回滚后第二个事务正常执行", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_after_rollback (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");

		// First transaction fails
		await assert.rejects(
			sqlite.transaction(async (tx) => {
				await tx.exec("INSERT INTO tx_after_rollback (val) VALUES (?)", ["will-rollback"]);
				throw new Error("fail");
			}),
		);

		// Second transaction should still work
		await sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_after_rollback (val) VALUES (?)", ["after-rollback"]);
		});

		const rows = await sqlite.query("SELECT val FROM tx_after_rollback");
		assert.deepEqual(rows, [{ val: "after-rollback" }]);
	});

	test("tx 对象暴露 exec、run 和 query 方法但不暴露 transaction", async () => {
		await sqlite.transaction(async (tx) => {
			assert.equal(typeof tx.exec, "function");
			assert.equal(typeof tx.run, "function");
			assert.equal(typeof tx.query, "function");
			assert.equal(typeof tx.transaction, "undefined");
		});
	});

	test("事务内 tx.run 返回 changes 和 lastInsertRowid", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_run (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");

		const result = await sqlite.transaction(async (tx) => {
			return tx.run("INSERT INTO tx_run (val) VALUES (?)", ["x"]);
		});

		assert.equal(result.changes, 1);
		assert.equal(result.lastInsertRowid, 1);
	});

	test("事务内 tx.query 返回查询结果", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_query (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
		await sqlite.exec("INSERT INTO tx_query (val) VALUES (?)", ["visible"]);

		const rows = await sqlite.transaction(async (tx) => {
			return tx.query("SELECT val FROM tx_query");
		});

		assert.deepEqual(rows, [{ val: "visible" }]);
	});

	test("IMMEDIATE 类型事务成功执行", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_immediate (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");

		await sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_immediate (val) VALUES (?)", ["imm"]);
		}, "IMMEDIATE");

		const rows = await sqlite.query("SELECT val FROM tx_immediate");
		assert.deepEqual(rows, [{ val: "imm" }]);
	});

	test("EXCLUSIVE 类型事务成功执行", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_exclusive (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");

		await sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_exclusive (val) VALUES (?)", ["excl"]);
		}, "EXCLUSIVE");

		const rows = await sqlite.query("SELECT val FROM tx_exclusive");
		assert.deepEqual(rows, [{ val: "excl" }]);
	});

	test("无效事务类型时抛出 TypeError", async () => {
		await assert.rejects(
			sqlite.transaction(async () => {}, "INVALID"),
			/transaction type must be one of/,
		);
	});

	test("事务进行中的裸 exec 调用会延迟至提交后执行", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_deferred (val TEXT)");

		const log = [];

		// A barrier that resolves once the transaction body is running and the first
		// tx statement has committed to sqlite3.  At that point #activeTransactionId
		// is set, so any bare exec enqueued after the barrier will be deferred.
		let resolveBarrier;
		const barrier = new Promise((r) => {
			resolveBarrier = r;
		});

		const txPromise = sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_deferred (val) VALUES ('tx-1')");
			// Signal that the transaction is active, then yield to let the bare
			// exec below be enqueued while #activeTransactionId is still set.
			resolveBarrier();
			await new Promise((r) => setImmediate(r));
			await tx.exec("INSERT INTO tx_deferred (val) VALUES ('tx-2')");
			log.push("tx-end");
		});

		await barrier;

		// Enqueue a bare exec that must be deferred until after COMMIT.
		const barePromise = sqlite.exec("INSERT INTO tx_deferred (val) VALUES ('bare')").then(() => {
			log.push("bare-done");
		});

		await Promise.all([txPromise, barePromise]);

		// Rows must appear in transaction order, with 'bare' last.
		const rows = await sqlite.query("SELECT val FROM tx_deferred ORDER BY rowid");
		assert.deepEqual(
			rows.map((r) => r.val),
			["tx-1", "tx-2", "bare"],
		);

		// 'bare-done' must be recorded after 'tx-end' (i.e. after COMMIT).
		assert.ok(log.indexOf("tx-end") < log.indexOf("bare-done"), "bare exec must resolve after transaction commits");
	});

	test("延迟任务不会被下一个事务再次延迟", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_chain (val TEXT)");

		const log = [];

		let resolveBarrier1;
		const barrier1 = new Promise((r) => {
			resolveBarrier1 = r;
		});

		// T1: insert 'a', then yield so the bare exec below can be enqueued.
		const t1 = sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_chain (val) VALUES ('t1')");
			resolveBarrier1();
			await new Promise((r) => setImmediate(r));
		});

		await barrier1;

		// Bare exec enqueued while T1 is active → deferred.
		const barePromise = sqlite.exec("INSERT INTO tx_chain (val) VALUES ('bare')").then(() => {
			log.push("bare-done");
		});

		// T2 is serialized after T1 via #transactionChain.
		const t2 = sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_chain (val) VALUES ('t2')");
			log.push("t2-end");
		});

		await Promise.all([t1, t2, barePromise]);

		// Expected order: t1, then bare (deferred from T1), then t2.
		// The bare exec must complete before T2's INSERT (T2 waits for gate which is
		// released after deferred tasks are restored and dispatched).
		const rows = await sqlite.query("SELECT val FROM tx_chain ORDER BY rowid");
		assert.deepEqual(
			rows.map((r) => r.val),
			["t1", "bare", "t2"],
		);

		// 'bare-done' must be logged before 't2-end'.
		assert.ok(log.indexOf("bare-done") < log.indexOf("t2-end"), "deferred bare exec must run before T2");
	});

	test("事务激活期间，外部 SQL 被锁定，只有事务结束后方可执行", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_mutex (val TEXT)");

		const log = [];
		let txFinished = false;

		let resolveBarrier;
		const barrier = new Promise((r) => {
			resolveBarrier = r;
		});

		// 启动事务 T1，在第一条语句执行后发出信号，然后继续持有锁
		const tx1 = sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_mutex (val) VALUES ('tx1-a')");
			// 通知外部事务已激活
			resolveBarrier();
			// 让出控制权，使外部 exec 有机会入队
			await new Promise((r) => setImmediate(r));
			await tx.exec("INSERT INTO tx_mutex (val) VALUES ('tx1-b')");
			txFinished = true;
			log.push("tx1-end");
		});

		// 等待 T1 建立锁定状态
		await barrier;

		// 在事务持有锁期间入队的裸 exec，必须等到 T1 提交后才能执行
		const outsidePromise = sqlite.exec("INSERT INTO tx_mutex (val) VALUES ('outside')").then(() => {
			assert.ok(txFinished, "外部 exec 必须在事务提交后才能执行");
			log.push("outside-end");
		});

		await Promise.all([tx1, outsidePromise]);

		// 验证执行顺序：tx1 必须在外部 exec 之前完成
		assert.ok(log.indexOf("tx1-end") < log.indexOf("outside-end"), "事务必须在外部 exec 之前完成");

		// 验证数据库中的数据顺序
		const rows = await sqlite.query("SELECT val FROM tx_mutex ORDER BY rowid");
		assert.deepEqual(rows.map((r) => r.val), ["tx1-a", "tx1-b", "outside"]);
	});

	test("多个并发事务依次排队，前一个事务完成后方可执行下一个", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_queue (val TEXT)");

		const log = [];

		let resolveBarrier;
		const barrier = new Promise((r) => {
			resolveBarrier = r;
		});

		// T1 持有锁，在第一条语句后发出信号，然后继续执行
		const t1 = sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_queue (val) VALUES ('t1-a')");
			resolveBarrier();
			await new Promise((r) => setImmediate(r));
			await tx.exec("INSERT INTO tx_queue (val) VALUES ('t1-b')");
			log.push("t1-end");
		});

		// 等待 T1 建立锁定
		await barrier;

		// T2 和 T3 在 T1 持有锁期间入队，必须依次等待
		const t2 = sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_queue (val) VALUES ('t2')");
			log.push("t2-end");
		});

		const t3 = sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_queue (val) VALUES ('t3')");
			log.push("t3-end");
		});

		await Promise.all([t1, t2, t3]);

		// 验证执行顺序：t1 → t2 → t3
		assert.deepEqual(log, ["t1-end", "t2-end", "t3-end"]);

		// 验证数据库中的写入顺序
		const rows = await sqlite.query("SELECT val FROM tx_queue ORDER BY rowid");
		assert.deepEqual(rows.map((r) => r.val), ["t1-a", "t1-b", "t2", "t3"]);
	});
});

describe("AbortSignal 支持", () => {
	test("signal 已中止时 exec 立即拒绝", async () => {
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(sqlite.exec("SELECT 1;", [], { signal: controller.signal }), (err) => {
			assert.equal(err.name, "AbortError");
			assert.ok(AbortError.is(err));
			assert.ok(err instanceof AbortError);
			return true;
		});
	});

	test("signal 已中止时 query 立即拒绝", async () => {
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(sqlite.query("SELECT 1;", [], { signal: controller.signal }), (err) => {
			assert.equal(err.name, "AbortError");
			assert.ok(AbortError.is(err));
			assert.ok(err instanceof AbortError);
			return true;
		});
	});

	test("signal 已中止时 run 立即拒绝", async () => {
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(sqlite.run("SELECT 1;", [], { signal: controller.signal }), (err) => {
			assert.equal(err.name, "AbortError");
			assert.ok(AbortError.is(err));
			assert.ok(err instanceof AbortError);
			return true;
		});
	});

	test("任务在队列中时 signal 触发则 exec 以 AbortError 拒绝", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS abort_exec_test (id INTEGER PRIMARY KEY, name TEXT)");

		const controller = new AbortController();

		// Start a query to set queryInFlight > 0, which blocks exec from being dispatched
		const queryPromise = sqlite.query("SELECT 1");

		// Enqueue exec with signal — stays in queue because queryInFlight > 0
		const execPromise = sqlite.exec("INSERT INTO abort_exec_test (name) VALUES ('x')", [], {
			signal: controller.signal,
		});

		// Abort before exec is dispatched
		controller.abort();

		// Use allSettled so both rejections are handled without triggering unhandledRejection
		const [queryResult, execResult] = await Promise.allSettled([queryPromise, execPromise]);

		// Query must still complete normally
		assert.equal(queryResult.status, "fulfilled");

		// Exec should have been cancelled
		assert.equal(execResult.status, "rejected");
		assert.equal(execResult.reason.name, "AbortError");
		assert.ok(AbortError.is(execResult.reason));

		// Nothing should have been inserted
		const rows = await sqlite.query("SELECT * FROM abort_exec_test");
		assert.deepEqual(rows, []);
	});

	test("任务在队列中时 signal 触发则 query 以 AbortError 拒绝", async () => {
		const controller = new AbortController();

		// Start a query to set queryInFlight > 0, blocking the next query
		const firstQueryPromise = sqlite.query("SELECT 1");

		// Enqueue second query with signal — stays in queue because queryInFlight > 0
		const secondQueryPromise = sqlite.query("SELECT 2", [], { signal: controller.signal });

		// Abort before second query is dispatched
		controller.abort();

		// Use allSettled so both rejections are handled without triggering unhandledRejection
		const [firstResult, secondResult] = await Promise.allSettled([firstQueryPromise, secondQueryPromise]);

		// First query must still complete normally
		assert.equal(firstResult.status, "fulfilled");

		// Second query should have been cancelled
		assert.equal(secondResult.status, "rejected");
		assert.equal(secondResult.reason.name, "AbortError");
		assert.ok(AbortError.is(secondResult.reason));
	});

	test("派发后中止不会取消正在执行的 exec", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS abort_inflight_test (id INTEGER PRIMARY KEY, name TEXT)");

		const controller = new AbortController();

		// Exec is dispatched immediately (no other tasks blocking it)
		const execPromise = sqlite.exec("INSERT INTO abort_inflight_test (name) VALUES ('y')", [], {
			signal: controller.signal,
		});

		// Abort after dispatch — should be a no-op
		controller.abort();

		// Exec should still complete
		await execPromise;

		const rows = await sqlite.query("SELECT * FROM abort_inflight_test");
		assert.deepEqual(rows, [{ id: 1, name: "y" }]);
	});

	test("预先中止时 AbortError 携带 controller.abort(reason) 的原因", async () => {
		const controller = new AbortController();
		const customReason = new Error("user cancelled");
		controller.abort(customReason);

		await assert.rejects(sqlite.exec("SELECT 1;", [], { signal: controller.signal }), (err) => {
			assert.ok(err instanceof AbortError);
			assert.strictEqual(err.reason, customReason);
			return true;
		});
	});

	test("任务在队列中被中止时 AbortError 携带 controller.abort(reason) 的原因", async () => {
		const controller = new AbortController();
		const customReason = "custom string reason";

		// Start a query to block the queue
		const firstQueryPromise = sqlite.query("SELECT 1");

		// Enqueue a second query with signal — stays queued
		const secondQueryPromise = sqlite.query("SELECT 2", [], { signal: controller.signal });

		// Abort with a custom reason
		controller.abort(customReason);

		const [firstResult, secondResult] = await Promise.allSettled([firstQueryPromise, secondQueryPromise]);

		assert.equal(firstResult.status, "fulfilled");
		assert.equal(secondResult.status, "rejected");
		assert.ok(secondResult.reason instanceof AbortError);
		assert.strictEqual(secondResult.reason.reason, customReason);
	});
});

describe("错误处理", () => {
	test("sqlite 可执行文件未找到时", async () => {
		const sqlite = new SQLiteWrapper("/path/to/nonexistent/sqlite3");

		await assert
			.rejects(
				async () => {
					await sqlite.exec(
						outdent`
						CREATE TABLE IF NOT EXISTS users (
							id INTEGER PRIMARY KEY AUTOINCREMENT,
							name TEXT
						);

						INSERT INTO users (name) VALUES (?);
						INSERT INTO users (name) VALUES (?);
					`,
						["Alice", "Bob"],
					);
				},
				{
					message: /sqlite3 process error: spawn \/path\/to\/nonexistent\/sqlite3 ENOENT/,
				},
			)
			.finally(() => {
				sqlite.close();
			});
	});
});
