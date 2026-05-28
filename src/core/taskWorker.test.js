import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import { TaskWorker } from "./taskWorker.js";
import downloadSQLite3 from "../../script/download-sqlite3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..", "..");
const SQLite3BinaryFile = path.join(root, "bin", "sqlite3" + (process.platform === "win32" ? ".exe" : ""));

/* eslint-disable no-underscore-dangle */

/**
 * @type {TaskWorker}
 */
let worker;

beforeEach(async () => {
	await downloadSQLite3();
	worker = new TaskWorker({
		binary: SQLite3BinaryFile,
		database: ":memory:",
		statementTimeout: 30000,
		name: "test-worker",
	});
});

afterEach(async () => {
	worker.kill();
});

describe("TaskWorker", () => {
	describe("基本操作", () => {
		test("execute SQL 并完成", async () => {
			const result = await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "execute",
					sql: "CREATE TABLE t (id INTEGER)",
					timeout: 10000,
					token: "tok-1",
					onRow: null,
					resolve,
					reject,
				});
			});
			assert.equal(result, undefined);
		});

		test("query 返回结果行", async () => {
			await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "execute",
					sql: "CREATE TABLE t2 (id INTEGER, val TEXT)",
					timeout: 10000,
					token: "tok-2",
					onRow: null,
					resolve,
					reject,
				});
			});

			const rows = await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT 1 AS a UNION SELECT 2 AS a",
					timeout: 10000,
					token: "tok-3",
					onRow: null,
					resolve,
					reject,
				});
			});
			assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
		});

		test("idle 在无任务时返回 true", () => {
			assert.equal(worker.idle, true);
		});
	});

	describe("串行与批量", () => {
		test("串行执行多个任务", async () => {
			const results = [];
			for (let i = 0; i < 5; i++) {
				const rows = await new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "query",
						sql: `SELECT ${i} AS v`,
						timeout: 10000,
						token: `tok-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				});
				results.push(rows[0].v);
			}
			assert.deepEqual(results, [0, 1, 2, 3, 4]);
		});

		test("批量 execute 任务串行执行", async () => {
			await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "execute",
					sql: "CREATE TABLE t_batch_exec (id INTEGER PRIMARY KEY, val TEXT)",
					timeout: 10000,
					token: "tok-be-setup",
					onRow: null,
					resolve,
					reject,
				});
			});

			const promises = [];
			for (let i = 0; i < 5; i++) {
				promises.push(new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "execute",
						sql: `INSERT INTO t_batch_exec VALUES (${i + 1}, 'v${i + 1}')`,
						timeout: 10000,
						token: `tok-be-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				}));
			}
			await Promise.all(promises);

			const rows = await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT * FROM t_batch_exec ORDER BY id",
					timeout: 10000,
					token: "tok-be-check",
					onRow: null,
					resolve,
					reject,
				});
			});

			assert.equal(rows.length, 5);
		});
	});

	describe("管线化", () => {
		test("批量入队后结果顺序正确", async () => {
			await new Promise((resolve, reject) => {
				worker.enqueue({ kind: "execute", sql: "CREATE TABLE t_pipe (id INTEGER, val TEXT)", timeout: 10000, token: "tok-setup", onRow: null, resolve, reject });
			});

			const promises = [];
			for (let i = 0; i < 20; i++) {
				promises.push(new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "query",
						sql: `SELECT ${i} AS v, '${i * 2}' AS w`,
						timeout: 10000,
						token: `tok-pipe-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				}));
			}

			const results = await Promise.all(promises);
			assert.equal(results.length, 20);
			for (let i = 0; i < 20; i++) {
				assert.equal(results[i][0].v, i);
				assert.equal(results[i][0].w, String(i * 2));
			}
		});

		test("在写入中途追加新任务", async () => {
			const promises = [];
			for (let i = 0; i < 5; i++) {
				promises.push(new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "query",
						sql: `SELECT ${i} AS v`,
						timeout: 10000,
						token: `tok-append-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				}));
			}

			await promises[0];

			for (let i = 5; i < 10; i++) {
				promises.push(new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "query",
						sql: `SELECT ${i} AS v`,
						timeout: 10000,
						token: `tok-append-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				}));
			}

			const results = await Promise.all(promises);
			assert.equal(results.length, 10);
			for (let i = 0; i < 10; i++) {
				assert.equal(results[i][0].v, i);
			}
		});
	});

	describe("错误处理", () => {
		test("SQL 错误时 reject", async () => {
			await assert.rejects(
				new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "query",
						sql: "SELECT * FROM nonexistent",
						timeout: 10000,
						token: "tok-error",
						onRow: null,
						resolve,
						reject,
					});
				}),
			);
		});
	});

	describe("状态查询", () => {
		test("pendingStatements 返回待处理数", async () => {
			assert.equal(worker.pendingStatements, 0);
			const p1 = new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT 1",
					timeout: 10000,
					token: "tok-ps-1",
					onRow: null,
					resolve,
					reject,
				});
			});
			assert.equal(worker.pendingStatements, 1);
			const p2 = new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT 2",
					timeout: 10000,
					token: "tok-ps-2",
					onRow: null,
					resolve,
					reject,
				});
			});
			assert.equal(worker.pendingStatements, 2);
			await p1;
			await p2;
		});
	});

	describe("生命周期管理", () => {
		test("kill 后拒绝待处理任务", async () => {
			const p = new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT 1",
					timeout: 10000,
					token: "tok-kill",
					onRow: null,
					resolve,
					reject,
				});
			});
			worker.kill();
			await assert.rejects(p, /killed/i);
		});

		test("进程异常退出（SIGKILL）后拒绝待处理任务", async () => {
			const p = new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT 1",
					timeout: 30000,
					token: "tok-crash",
					onRow: null,
					resolve,
					reject,
				});
			});
			await new Promise((r) => setImmediate(r));
			worker._process.kill("SIGKILL");
			await assert.rejects(p, /exited unexpectedly/);
		});
	});

	describe("超时", () => {
		test("超时只拒绝超时任务，其他 inflight 任务正常完成", { timeout: 30000 }, async () => {
			const p1 = new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "execute",
					sql: "SELECT randomblob(1000000)",
					timeout: 10,
					token: "tok-to-1",
					onRow: null,
					resolve,
					reject,
				});
			});

			const p2 = new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT 1 AS v",
					timeout: 30000,
					token: "tok-to-2",
					onRow: null,
					resolve,
					reject,
				});
			});

			const p3 = new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT 2 AS v",
					timeout: 30000,
					token: "tok-to-3",
					onRow: null,
					resolve,
					reject,
				});
			});

			const results = await Promise.allSettled([p1, p2, p3]);

			assert.equal(results[0].status, "rejected", "t1 应超时");
			assert.ok(results[0].reason.message.includes("timed out"), `t1 错误应为超时: ${results[0].reason.message}`);
			assert.equal(results[1].status, "fulfilled", "t2 应正常完成");
			assert.deepEqual(results[1].value, [{ v: 1 }], "t2 结果正确");
			assert.equal(results[2].status, "fulfilled", "t3 应正常完成");
			assert.deepEqual(results[2].value, [{ v: 2 }], "t3 结果正确");
		});
	});

	describe("并发与压力", () => {
		test("200 并发突袭 INSERT 不产生 UNIQUE 冲突", async () => {
			await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "execute",
					sql: "CREATE TABLE IF NOT EXISTS burst_worker (id INTEGER PRIMARY KEY, val TEXT)",
					timeout: 30000,
					token: "tok-bw-setup",
					onRow: null,
					resolve,
					reject,
				});
			});

			const promises = [];
			for (let i = 0; i < 200; i++) {
				promises.push(new Promise((resolve, reject) => {
					worker.enqueue({
						kind: "execute",
						sql: `INSERT INTO burst_worker (id, val) VALUES (${i}, 'w${i}')`,
						timeout: 30000,
						token: `tok-bw-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				}));
			}
			await Promise.all(promises);

			const rows = await new Promise((resolve, reject) => {
				worker.enqueue({
					kind: "query",
					sql: "SELECT id, val FROM burst_worker ORDER BY id",
					timeout: 30000,
					token: "tok-bw-check",
					onRow: null,
					resolve,
					reject,
				});
			});

			assert.equal(rows.length, 200, "200 条应全部写入");
			for (let i = 0; i < 200; i++) {
				assert.equal(rows[i].id, i, `id=${i}`);
				assert.equal(rows[i].val, `w${i}`, `val=w${i}`);
			}
		});
	});
});
