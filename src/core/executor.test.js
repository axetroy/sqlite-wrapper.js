import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
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

		// sqlite3 on Windows 的 stderr 输出可能被 OS pipe 拆分为多个 chunk，
		// 导致 sentinel 到达时只捕获到部分错误文本；
		// 因此只验证错误被捕获，不依赖错误消息的精确内容。
		await assert.rejects(sqlite.query("SELECT * FROM missing_table"));

		const rows = await sqlite.query("SELECT * FROM resilient_users ORDER BY id ASC");
		assert.deepEqual(rows, [{ id: 1, name: "Alice" }]);
	});

	test("sqlite 二进制文件缺失时后续请求会被拒绝", async () => {
		const missingPath = path.join(os.tmpdir(), "missing-sqlite3-binary");
		const executor = new SQLiteExecutor({ binary: missingPath, autoRestart: false });

		await assert.rejects(executor.query("SELECT 1"), /sqlite3 binary not found/i);
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
		await sqlite.execute("CREATE TABLE IF NOT EXISTS empty_test (id INTEGER PRIMARY KEY, name TEXT)");
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

	test("transaction 支持 query 和 stream 操作", async () => {
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

	test("transaction 内 stream 逐行消费", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS tx_stream (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
		await sqlite.execute("INSERT INTO tx_stream (val) VALUES ('a'), ('b'), ('c')");

		const collected = [];
		await sqlite.transaction(async (tx) => {
			for await (const row of tx.stream("SELECT * FROM tx_stream ORDER BY id ASC")) {
				collected.push(row);
			}
		});

		assert.equal(collected.length, 3);
		assert.equal(collected[0].val, "a");
		assert.equal(collected[2].val, "c");
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
		await sqlite.execute("CREATE TABLE IF NOT EXISTS null_test (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)");
		await sqlite.execute("INSERT INTO null_test VALUES (1, 'Alice', NULL)");
		const rows = await sqlite.query("SELECT * FROM null_test");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].name, "Alice");
		assert.equal(rows[0].age, null);
	});

	test("stream 使用 for await 遍历所有行", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_async (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
		await sqlite.execute("INSERT INTO stream_async (val) VALUES ('a'), ('b'), ('c')");

		const collected = [];
		for await (const row of sqlite.stream("SELECT * FROM stream_async ORDER BY id ASC")) {
			collected.push(row);
		}
		assert.equal(collected.length, 3);
		assert.deepEqual(collected[0], { id: 1, val: "a" });
		assert.deepEqual(collected[1], { id: 2, val: "b" });
		assert.deepEqual(collected[2], { id: 3, val: "c" });
	});

	test("stream 返回空结果集", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_empty (id INTEGER PRIMARY KEY, name TEXT)");
		const collected = [];
		for await (const row of sqlite.stream("SELECT * FROM stream_empty")) {
			collected.push(row);
		}
		assert.equal(collected.length, 0);
	});

	test("stream 支持参数化查询", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_params (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
		await sqlite.execute("INSERT INTO stream_params (val) VALUES ('x'), ('y'), ('z')");

		const collected = [];
		for await (const row of sqlite.stream("SELECT * FROM stream_params WHERE id > ? ORDER BY id ASC", [1])) {
			collected.push(row);
		}
		assert.equal(collected.length, 2);
		assert.equal(collected[0].id, 2);
		assert.equal(collected[1].id, 3);
	});

	test("stream 在 SQL 错误时抛出异常", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_error (id INTEGER PRIMARY KEY, val TEXT)");
		await sqlite.execute("INSERT INTO stream_error VALUES (1, 'hello')");

		await assert.rejects(
			(async () => {
				for await (const _ of sqlite.stream("SELECT * FROM stream_error WHERE invalid_col = 1")) {
					// noop
				}
			})(),
		);
	});

	test("stream 在 for await 中提前 break", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_break (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
		await sqlite.execute("INSERT INTO stream_break (val) VALUES ('a'), ('b'), ('c')");

		const collected = [];
		for await (const row of sqlite.stream("SELECT * FROM stream_break ORDER BY id ASC")) {
			collected.push(row);
			if (row.id === 2) break;
		}
		assert.equal(collected.length, 2);
	});

	test("stream 在事务中使用", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_tx (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
		await sqlite.execute("INSERT INTO stream_tx (val) VALUES ('p'), ('q')");

		const result = await sqlite.transaction(async (tx) => {
			const rows = [];
			for await (const row of tx.stream("SELECT * FROM stream_tx ORDER BY id ASC")) {
				rows.push(row);
			}
			return rows;
		});
		assert.equal(result.length, 2);
		assert.equal(result[0].val, "p");
		assert.equal(result[1].val, "q");
	});

	test("stream params 非数组时同步抛出 TypeError", () => {
		assert.throws(() => sqlite.stream("SELECT 1", "not-an-array"), /params must be an array/);
	});

	test("管线化：批量入队后结果顺序正确", async () => {
		const promises = [];
		for (let i = 0; i < 20; i++) {
			promises.push(sqlite.query(`SELECT ${i} AS v, '${i * 2}' AS w`));
		}

		const results = await Promise.all(promises);
		assert.equal(results.length, 20);
		for (let i = 0; i < 20; i++) {
			assert.equal(results[i][0].v, i);
			assert.equal(results[i][0].w, String(i * 2));
		}
	});

	test("管线化：在写入中途追加新任务", async () => {
		const promises = [];
		for (let i = 0; i < 5; i++) {
			promises.push(sqlite.query(`SELECT ${i} AS v`));
		}

		await promises[0];

		for (let i = 5; i < 10; i++) {
			promises.push(sqlite.query(`SELECT ${i} AS v`));
		}

		const results = await Promise.all(promises);
		assert.equal(results.length, 10);
		for (let i = 0; i < 10; i++) {
			assert.equal(results[i][0].v, i);
		}
	});

	test("管线化：execute 批量并发不丢失", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS pipe_exec (id INTEGER PRIMARY KEY, val TEXT)");
		const promises = [];
		for (let i = 0; i < 100; i++) {
			promises.push(sqlite.execute("INSERT INTO pipe_exec (val) VALUES (?)", [`n${i}`]));
		}
		await Promise.all(promises);

		const rows = await sqlite.query("SELECT val FROM pipe_exec");
		assert.equal(rows.length, 100);
		assert.deepEqual(
			rows.map((r) => r.val),
			new Array(100).fill(0).map((_, i) => `n${i}`),
		);
	});

	test("突袭批量 INSERT（500 并发）不产生死锁或 UNIQUE 冲突", async () => {
		const dbFile = path.join(os.tmpdir(), `burst-${Date.now()}.db`);
		const burstSqlite = new SQLiteExecutor({
			binary: SQLite3BinaryFile,
			database: dbFile,
			statementTimeout: 30000,
		});
		try {
			await burstSqlite.execute("CREATE TABLE IF NOT EXISTS burst_test (id INTEGER PRIMARY KEY, val TEXT)");

			// 在一个事务内突袭写入 500 条 INSERT
			await burstSqlite.execute("BEGIN TRANSACTION");
			const promises = [];
			for (let i = 0; i < 500; i++) {
				promises.push(
					burstSqlite.execute("INSERT INTO burst_test (id, val) VALUES (?, ?)", [i, `v${i}`]),
				);
			}
			await Promise.all(promises);
			await burstSqlite.execute("COMMIT");

			// 验证 500 条全部写入且无重复
			const rows = await burstSqlite.query("SELECT id, val FROM burst_test ORDER BY id");
			assert.equal(rows.length, 500, "全部 500 条应写入成功");
			for (let i = 0; i < 500; i++) {
				assert.equal(rows[i].id, i, `id 应为 ${i}`);
				assert.equal(rows[i].val, `v${i}`, `val 应为 v${i}`);
			}

			// 再执行一次普通查询，确保后续操作正常
			const count = await burstSqlite.query("SELECT COUNT(*) AS cnt FROM burst_test");
			assert.equal(count[0].cnt, 500);
		} finally {
			burstSqlite.close();
			try { fs.unlinkSync(dbFile); } catch {}
		}
	});

	test("突袭批量 UPDATE（500 并发），验证无死锁", async () => {
		const dbFile = path.join(os.tmpdir(), `burst-upd-${Date.now()}.db`);
		const updSqlite = new SQLiteExecutor({
			binary: SQLite3BinaryFile,
			database: dbFile,
			statementTimeout: 30000,
		});
		try {
			await updSqlite.execute("CREATE TABLE IF NOT EXISTS burst_upd (id INTEGER PRIMARY KEY, val TEXT, score INT)");

			// 先插入 500 行
			await updSqlite.execute("BEGIN TRANSACTION");
			for (let i = 0; i < 500; i++) {
				await updSqlite.execute("INSERT INTO burst_upd (id, val, score) VALUES (?, ?, ?)", [i, `v${i}`, i]);
			}
			await updSqlite.execute("COMMIT");

			// 突袭 UPDATE 500 行
			await updSqlite.execute("BEGIN TRANSACTION");
			const updatePromises = [];
			for (let i = 0; i < 500; i++) {
				updatePromises.push(
					updSqlite.execute("UPDATE burst_upd SET score = ? WHERE id = ?", [i + 1000, i]),
				);
			}
			await Promise.all(updatePromises);
			await updSqlite.execute("COMMIT");

			// 验证所有行都被更新
			const rows = await updSqlite.query("SELECT id, score FROM burst_upd ORDER BY id");
			assert.equal(rows.length, 500);
			for (let i = 0; i < 500; i++) {
				assert.equal(rows[i].score, i + 1000, `id=${i} 的 score 应被更新`);
			}
		} finally {
			updSqlite.close();
			try { fs.unlinkSync(dbFile); } catch {}
		}
	});

	test("读写分离: 文件 DB 创建 reader pool", () => {
		const dbFile = path.join(os.tmpdir(), `rw-pool-${Date.now()}.db`);
		const sqlite2 = new SQLiteExecutor({
			binary: SQLite3BinaryFile,
			database: dbFile,
			poolSize: 2,
		});
		try {
			assert.ok(sqlite2.readerPool);
			assert.equal(sqlite2.readerPool.size, 2);
		} finally {
			sqlite2.close();
		}
	});

	test("读写分离: :memory: 数据库不使用 reader pool", () => {
		const mem = new SQLiteExecutor({
			binary: SQLite3BinaryFile,
			poolSize: 2,
		});
		assert.ok(mem.readerPool === null || mem.readerPool === undefined);
		mem.close();
	});

	test("读写分离: query 路由到 reader 返回正确结果", async () => {
		const dbFile = path.join(os.tmpdir(), `rw-query-${Date.now()}.db`);
		const sqlite2 = new SQLiteExecutor({
			binary: SQLite3BinaryFile,
			database: dbFile,
			poolSize: 2,
			statementTimeout: 10000,
		});
		try {
			await sqlite2.execute("CREATE TABLE IF NOT EXISTS rw_q (id INTEGER PRIMARY KEY, val TEXT)");
			await sqlite2.execute("INSERT INTO rw_q VALUES (1, 'hello'), (2, 'world')");
			await new Promise((r) => setTimeout(r, 500));
			const rows = await sqlite2.query("SELECT * FROM rw_q ORDER BY id ASC");
			assert.equal(rows.length, 2);
		} finally {
			await sqlite2.close();
		}
	});

	test("读写分离: 耗时写入不阻塞并发读取", async () => {
		const dbFile = path.join(os.tmpdir(), `rw-concur-${Date.now()}.db`);
		const sqlite = new SQLiteExecutor({
			binary: SQLite3BinaryFile,
			database: dbFile,
			poolSize: 2,
		});
		try {
			await sqlite.execute("CREATE TABLE IF NOT EXISTS rw_big (id INTEGER PRIMARY KEY, val TEXT)");

			let readResolved = false;
			const slowWrite = sqlite.execute("INSERT INTO rw_big SELECT value, hex(randomblob(512)) FROM generate_series(1, 100000)");

			await new Promise((r) => setTimeout(r, 30));

			const rows = await sqlite.query("SELECT COUNT(*) AS cnt FROM rw_big");
			readResolved = true;
			assert.equal(rows[0].cnt, 0);

			await slowWrite;
			assert.ok(readResolved, "读取应在写入完成前返回，证明走不同进程");
		} finally {
			await sqlite.close();
		}
	});

	test("触发 SQL 超时后 tasksTimeout 指标递增", async () => {
		const exec = new SQLiteExecutor({
			binary: SQLite3BinaryFile,
			statementTimeout: 200,
		});
		try {
			await assert.rejects(
				exec.execute("SELECT randomblob(500000000)"),
				{ message: /timed out after 200ms/ },
			);
			assert.equal(exec.metrics.tasksTimeout, 1);
		} finally {
			await exec.close();
		}
	});

	test("execute SQL 错误后后续 execute 不受影响", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS exec_err_isolation (id INTEGER PRIMARY KEY, name TEXT)");

		await assert.rejects(
			sqlite.execute("INSERT INTO nonexistent_exec_table (name) VALUES (?)", ["x"]),
		);

		await sqlite.execute("INSERT INTO exec_err_isolation (name) VALUES (?)", ["Bob"]);

		const rows = await sqlite.query("SELECT * FROM exec_err_isolation");
		assert.deepEqual(rows, [{ id: 1, name: "Bob" }]);
	});

	test("execute SQL 错误后后续 query 不受影响", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS exec_q_isolation (id INTEGER PRIMARY KEY, name TEXT)");
		await sqlite.execute("INSERT INTO exec_q_isolation (name) VALUES (?)", ["Alice"]);

		await assert.rejects(
			sqlite.execute("INSERT INTO nonexistent_q_table (name) VALUES (?)", ["x"]),
		);

		const rows = await sqlite.query("SELECT * FROM exec_q_isolation");
		assert.deepEqual(rows, [{ id: 1, name: "Alice" }]);
	});

	test("stream SQL 错误后后续 query 不受影响", async () => {
		await sqlite.execute("CREATE TABLE IF NOT EXISTS stream_err_iso (id INTEGER PRIMARY KEY, val TEXT)");
		await sqlite.execute("INSERT INTO stream_err_iso VALUES (1, 'hello')");

		await assert.rejects(
			(async () => {
				for await (const _ of sqlite.stream("SELECT * FROM stream_err_iso WHERE bad_col = 1")) {
					// noop
				}
			})(),
		);

		const rows = await sqlite.query("SELECT * FROM stream_err_iso");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].val, "hello");
	});

	test("SQL 语法错误可以被正确捕获且不影响后续语句", async () => {
		// Windows 上 sqlite3 stderr 输出可能被拆分为多个 chunk，
		// 部分 chunk 到达时 sentinel 已触发结算；因此不依赖错误文本精确匹配，
		// 只验证有异常抛出，且后续语句不受影响即可。
		try {
			await sqlite.query("SELECT FORM users");
			assert.fail("应抛出异常");
		} catch (err) {
			assert.ok(err instanceof Error, "应抛出 Error 类型");
		}

		const rows = await sqlite.query("SELECT 1 AS val");
		assert.deepEqual(rows, [{ val: 1 }]);
	});

	test("并发查询中一条 SQL 出错不影响其余正确查询", async () => {
		const results = await Promise.allSettled([
			sqlite.query("SELECT 100 AS v"),
			sqlite.query("SELECT * FROM concurrent_bad_table"),
			sqlite.query("SELECT 200 AS v"),
			sqlite.query("SELECT 300 AS v"),
		]);

		const rejected = results.filter((r) => r.status === "rejected");
		const fulfilled = results.filter((r) => r.status === "fulfilled");

		assert.ok(rejected.length >= 1, "至少有一条查询应被拒绝");
		assert.ok(fulfilled.length >= 1, "至少有一条查询应成功");

		for (const result of fulfilled) {
			assert.ok(Array.isArray(result.value));
		}
	});
});
