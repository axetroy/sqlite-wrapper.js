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
			try { pm.kill(); } catch { /* 清理阶段绝不抛出，防止级联取消后续测试 */ }
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
			function cleanup() {
				clearTimeout(timer);
				proc.stdout.removeAllListeners("data");
				proc.off("error", onError);
			}
			const onError = (err) => { cleanup(); reject(err); };
			const timer = setTimeout(() => {
				cleanup();
				resolve("");
			}, 5000);
			proc.stdout.on("data", (chunk) => {
				cleanup();
				resolve(String(chunk));
			});
			proc.on("error", onError);
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

	test("start 时 binary 路径为空抛出错误", () => {
		const pm = new ProcessManager({ binary: "", database: ":memory:" });
		assert.throws(() => pm.start(), {
			message: /sqlite3 binary path is empty/,
		});
	});

	test("start 时 binary 文件不存在抛出错误", () => {
		const pm = new ProcessManager({ binary: "/nonexistent/path", database: ":memory:" });
		assert.throws(() => pm.start(), {
			message: /sqlite3 binary not found/,
		});
	});

	test("gracefulShutdown 未启动时 no-op", async () => {
		const pm = createPM();
		await pm.gracefulShutdown();
	});

	test("gracefulShutdown 发送 .quit 正常退出进程", async () => {
		const pm = createPM();
		const proc = pm.start();
		assert.equal(proc.killed, false);

		await pm.gracefulShutdown();

		// close 事件已触发，进程应已退出
		assert.ok(proc.exitCode !== null || proc.signalCode !== null);

		// kill 后清理完成
		pm.kill();
		assert.equal(pm.process, null);
	});
});
