import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { classifySQL } from "./classifier.js";

describe("classifySQL", () => {
	test("SELECT 返回 read", () => {
		assert.equal(classifySQL("SELECT * FROM users"), "read");
	});

	test("WITH 返回 read", () => {
		assert.equal(classifySQL("WITH cte AS (SELECT 1) SELECT * FROM cte"), "read");
	});

	test("VALUES 返回 read", () => {
		assert.equal(classifySQL("VALUES (1, 2, 3)"), "read");
	});

	test("EXPLAIN 返回 read", () => {
		assert.equal(classifySQL("EXPLAIN SELECT * FROM users"), "read");
	});

	test("INSERT 返回 write", () => {
		assert.equal(classifySQL("INSERT INTO users (name) VALUES ('Alice')"), "write");
	});

	test("UPDATE 返回 write", () => {
		assert.equal(classifySQL("UPDATE users SET name = 'Bob' WHERE id = 1"), "write");
	});

	test("DELETE 返回 write", () => {
		assert.equal(classifySQL("DELETE FROM users WHERE id = 1"), "write");
	});

	test("CREATE 返回 write", () => {
		assert.equal(classifySQL("CREATE TABLE users (id INTEGER)"), "write");
	});

	test("DROP 返回 write", () => {
		assert.equal(classifySQL("DROP TABLE users"), "write");
	});

	test("ALTER 返回 write", () => {
		assert.equal(classifySQL("ALTER TABLE users ADD COLUMN age INTEGER"), "write");
	});

	test("PRAGMA 返回 write", () => {
		assert.equal(classifySQL("PRAGMA journal_mode=WAL"), "write");
	});

	test("大小写不敏感", () => {
		assert.equal(classifySQL("select * from users"), "read");
		assert.equal(classifySQL("Select * From users"), "read");
		assert.equal(classifySQL("SELECT * FROM users"), "read");
	});

	test("多语句混合返回 write", () => {
		assert.equal(classifySQL("SELECT 1; INSERT INTO t VALUES (2)"), "write");
	});

	test("空字符串返回 write", () => {
		assert.equal(classifySQL(""), "write");
	});

	test("仅空白字符串返回 write", () => {
		assert.equal(classifySQL("   "), "write");
	});

	test("非字符串返回 write", () => {
		assert.equal(classifySQL(123), "write");
	});

	test("前导空白被忽略", () => {
		assert.equal(classifySQL("  SELECT 1"), "read");
	});

	test("换行前导空白被忽略", () => {
		assert.equal(classifySQL("\n\tSELECT 1"), "read");
	});
});
