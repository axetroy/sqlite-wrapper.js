import assert from "node:assert/strict";
import test, { describe, before, after, beforeEach, afterEach } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ProcessManager } from "./process.js";
import downloadSQLite3 from "../../script/download-sqlite3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..", "..");
const SQLite3BinaryFile = path.join(root, "bin", "sqlite3" + (process.platform === "win32" ? ".exe" : ""));

before(async () => {
	await downloadSQLite3();
});

describe("ProcessManager", () => {
	/** @type {ProcessManager[]} */
	const cleanup = [];

	afterEach(() => {
		for (const pm of cleanup) {
			pm.kill();
		}
		cleanup.length = 0;
	});

	function createPM(database) {
		const pm = new ProcessManager({ binary: SQLite3BinaryFile, database: database ?? ":memory:" });
		cleanup.push(pm);
		return pm;
	}

	test("初始化时存储 binary 路径", () => {
		const pm = createPM();
		assert.equal(pm.binary, SQLite3BinaryFile);
	});

	test("start 成功启动 sqlite3 子进程", () => {
		const pm = createPM();
		const proc = pm.start();
		assert.ok(proc);
		assert.equal(proc.killed, false);
		assert.ok(proc.pid > 0);
		assert.equal(proc.stdout.readable, true);
		assert.equal(proc.stdin.writable, true);
	});

	test("write 向子进程 stdin 发送数据并收到响应", async () => {
		const pm = createPM();
		const proc = pm.start();

		const output = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				proc.stdout.removeAllListeners("data");
				resolve("");
			}, 5000);
			proc.stdout.on("data", (chunk) => {
				clearTimeout(timer);
				proc.stdout.removeAllListeners("data");
				resolve(String(chunk));
			});
			proc.once("error", reject);
			pm.write("SELECT 1;\n");
		});

		assert.ok(output.includes("1"), `输出应包含查询结果，实际: ${output}`);
	});

	test("kill 终止进程并清除引用", () => {
		const pm = createPM();
		pm.start();
		const killed = pm.kill();
		assert.ok(killed);
		assert.equal(pm.process, null);
	});

	test("kill 后反复调用安全", () => {
		const pm = createPM();
		pm.start();
		pm.kill();
		const result = pm.kill();
		assert.equal(result, null);
	});

	test("未启动时 kill 返回 null", () => {
		const pm = createPM();
		const result = pm.kill();
		assert.equal(result, null);
	});

	test("多次 start 创建不同进程", async () => {
		const pm = createPM();
		const proc1 = pm.start();
		assert.ok(proc1.pid > 0);

		pm.kill();
		const proc2 = pm.start();
		assert.ok(proc2.pid > 0);
		assert.notEqual(proc1.pid, proc2.pid);
	});
});
