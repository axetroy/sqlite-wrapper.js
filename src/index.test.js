import assert from "node:assert/strict";
import test, { describe } from "node:test";

describe("index 导出", () => {
	test("导出全部公开 API", async () => {
		const mod = await import("./index.js");
		assert.equal(typeof mod.SQLiteExecutor, "function");
		assert.equal(typeof mod.Metrics, "function");
		assert.ok(Array.isArray(mod.VALID_TRANSACTION_MODES));
		assert.equal(mod.DEFAULT_STATEMENT_TIMEOUT, 30000);
		assert.equal(typeof mod.createTimeoutError, "function");
	});
});
