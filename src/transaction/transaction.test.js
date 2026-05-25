import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { VALID_TRANSACTION_MODES, isTransactionMode, createTransactionHandle } from "./transaction.js";

describe("VALID_TRANSACTION_MODES", () => {
	test("包含三種標準事務模式", () => {
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
	test("創建包含 execute/query/queryStream 的句柄", () => {
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
		assert.ok(typeof handle.queryStream === "function");
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

	test("queryStream 委托给 executor.enqueue 并传递 onRow", async () => {
		const calls = [];
		const onRow = () => {};
		const mockExecutor = {
			enqueue(kind, sql, params, options, scopeId) {
				calls.push({ kind, hasOnRow: typeof options.onRow === "function" });
				return Promise.resolve();
			},
		};

		const handle = createTransactionHandle(Symbol("tx"), mockExecutor);
		await handle.queryStream("SELECT 1", onRow);

		assert.equal(calls[0].kind, "stream");
		assert.equal(calls[0].hasOnRow, true);
	});
});
