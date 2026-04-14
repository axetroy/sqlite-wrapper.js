import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { escapeValue, interpolateSQL, normalizeSQL } from "./utils.js";

describe("escapeValue", () => {
	test("转义含单引号的字符串", () => {
		assert.equal(escapeValue("O'Brien"), "'O''Brien'");
	});

	test("支持 null 和 undefined", () => {
		assert.equal(escapeValue(null), "NULL");
		assert.equal(escapeValue(undefined), "NULL");
	});

	test("支持数字和 bigint", () => {
		assert.equal(escapeValue(123), "123");
		assert.equal(escapeValue(123n), "123");
	});

	test("支持布尔值", () => {
		assert.equal(escapeValue(true), "TRUE");
		assert.equal(escapeValue(false), "FALSE");
	});

	test("支持 Date 值", () => {
		const date = new Date("2024-01-15T10:30:00.000Z");
		assert.equal(escapeValue(date), "'2024-01-15T10:30:00.000Z'");
	});

	test("不支持的类型时抛出错误", () => {
		assert.throws(() => escapeValue(Symbol("x")), /Unsupported parameter type/);
	});
});

describe("interpolateSQL", () => {
	test("按顺序插值占位符", () => {
		const sql = interpolateSQL("SELECT * FROM users WHERE name = ? AND age = ?", ["Alice", 18]);
		assert.equal(sql, "SELECT * FROM users WHERE name = 'Alice' AND age = 18");
	});

	test("不替换引号字符串或注释中的占位符", () => {
		const sql = interpolateSQL("SELECT '?', \"?\", ? -- ? in comment\n/* ? block */", [1]);
		assert.equal(sql, "SELECT '?', \"?\", 1 -- ? in comment\n/* ? block */");
	});

	test("参数不足时抛出错误", () => {
		assert.throws(() => interpolateSQL("SELECT ?, ?", [1]), /Too few parameters provided/);
	});

	test("参数过多时抛出错误", () => {
		assert.throws(() => interpolateSQL("SELECT ?", [1, 2]), /Too many parameters provided/);
	});

	test("未闭合的引号字符串或注释时抛出错误", () => {
		assert.throws(() => interpolateSQL("SELECT 'abc ?", []), /Unterminated single-quoted string/);
		assert.throws(() => interpolateSQL('SELECT "abc ?', []), /Unterminated double-quoted identifier\/string/);
		assert.throws(() => interpolateSQL("/* comment ?", []), /Unterminated block comment/);
	});
});

describe("normalizeSQL", () => {
	test("去除首尾空白、规范化空格并强制保留末尾分号", () => {
		const sql = normalizeSQL("\n  SELECT   *   FROM users   WHERE id = 1   ;; \n");
		assert.equal(sql, "SELECT * FROM users WHERE id = 1 ;");
	});

	test("保持单行语句规范化", () => {
		assert.equal(normalizeSQL("SELECT 1"), "SELECT 1;");
	});

	test("折叠空白前去除行注释", () => {
		const sql = normalizeSQL(
			"CREATE TABLE t (\n  id INTEGER, -- primary key\n  name TEXT    -- display name\n);",
		);
		assert.equal(sql, "CREATE TABLE t ( id INTEGER, name TEXT );");
	});

	test("不去除单引号字符串内的 --", () => {
		const sql = normalizeSQL("SELECT '--not a comment'");
		assert.equal(sql, "SELECT '--not a comment';");
	});

	test("不去除双引号标识符内的 --", () => {
		const sql = normalizeSQL('SELECT "--not a comment"');
		assert.equal(sql, 'SELECT "--not a comment";');
	});

	test("处理某些行仅有行注释的 SQL", () => {
		const sql = normalizeSQL("-- header comment\nSELECT 1;");
		assert.equal(sql, "SELECT 1;");
	});

	test("处理含行注释的多语句 SQL", () => {
		const sql = normalizeSQL("INSERT INTO t VALUES (1); -- first row\nINSERT INTO t VALUES (2); -- second row");
		assert.equal(sql, "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);");
	});
});
