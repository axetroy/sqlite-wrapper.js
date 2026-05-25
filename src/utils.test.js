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
		const sql = normalizeSQL("CREATE TABLE t (\n  id INTEGER, -- primary key\n  name TEXT    -- display name\n);");
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

	test("去除块注释 /* */", () => {
		const sql = normalizeSQL("SELECT /* comment */ 1");
		assert.equal(sql, "SELECT 1;");
	});

	test("块注释跨行被去除，末尾空格规范化保留", () => {
		const sql = normalizeSQL("SELECT 1 /* line1\nline2 */ ;");
		assert.equal(sql, "SELECT 1 ;");
	});

	test("字符串内的 /* 不被当作块注释开始", () => {
		const sql = normalizeSQL("SELECT '/* not a comment'");
		assert.equal(sql, "SELECT '/* not a comment';");
	});

	test("字符串内的 */ 不被当作块注释结束", () => {
		const sql = normalizeSQL("SELECT '*/ not a comment end'");
		assert.equal(sql, "SELECT '*/ not a comment end';");
	});

	test("行注释和块注释都被去除", () => {
		const sql = normalizeSQL("SELECT 1; -- row\n/* block */ SELECT 2");
		assert.equal(sql, "SELECT 1; SELECT 2;");
	});

	test("只有空白和注释的 SQL 返回 ;", () => {
		assert.equal(normalizeSQL("  -- just a comment\n  /* another */  "), ";");
	});

	test("空字符串返回 ;", () => {
		assert.equal(normalizeSQL(""), ";");
	});

	test("重复分号被折叠为单个", () => {
		assert.equal(normalizeSQL("SELECT 1;;;"), "SELECT 1;");
	});

	test("Unicode 字符串内容无损", () => {
		const sql = normalizeSQL("SELECT '你好世界 🎉'");
		assert.equal(sql, "SELECT '你好世界 🎉';");
	});

	test("interpolateSQL 没有占位符时原样返回", () => {
		assert.equal(interpolateSQL("SELECT 1", []), "SELECT 1");
	});

	test("interpolateSQL 不含 ? 但无参数时不报错", () => {
		assert.equal(interpolateSQL("SELECT 1", []), "SELECT 1");
	});

	test("interpolateSQL 含 ? 但传空数组报错", () => {
		assert.throws(() => interpolateSQL("SELECT ?", []), /Too few parameters provided/);
	});

	test("escapeValue 空字符串正确转义", () => {
		assert.equal(escapeValue(""), "''");
	});

	test("escapeValue 含换行和制表符的字符串", () => {
		assert.equal(escapeValue("line1\nline2\tend"), "'line1\nline2\tend'");
	});

	test("escapeValue 含反斜杠的字符串", () => {
		assert.equal(escapeValue("path\\to\\file"), "'path\\to\\file'");
	});

	test("escapeValue unicode 字符串", () => {
		assert.equal(escapeValue("hello 世界"), "'hello 世界'");
	});
});
