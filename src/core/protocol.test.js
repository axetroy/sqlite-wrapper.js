import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { buildPayload, isSentinelRow, TOKEN_COLUMN } from "./protocol.js";

describe("TOKEN_COLUMN", () => {
	test("固定为 __sqlite_executor_token__", () => {
		assert.equal(TOKEN_COLUMN, "__sqlite_executor_token__");
	});
});

describe("buildPayload", () => {
	test("在 SQL 末尾追加 sentinel 查询", () => {
		const payload = buildPayload("SELECT 1", "token123");
		assert.ok(payload.includes("SELECT 1"));
		assert.ok(payload.includes("SELECT 'token123' AS __sqlite_executor_token__"));
	});

	test("处理已存在分号的 SQL", () => {
		const payload = buildPayload("SELECT 1;", "t1");
		assert.ok(payload.includes("SELECT 1;"));
	});

	test("规范化 SQL（去除多余空白）", () => {
		const payload = buildPayload("  SELECT   1  ", "t2");
		assert.ok(payload.startsWith("SELECT 1;"));
	});

	test("空 SQL 也能正确处理", () => {
		const payload = buildPayload("", "t3");
		assert.ok(payload.includes("SELECT 't3'"));
	});

	test("sentinel 查询独占一行并以换行结尾", () => {
		const payload = buildPayload("SELECT 1", "t4");
		const lines = payload.split("\n");
		const sentinelLine = lines.find((l) => l.includes("SELECT 't4'"));
		assert.ok(sentinelLine, "sentinel 行必须存在");
		assert.equal(payload.endsWith("\n"), true);
	});
});

describe("isSentinelRow", () => {
	test("检测有效 sentinel 行", () => {
		const row = [{ [TOKEN_COLUMN]: "abc" }];
		assert.equal(isSentinelRow(row, "abc"), true);
	});

	test("token 不匹配时返回 false", () => {
		const row = [{ [TOKEN_COLUMN]: "abc" }];
		assert.equal(isSentinelRow(row, "xyz"), false);
	});

	test("非数组输入返回 false", () => {
		assert.equal(isSentinelRow({}, "abc"), false);
		assert.equal(isSentinelRow(null, "abc"), false);
		assert.equal(isSentinelRow(undefined, "abc"), false);
	});

	test("数组长度不为 1 时返回 false", () => {
		assert.equal(isSentinelRow([], "abc"), false);
		assert.equal(isSentinelRow([{ [TOKEN_COLUMN]: "abc" }, { x: 1 }], "abc"), false);
	});

	test("元素不含 TOKEN_COLUMN 时返回 false", () => {
		assert.equal(isSentinelRow([{ id: 1 }], "abc"), false);
	});
});
