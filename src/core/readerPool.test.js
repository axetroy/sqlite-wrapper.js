import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import { ReaderPool } from "./readerPool.js";
import downloadSQLite3 from "../../script/download-sqlite3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..", "..");
const SQLite3BinaryFile = path.join(root, "bin", "sqlite3" + (process.platform === "win32" ? ".exe" : ""));

/**
 * @type {ReaderPool}
 */
let pool;

beforeEach(async () => {
	await downloadSQLite3();
	pool = new ReaderPool({
		binary: SQLite3BinaryFile,
		database: ":memory:",
		poolSize: 2,
		statementTimeout: 30000,
	});
});

afterEach(async () => {
	pool.kill();
});

describe("ReaderPool", () => {
	test("正确创建指定数量的 reader", () => {
		assert.equal(pool.size, 2);
	});

	test("round-robin 分发任务", async () => {
		const results = [];
		for (let i = 0; i < 4; i++) {
			const rows = await new Promise((resolve, reject) => {
				pool.enqueue({
					kind: "query",
					sql: `SELECT ${i} AS v`,
					timeout: 10000,
					token: `rr-tok-${i}`,
					onRow: null,
					resolve,
					reject,
				});
			});
			results.push(rows[0].v);
		}
		assert.deepEqual(results, [0, 1, 2, 3]);
	});

	test("并发执行多个查询", async () => {
		const promises = [];
		for (let i = 0; i < 6; i++) {
			promises.push(
				new Promise((resolve, reject) => {
					pool.enqueue({
						kind: "query",
						sql: `SELECT ${i} AS v`,
						timeout: 10000,
						token: `con-tok-${i}`,
						onRow: null,
						resolve,
						reject,
					});
				}),
			);
		}
		const all = await Promise.all(promises);
		const vals = all.map((r) => r[0].v);
		assert.deepEqual(vals, [0, 1, 2, 3, 4, 5]);
	});

	test("kill 后拒绝待处理任务", async () => {
		const p = new Promise((resolve, reject) => {
			pool.enqueue({
				kind: "query",
				sql: "SELECT 1",
				timeout: 10000,
				token: "kill-tok",
				onRow: null,
				resolve,
				reject,
			});
		});
		pool.kill();
		await assert.rejects(p, /killed/i);
	});

	test("reader 进程异常退出后拒绝待处理任务", async () => {
		const p = new Promise((resolve, reject) => {
			pool.enqueue({
				kind: "query",
				sql: "SELECT 1",
				timeout: 30000,
				token: "crash-tok",
				onRow: null,
				resolve,
				reject,
			});
		});
		await new Promise((r) => setImmediate(r));
		// 拿到被选中的 worker 的进程并 kill
		const worker = pool._workers[0];
		worker._process.kill("SIGKILL");
		await assert.rejects(p, /exited unexpectedly/);
	});
});
