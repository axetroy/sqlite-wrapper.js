import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { DEFAULT_STATEMENT_TIMEOUT, createTimeoutError } from "./timeout.js";

describe("DEFAULT_STATEMENT_TIMEOUT", () => {
	test("默认超时为 30000 毫秒", () => {
		assert.equal(DEFAULT_STATEMENT_TIMEOUT, 30_000);
	});
});

describe("createTimeoutError", () => {
	test("创建 Error 实例", () => {
		const err = createTimeoutError(5000, "SELECT 1");
		assert.ok(err instanceof Error);
	});

	test("错误消息包含超时时间和 SQL", () => {
		const err = createTimeoutError(5000, "SELECT * FROM users");
		assert.ok(err.message.includes("5000ms"));
		assert.ok(err.message.includes("SELECT * FROM users"));
	});

	test("SQL 被规范化后再包含在消息中", () => {
		const err = createTimeoutError(1000, "  SELECT   1  ");
		assert.ok(err.message.includes("SELECT 1"));
		assert.ok(!err.message.includes("  SELECT   1  "));
	});
});
