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
