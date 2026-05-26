import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { interpolateSQL } from "./interpolate.js";

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

	test("没有占位符时原样返回", () => {
		assert.equal(interpolateSQL("SELECT 1", []), "SELECT 1");
	});

	test("不含 ? 且无参数时不报错", () => {
		assert.equal(interpolateSQL("SELECT 1", []), "SELECT 1");
	});

	test("含 ? 但传空数组报错", () => {
		assert.throws(() => interpolateSQL("SELECT ?", []), /Too few parameters provided/);
	});
});
