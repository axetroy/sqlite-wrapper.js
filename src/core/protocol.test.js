import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { describe } from "node:test";

import { buildPayload, buildBatchPayload, isSentinelRow, isSentinelRaw, TOKEN_COLUMN, buildSentinelStr } from "./protocol.js";

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

	test("buildPayload 保留多行 SQL", () => {
		const sql = "SELECT 1;\nSELECT 2;";
		const payload = buildPayload(sql, "t1");
		assert.ok(payload.includes("SELECT 1;"));
		assert.ok(payload.includes("SELECT 2;"));
	});

	test("buildPayload SQL 中的单引号不被 sentinel 影响", () => {
		const sql = "SELECT 'hello''world'";
		const payload = buildPayload(sql, "t2");
		assert.ok(payload.includes("SELECT 'hello''world';"));
	});

	test("buildPayload 规范化去除了多余的空白", () => {
		const payload = buildPayload("\n  SELECT   1  \n  ", "t3");
		assert.ok(payload.startsWith("SELECT 1;"));
	});

	test("isSentinelRow 空对象不匹配", () => {
		assert.equal(isSentinelRow([{}], "abc"), false);
	});

	test("isSentinelRow 空数组元素不匹配", () => {
		assert.equal(isSentinelRow([[]], "abc"), false);
	});

	test("isSentinelRow 基本类型数组不匹配", () => {
		assert.equal(isSentinelRow(["abc"], "abc"), false);
		assert.equal(isSentinelRow([123], "abc"), false);
	});
});

describe("isSentinelRaw", () => {
	const TOKEN = "550e8400-e29b-41d4-a716-446655440000";
	const SENTINEL_RAW = `[{"${TOKEN_COLUMN}":"${TOKEN}"}]`;

	test("精确匹配正确 sentinel 和 token 返回 true", () => {
		assert.equal(isSentinelRaw(SENTINEL_RAW, buildSentinelStr(TOKEN)), true);
	});

	test("token 不匹配时返回 false", () => {
		assert.equal(isSentinelRaw(SENTINEL_RAW, buildSentinelStr("other-token")), false);
	});

	test("数据行数组不匹配", () => {
		assert.equal(isSentinelRaw('[{"id":1,"name":"Alice"}]', buildSentinelStr(TOKEN)), false);
	});

	test("空数组不匹配", () => {
		assert.equal(isSentinelRaw("[]", buildSentinelStr(TOKEN)), false);
	});

	test("对象不匹配", () => {
		assert.equal(isSentinelRaw('{"a":1}', buildSentinelStr(TOKEN)), false);
	});

	test("空字符串不匹配", () => {
		assert.equal(isSentinelRaw("", buildSentinelStr(TOKEN)), false);
	});

	test("不带 TOKEN_COLUMN 的数组不匹配", () => {
		assert.equal(isSentinelRaw('[{"other_field":1}]', buildSentinelStr(TOKEN)), false);
	});

	test("多元素数组不匹配", () => {
		assert.equal(isSentinelRaw(`[{"${TOKEN_COLUMN}":"${TOKEN}"},{"x":1}]`, buildSentinelStr(TOKEN)), false);
	});

	test("UUID 格式 token 匹配", () => {
		const uuidToken = crypto.randomUUID();
		const raw = `[{"${TOKEN_COLUMN}":"${uuidToken}"}]`;
		assert.equal(isSentinelRaw(raw, buildSentinelStr(uuidToken)), true);
	});
});

describe("buildBatchPayload", () => {
	test("多个 execute 使用 WAL batch（BEGIN/COMMIT 包裹）", () => {
		const batch = [
			{ kind: "execute", sql: "INSERT INTO t VALUES (1)", token: "t1" },
			{ kind: "execute", sql: "INSERT INTO t VALUES (2)", token: "t2" },
		];
		const payload = buildBatchPayload(batch);
		assert.ok(payload.startsWith("BEGIN;"), "应以 BEGIN 开头");
		assert.ok(payload.includes("COMMIT;"), "应包含 COMMIT");
		for (const t of batch) {
			assert.ok(payload.includes(t.token), `应包含 token ${t.token}`);
		}
	});

	test("包含 BEGIN TRANSACTION 时不使用 WAL batch", () => {
		const batch = [
			{ kind: "execute", sql: "BEGIN TRANSACTION", token: "t1" },
			{ kind: "execute", sql: "INSERT INTO t VALUES (1)", token: "t2" },
		];
		const payload = buildBatchPayload(batch);
		assert.ok(!payload.startsWith("BEGIN;"), "不应以 BEGIN 开头");
		assert.ok(payload.includes("INSERT INTO t VALUES (1)"));
	});

	test("包含 COMMIT 时不使用 WAL batch", () => {
		const batch = [
			{ kind: "execute", sql: "INSERT INTO t VALUES (1)", token: "t1" },
			{ kind: "execute", sql: "COMMIT", token: "t2" },
		];
		const payload = buildBatchPayload(batch);
		assert.ok(!payload.startsWith("BEGIN;"), "不应以 BEGIN 开头");
	});

	test("包含 ROLLBACK 时不使用 WAL batch", () => {
		const batch = [
			{ kind: "execute", sql: "INSERT INTO t VALUES (1)", token: "t1" },
			{ kind: "execute", sql: "ROLLBACK", token: "t2" },
		];
		const payload = buildBatchPayload(batch);
		assert.ok(!payload.startsWith("BEGIN;"), "不应以 BEGIN 开头");
	});

	test("包含 BEGIN DEFERRED 时不使用 WAL batch", () => {
		const batch = [
			{ kind: "execute", sql: "BEGIN DEFERRED", token: "t1" },
			{ kind: "execute", sql: "INSERT INTO t VALUES (1)", token: "t2" },
		];
		const payload = buildBatchPayload(batch);
		assert.ok(!payload.startsWith("BEGIN;"), "不应以 BEGIN 开头");
	});

	test("包含 COMMIT TRANSACTION 时不使用 WAL batch", () => {
		const batch = [
			{ kind: "execute", sql: "INSERT INTO t VALUES (1)", token: "t1" },
			{ kind: "execute", sql: "COMMIT TRANSACTION", token: "t2" },
		];
		const payload = buildBatchPayload(batch);
		assert.ok(!payload.startsWith("BEGIN;"), "不应以 BEGIN 开头");
	});

	test("单个 execute 不使用 WAL batch", () => {
		const batch = [
			{ kind: "execute", sql: "INSERT INTO t VALUES (1)", token: "t1" },
		];
		const payload = buildBatchPayload(batch);
		assert.ok(!payload.startsWith("BEGIN;"), "不应以 BEGIN 开头");
	});

	test("混合 execute 和 query 不使用 WAL batch", () => {
		const batch = [
			{ kind: "execute", sql: "INSERT INTO t VALUES (1)", token: "t1" },
			{ kind: "query", sql: "SELECT 1", token: "t2" },
		];
		const payload = buildBatchPayload(batch);
		assert.ok(!payload.startsWith("BEGIN;"), "不应以 BEGIN 开头");
	});
});
