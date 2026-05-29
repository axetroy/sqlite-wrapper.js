import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { normalizeSQL, normalizeSQLTemplate } from "./normalize.js";

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

	test("超长 SQL 触发 buffer 扩容", () => {
		const long = "SELECT " + "very_long_column_name ".repeat(80) + "FROM t";
		const result = normalizeSQL(long);
		assert.ok(result.endsWith(";"));
		assert.ok(result.includes("FROM t"));
	});
});

describe("normalizeSQLTemplate", () => {
	test("无 ? 时返回 normalized 和 paramCount=0", () => {
		const t = normalizeSQLTemplate("SELECT * FROM users");
		assert.equal(t.normalized, "SELECT * FROM users;");
		assert.equal(t.paramCount, 0);
		assert.deepEqual(t.segments, ["SELECT * FROM users;"]);
	});

	test("含 ? 时正确追踪位置", () => {
		const t = normalizeSQLTemplate("SELECT * FROM users WHERE id = ? AND name = ?");
		assert.equal(t.normalized, "SELECT * FROM users WHERE id = ? AND name = ?;");
		assert.equal(t.paramCount, 2);
		assert.equal(t.segments.length, 3);
		assert.equal(t.segments[0], "SELECT * FROM users WHERE id = ");
		assert.equal(t.segments[1], " AND name = ");
		assert.equal(t.segments[2], ";");
	});

	test("字符串内的 ? 不被追踪", () => {
		const t = normalizeSQLTemplate("SELECT '?' AS q");
		assert.equal(t.normalized, "SELECT '?' AS q;");
		assert.equal(t.paramCount, 0);
	});

	test("注释内的 ? 不被追踪", () => {
		const t = normalizeSQLTemplate("SELECT 1 -- ?\nFROM t WHERE id = ?");
		assert.equal(t.normalized, "SELECT 1 FROM t WHERE id = ?;");
		assert.equal(t.paramCount, 1);
	});

	test("只有一个 ?", () => {
		const t = normalizeSQLTemplate("DELETE FROM t WHERE id = ?");
		assert.equal(t.paramCount, 1);
		assert.equal(t.segments[0], "DELETE FROM t WHERE id = ");
		assert.equal(t.segments[1], ";");
	});

	test("多次调用缓存命中返回相同对象", () => {
		const a = normalizeSQLTemplate("SELECT 1");
		const b = normalizeSQLTemplate("SELECT 1");
		assert.equal(a, b);
	});

	test("与 normalizeSQL 结果一致", () => {
		const raw = "  SELECT   *   FROM   users  WHERE  id  =  1  ;; ";
		assert.equal(normalizeSQLTemplate(raw).normalized, normalizeSQL(raw));
	});
});
