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
			/nonexistent|no such table/i,
		);
	});

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

	test("idle 在无任务时返回 true", () => {
		assert.equal(worker.idle, true);
	});

	test("管线化：批量入队后结果顺序正确", async () => {
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

	test("管线化：在写入中途追加新任务", async () => {
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
