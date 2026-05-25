import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import test, { afterEach, beforeEach, describe } from "node:test";

import outdent from "outdent";

import { SQLiteExecutor } from "./executor.js";
import downloadSQLite3 from "../../script/download-sqlite3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.join(__dirname, "..", "..");
const SQLite3BinaryFile = path.join(root, "bin", "sqlite3" + (process.platform === "win32" ? ".exe" : ""));

/**
 * @type {import("./executor.js").SQLiteExecutor}
 */
let sqlite;

beforeEach(async () => {
	await downloadSQLite3();
	sqlite = new SQLiteExecutor({ binary: SQLite3BinaryFile });
});

afterEach(async () => {
	await sqlite.close();
});

describe("SQLiteExecutor", () => {
	test("execute 和 query 可完成基本建表与查询", async () => {
		await sqlite.execute(
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

		const rows = await sqlite.query("SELECT * FROM users ORDER BY id ASC");
		assert.deepEqual(rows, [
			{ id: 1, name: "Alice" },
			{ id: 2, name: "Bob" },
		]);
	});

	test("query 支持参数化查询", async () => {
		await sqlite.execute(
			outdent`
				CREATE TABLE IF NOT EXISTS query_users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT
				);

				INSERT INTO query_users (name) VALUES (?);
				INSERT INTO query_users (name) VALUES (?);
			`,
			["Alice", "Bob"],
		);

		const rows = await sqlite.query("SELECT * FROM query_users WHERE id > ? ORDER BY id ASC", [1]);
		assert.deepEqual(rows, [{ id: 2, name: "Bob" }]);
	});

	test("queryStream 按行流式消费结果", async () => {
		await sqlite.execute(
			outdent`
				CREATE TABLE IF NOT EXISTS stream_users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT
				);

				WITH RECURSIVE nums(value) AS (
					SELECT 1
					UNION ALL
					SELECT value + 1 FROM nums WHERE value < 50
				)
				INSERT INTO stream_users(name)
				SELECT 'user-' || value FROM nums;
			`,
		);

		const rows = [];
		await sqlite.queryStream("SELECT id, name FROM stream_users ORDER BY id ASC", (row) => {
			rows.push(row);
		});

		assert.equal(rows.length, 50);
		assert.deepEqual(rows[0], { id: 1, name: "user-1" });
		assert.deepEqual(rows[49], { id: 50, name: "user-50" });
	});

	test("串行队列可正确处理并发写入", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS concurrent_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

		const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
		await Promise.all(names.map((name) => sqlite.execute("INSERT INTO concurrent_users (name) VALUES (?)", [name])));

		const rows = await sqlite.query("SELECT name FROM concurrent_users ORDER BY id ASC");
		assert.deepEqual(
			rows.map((row) => row.name),
			names,
		);
	});

	test("transaction 保证上下文独占，不与外部写入交错", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS tx_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

		await Promise.all([
			sqlite.transaction(async (tx) => {
				await tx.execute("INSERT INTO tx_users (name) VALUES (?)", ["first"]);
				await tx.execute("INSERT INTO tx_users (name) VALUES (?)", ["second"]);
			}),
			sqlite.execute("INSERT INTO tx_users (name) VALUES (?)", ["outside"]),
		]);

		const rows = await sqlite.query("SELECT name FROM tx_users ORDER BY id ASC");
		const names = rows.map((row) => row.name);
		assert.equal(names.length, 3);
		assert.equal(names.includes("first"), true);
		assert.equal(names.includes("second"), true);
		assert.equal(names.includes("outside"), true);

		const firstIndex = names.indexOf("first");
		const secondIndex = names.indexOf("second");
		assert.equal(Math.abs(firstIndex - secondIndex), 1);
	});

	test("transaction 在失败时自动回滚", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS rollback_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

		await assert.rejects(
			sqlite.transaction(async (tx) => {
				await tx.execute("INSERT INTO rollback_users (name) VALUES (?)", ["Alice"]);
				throw new Error("stop");
			}),
			/stop/,
		);

		const rows = await sqlite.query("SELECT * FROM rollback_users");
		assert.deepEqual(rows, []);
	});

	test("SQL 错误不会污染后续任务", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS resilient_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
		await sqlite.execute("INSERT INTO resilient_users (name) VALUES (?)", ["Alice"]);

		await assert.rejects(sqlite.query("SELECT * FROM missing_table"), /missing_table/i);

		const rows = await sqlite.query("SELECT * FROM resilient_users ORDER BY id ASC");
		assert.deepEqual(rows, [{ id: 1, name: "Alice" }]);
	});

	test("queryStream 回调抛错时会拒绝当前任务", async () => {
		await sqlite.execute(
			outdent`
				CREATE TABLE IF NOT EXISTS stream_fail_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
				INSERT INTO stream_fail_users (name) VALUES ('A');
				INSERT INTO stream_fail_users (name) VALUES ('B');
			`,
		);

		await assert.rejects(
			sqlite.queryStream("SELECT * FROM stream_fail_users ORDER BY id ASC", (row) => {
				if (row.id === 2) throw new Error("stream consumer failed");
			}),
			/stream consumer failed/,
		);
	});

	test("sqlite 二进制文件缺失时后续请求会被拒绝", async () => {
		const missingPath = path.join(os.tmpdir(), "missing-sqlite3-binary");
		const executor = new SQLiteExecutor({ binary: missingPath, autoRestart: false });

		await new Promise((resolve) => setImmediate(resolve));
		await assert.rejects(executor.query("SELECT 1"), /SQLiteExecutor is closed|spawn|ENOENT|exited unexpectedly/i);
		await executor.close();
	});

	test("close 会拒绝尚未完成的任务", async () => {
		const p1 = sqlite.query("SELECT randomblob(1000000)");
		const p2 = sqlite.query("SELECT 2");
		const settledPromise = Promise.allSettled([p1, p2]);

		await sqlite.close();
		const settled = await settledPromise;
		assert.deepEqual(
			settled.map((item) => item.status),
			["rejected", "rejected"],
		);
	});

	test("pendingStatements 返回待处理任务数", async () => {
		assert.equal(sqlite.pendingStatements, 0);
		const p1 = sqlite.query("SELECT 1");
		assert.equal(sqlite.pendingStatements, 1);
		const p2 = sqlite.query("SELECT 2");
		assert.equal(sqlite.pendingStatements, 2);
		await p1;
		await p2;
		assert.equal(sqlite.pendingStatements, 0);
	});

	test("query 返回空结果集", async () => {
		await sqlite.execute(
			"CREATE TABLE IF NOT EXISTS empty_test (id INTEGER PRIMARY KEY, name TEXT)",
		);
		const rows = await sqlite.query("SELECT * FROM empty_test WHERE id = -1");
		assert.deepEqual(rows, []);
	});

	test("execute 空 SQL 不会报错", async () => {
		await sqlite.execute("");
	});

	test("多次 close 安全（幂等性）", async () => {
		await sqlite.close();
		await sqlite.close();
	});

	test("使用 :memory: 数据库创建 executor", async () => {
		const mem = new SQLiteExecutor({ binary: SQLite3BinaryFile });
		try {
			const result = await mem.query("SELECT 1 AS val");
			assert.deepEqual(result, [{ val: 1 }]);
		} finally {
			await mem.close();
		}
	});

	test("transaction 支持 query 和 queryStream 操作", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS tx_full (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
		const result = await sqlite.transaction(async (tx) => {
			await tx.execute("INSERT INTO tx_full (val) VALUES (?)", ["a"]);
			await tx.execute("INSERT INTO tx_full (val) VALUES (?)", ["b"]);
			const rows = await tx.query("SELECT * FROM tx_full ORDER BY id ASC");
			return rows;
		});
		assert.equal(result.length, 2);
		assert.equal(result[0].val, "a");
		assert.equal(result[1].val, "b");
	});

	test("transaction 使用非法的 mode 抛出 TypeError", async () => {
		await assert.rejects(
			sqlite.transaction(async () => {}, { mode: "INVALID" }),
			/transaction mode must be one of/,
		);
	});

	test("statementTimeout 为非法值时抛出 TypeError", () => {
		assert.throws(() => new SQLiteExecutor({ binary: SQLite3BinaryFile, statementTimeout: -1 }), /positive integer/);
		assert.throws(() => new SQLiteExecutor({ binary: SQLite3BinaryFile, statementTimeout: 0 }), /positive integer/);
		assert.throws(() => new SQLiteExecutor({ binary: SQLite3BinaryFile, statementTimeout: 1.5 }), /positive integer/);
	});

	test("多次 transaction 按顺序执行不交错", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS seq_tx (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");

		const results = [];
		await Promise.all([
			sqlite.transaction(async (tx) => {
				await tx.execute("INSERT INTO seq_tx (val) VALUES (?)", ["tx1"]);
				await new Promise((r) => setTimeout(r, 50));
				await tx.execute("INSERT INTO seq_tx (val) VALUES (?)", ["tx1-late"]);
			}),
			sqlite.transaction(async (tx) => {
				await tx.execute("INSERT INTO seq_tx (val) VALUES (?)", ["tx2"]);
			}),
		]);

		const rows = await sqlite.query("SELECT val FROM seq_tx ORDER BY id ASC");
		const vals = rows.map((r) => r.val);
		assert.equal(vals.length, 3, "三个插入都应成功");
	});

	test("多个 executor 实例独立运行", async () => {
		const sqlite2 = new SQLiteExecutor({ binary: SQLite3BinaryFile });
		try {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS exec_a (id INTEGER PRIMARY KEY, name TEXT)");
			await sqlite2.execute("CREATE TABLE IF NOT EXISTS exec_b (id INTEGER PRIMARY KEY, name TEXT)");
			await sqlite.execute("INSERT INTO exec_a VALUES (1, 'from-a')");
			await sqlite2.execute("INSERT INTO exec_b VALUES (1, 'from-b')");
			const rowsA = await sqlite.query("SELECT * FROM exec_a");
			const rowsB = await sqlite2.query("SELECT * FROM exec_b");
			assert.equal(rowsA[0].name, "from-a");
			assert.equal(rowsB[0].name, "from-b");
		} finally {
			await sqlite2.close();
		}
	});

	test("query 结果中包含 null 值", async () => {
		await sqlite.execute(
			"CREATE TABLE IF NOT EXISTS null_test (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)",
		);
		await sqlite.execute("INSERT INTO null_test VALUES (1, 'Alice', NULL)");
		const rows = await sqlite.query("SELECT * FROM null_test");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].name, "Alice");
		assert.equal(rows[0].age, null);
	});
});
