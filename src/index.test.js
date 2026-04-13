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
	test("create table", async () => {
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

	test("create table and query", async () => {
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

	test("create table and query and update", async () => {
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

	test("run returns changes and lastInsertRowid for INSERT", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS run_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

		const result = await sqlite.run("INSERT INTO run_users (name) VALUES (?)", ["Alice"]);
		assert.equal(result.changes, 1);
		assert.equal(result.lastInsertRowid, 1);

		const result2 = await sqlite.run("INSERT INTO run_users (name) VALUES (?)", ["Bob"]);
		assert.equal(result2.changes, 1);
		assert.equal(result2.lastInsertRowid, 2);
	});

	test("run returns changes for UPDATE", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS run_update_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
		await sqlite.exec("INSERT INTO run_update_users (name) VALUES (?)", ["Alice"]);
		await sqlite.exec("INSERT INTO run_update_users (name) VALUES (?)", ["Bob"]);

		const result = await sqlite.run("UPDATE run_update_users SET name = ? WHERE id = ?", ["Charlie", 1]);
		assert.equal(result.changes, 1);

		const noOpResult = await sqlite.run("UPDATE run_update_users SET name = ? WHERE id = ?", ["Dave", 999]);
		assert.equal(noOpResult.changes, 0);
	});

	test("run returns changes for DELETE", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS run_delete_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
		await sqlite.exec("INSERT INTO run_delete_users (name) VALUES (?)", ["Alice"]);
		await sqlite.exec("INSERT INTO run_delete_users (name) VALUES (?)", ["Bob"]);

		const result = await sqlite.run("DELETE FROM run_delete_users WHERE id = ?", [1]);
		assert.equal(result.changes, 1);
	});

	test("create table and query with Chinese characters", async () => {
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

	test("handles concurrent enqueued writes correctly", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS concurrent_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

		const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

		await Promise.all(names.map((name) => sqlite.exec("INSERT INTO concurrent_users (name) VALUES (?)", [name])));

		const rows = await sqlite.query("SELECT name FROM concurrent_users ORDER BY id ASC");
		assert.deepEqual(
			rows.map((row) => row.name),
			names,
		);
	});

	test("handles large burst enqueued writes", async () => {
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

	test("keeps result sets separated for batched concurrent queries", async () => {
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

	test("isolates a failed statement from a later successful statement in the same batch", async () => {
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

	test("does not misattribute errors to successful concurrent queries", async () => {
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

	test("rejects when sqlite binary is missing", async () => {
		const missingPath = path.join(os.tmpdir(), "missing-sqlite3-binary");
		const wrapper = new SQLiteWrapper(missingPath);

		// Allow spawn error handler to mark the wrapper as closed
		await new Promise((resolve) => setImmediate(resolve));

		await assert.rejects(wrapper.exec("SELECT 1;"), /closed SQLiteWrapper/);
		wrapper.close();
	});

	test("rejects pending queued requests when close is called", async () => {
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

	test("[Symbol.dispose] rejects queued tasks rather than silently dropping them", async () => {
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

	test("executes SQL containing inline line comments without hanging", async () => {
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

	test("accepts custom queue tuning options", async () => {
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

	test("throws for invalid queue tuning options", () => {
		assert.throws(() => new SQLiteWrapper(SQLite3BinaryFile, { maxInFlight: 0 }), /maxInFlight must be a positive integer/);
		assert.throws(
			() => new SQLiteWrapper(SQLite3BinaryFile, { maxBatchChars: -1 }),
			/maxBatchChars must be a positive integer/,
		);
	});

	test("emits onTiming callback with queue/run/total metrics", async () => {
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
	test("commits successfully and returns fn return value", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_commit (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");

		const result = await sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_commit (val) VALUES (?)", ["hello"]);
			return 42;
		});

		assert.equal(result, 42);

		const rows = await sqlite.query("SELECT val FROM tx_commit");
		assert.deepEqual(rows, [{ val: "hello" }]);
	});

	test("rolls back on error and rethrows", async () => {
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

	test("serializes concurrent transactions so they never interleave", async () => {
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

	test("second transaction proceeds after first rolls back", async () => {
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

	test("tx object exposes exec, run, and query but not transaction", async () => {
		await sqlite.transaction(async (tx) => {
			assert.equal(typeof tx.exec, "function");
			assert.equal(typeof tx.run, "function");
			assert.equal(typeof tx.query, "function");
			assert.equal(typeof tx.transaction, "undefined");
		});
	});

	test("tx.run returns changes and lastInsertRowid inside transaction", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_run (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");

		const result = await sqlite.transaction(async (tx) => {
			return tx.run("INSERT INTO tx_run (val) VALUES (?)", ["x"]);
		});

		assert.equal(result.changes, 1);
		assert.equal(result.lastInsertRowid, 1);
	});

	test("tx.query returns rows inside transaction", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_query (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
		await sqlite.exec("INSERT INTO tx_query (val) VALUES (?)", ["visible"]);

		const rows = await sqlite.transaction(async (tx) => {
			return tx.query("SELECT val FROM tx_query");
		});

		assert.deepEqual(rows, [{ val: "visible" }]);
	});

	test("IMMEDIATE transaction type succeeds", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_immediate (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");

		await sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_immediate (val) VALUES (?)", ["imm"]);
		}, "IMMEDIATE");

		const rows = await sqlite.query("SELECT val FROM tx_immediate");
		assert.deepEqual(rows, [{ val: "imm" }]);
	});

	test("EXCLUSIVE transaction type succeeds", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS tx_exclusive (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");

		await sqlite.transaction(async (tx) => {
			await tx.exec("INSERT INTO tx_exclusive (val) VALUES (?)", ["excl"]);
		}, "EXCLUSIVE");

		const rows = await sqlite.query("SELECT val FROM tx_exclusive");
		assert.deepEqual(rows, [{ val: "excl" }]);
	});

	test("throws TypeError for invalid transaction type", async () => {
		await assert.rejects(
			sqlite.transaction(async () => {}, "INVALID"),
			/transaction type must be one of/,
		);
	});

	test("bare exec calls during a transaction are deferred until after commit", async () => {
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

	test("deferred tasks are not re-deferred by the next transaction", async () => {
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
});

describe("AbortSignal support", () => {
	test("exec rejects immediately when signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(sqlite.exec("SELECT 1;", [], { signal: controller.signal }), (err) => {
			assert.equal(err.name, "AbortError");
			assert.ok(AbortError.is(err));
			assert.ok(err instanceof AbortError);
			return true;
		});
	});

	test("query rejects immediately when signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(sqlite.query("SELECT 1;", [], { signal: controller.signal }), (err) => {
			assert.equal(err.name, "AbortError");
			assert.ok(AbortError.is(err));
			assert.ok(err instanceof AbortError);
			return true;
		});
	});

	test("run rejects immediately when signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(sqlite.run("SELECT 1;", [], { signal: controller.signal }), (err) => {
			assert.equal(err.name, "AbortError");
			assert.ok(AbortError.is(err));
			assert.ok(err instanceof AbortError);
			return true;
		});
	});

	test("exec rejects with AbortError when signal fires while task is queued", async () => {
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

	test("query rejects with AbortError when signal fires while task is queued", async () => {
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

	test("aborting after dispatch does not cancel an in-flight exec", async () => {
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

	test("AbortError carries the reason from controller.abort(reason) when pre-aborted", async () => {
		const controller = new AbortController();
		const customReason = new Error("user cancelled");
		controller.abort(customReason);

		await assert.rejects(sqlite.exec("SELECT 1;", [], { signal: controller.signal }), (err) => {
			assert.ok(err instanceof AbortError);
			assert.strictEqual(err.reason, customReason);
			return true;
		});
	});

	test("AbortError carries the reason from controller.abort(reason) when aborted while queued", async () => {
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

describe("Error handling", () => {
	test("If sqlite executable file is not found", async () => {
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
