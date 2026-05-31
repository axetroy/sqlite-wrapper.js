import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { VALID_TRANSACTION_MODES, isTransactionMode, createTransactionHandle } from "./transaction.js";

describe("VALID_TRANSACTION_MODES", () => {
	test("包含三种标准事务模式", () => {
		assert.deepEqual(VALID_TRANSACTION_MODES, ["DEFERRED", "IMMEDIATE", "EXCLUSIVE"]);
	});
});

describe("isTransactionMode", () => {
	test("有效模式返回 true", () => {
		assert.equal(isTransactionMode("DEFERRED"), true);
		assert.equal(isTransactionMode("IMMEDIATE"), true);
		assert.equal(isTransactionMode("EXCLUSIVE"), true);
	});

	test("无效模式返回 false", () => {
		assert.equal(isTransactionMode("BEGIN"), false);
		assert.equal(isTransactionMode(""), false);
		assert.equal(isTransactionMode(123), false);
		assert.equal(isTransactionMode(null), false);
		assert.equal(isTransactionMode(undefined), false);
	});
});

describe("createTransactionHandle", () => {
	test("创建包含 execute/query/stream 的句柄", () => {
		let calledKind = null;
		const mockExecutor = {
			enqueue(kind, sql, params, options, scopeId) {
				calledKind = kind;
				return Promise.resolve();
			},
		};

		const scopeId = Symbol("tx");
		const handle = createTransactionHandle(scopeId, mockExecutor);

		assert.ok(typeof handle.execute === "function");
		assert.ok(typeof handle.query === "function");
		assert.ok(typeof handle.stream === "function");
	});

	test("stream 返回 AsyncIterable", async () => {
		const collected = [];
		const mockExecutor = {
			enqueue(kind, sql, params, options, scopeId) {
				options.onRow({ id: 1, name: "Alice" });
				options.onRow({ id: 2, name: "Bob" });
				return Promise.resolve();
			},
		};

		const handle = createTransactionHandle(Symbol("tx"), mockExecutor);
		for await (const row of handle.stream("SELECT * FROM t")) {
			collected.push(row);
		}
		assert.equal(collected.length, 2);
		assert.deepEqual(collected[0], { id: 1, name: "Alice" });
	});

	test("execute 委托给 executor.enqueue", async () => {
		const calls = [];
		const mockExecutor = {
			enqueue(kind, sql, params, options, scopeId) {
				calls.push({ kind, sql, params, options, scopeId });
				return Promise.resolve();
			},
		};

		const scopeId = Symbol("tx");
		const handle = createTransactionHandle(scopeId, mockExecutor);
		await handle.execute("SELECT 1", [], { timeout: 1000 });

		assert.equal(calls.length, 1);
		assert.equal(calls[0].kind, "execute");
		assert.equal(calls[0].sql, "SELECT 1");
		assert.equal(calls[0].scopeId, scopeId);
	});

	test("query 委托给 executor.enqueue", async () => {
		const calls = [];
		const mockExecutor = {
			enqueue(kind, sql, params, options, scopeId) {
				calls.push({ kind });
				return Promise.resolve([{ id: 1 }]);
			},
		};

		const handle = createTransactionHandle(Symbol("tx"), mockExecutor);
		const result = await handle.query("SELECT 1");
		assert.equal(calls[0].kind, "query");
		assert.deepEqual(result, [{ id: 1 }]);
	});

	test("stream params 非数组时同步抛出 TypeError", () => {
		const mockExecutor = { enqueue: () => {} };
		const handle = createTransactionHandle(Symbol("tx"), mockExecutor);
		assert.throws(() => handle.stream("SELECT 1", "not-an-array"), /params must be an array/);
	});
});
