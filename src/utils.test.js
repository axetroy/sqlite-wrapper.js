import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { escapeValue, interpolateSQL, normalizeSQL } from "./utils.js";

describe("escapeValue", () => {
	test("escapes strings with single quotes", () => {
		assert.equal(escapeValue("O'Brien"), "'O''Brien'");
	});

	test("supports null and undefined", () => {
		assert.equal(escapeValue(null), "NULL");
		assert.equal(escapeValue(undefined), "NULL");
	});

	test("supports numbers and bigint", () => {
		assert.equal(escapeValue(123), "123");
		assert.equal(escapeValue(123n), "123");
	});

	test("supports booleans", () => {
		assert.equal(escapeValue(true), "TRUE");
		assert.equal(escapeValue(false), "FALSE");
	});

	test("supports Date values", () => {
		const date = new Date("2024-01-15T10:30:00.000Z");
		assert.equal(escapeValue(date), "'2024-01-15T10:30:00.000Z'");
	});

	test("throws for unsupported types", () => {
		assert.throws(() => escapeValue(Symbol("x")), /Unsupported parameter type/);
	});
});

describe("interpolateSQL", () => {
	test("interpolates placeholders in order", () => {
		const sql = interpolateSQL("SELECT * FROM users WHERE name = ? AND age = ?", ["Alice", 18]);
		assert.equal(sql, "SELECT * FROM users WHERE name = 'Alice' AND age = 18");
	});

	test("does not replace placeholders in quoted strings or comments", () => {
		const sql = interpolateSQL("SELECT '?', \"?\", ? -- ? in comment\n/* ? block */", [1]);
		assert.equal(sql, "SELECT '?', \"?\", 1 -- ? in comment\n/* ? block */");
	});

	test("throws when too few parameters are provided", () => {
		assert.throws(() => interpolateSQL("SELECT ?, ?", [1]), /Too few parameters provided/);
	});

	test("throws when too many parameters are provided", () => {
		assert.throws(() => interpolateSQL("SELECT ?", [1, 2]), /Too many parameters provided/);
	});

	test("throws for unterminated quoted string/comment", () => {
		assert.throws(() => interpolateSQL("SELECT 'abc ?", []), /Unterminated single-quoted string/);
		assert.throws(() => interpolateSQL('SELECT "abc ?', []), /Unterminated double-quoted identifier\/string/);
		assert.throws(() => interpolateSQL("/* comment ?", []), /Unterminated block comment/);
	});
});

describe("normalizeSQL", () => {
	test("trims, normalizes whitespace and enforces single trailing semicolon", () => {
		const sql = normalizeSQL("\n  SELECT   *   FROM users   WHERE id = 1   ;; \n");
		assert.equal(sql, "SELECT * FROM users WHERE id = 1 ;");
	});

	test("keeps single-line statements normalized", () => {
		assert.equal(normalizeSQL("SELECT 1"), "SELECT 1;");
	});

	test("strips line comments before collapsing whitespace", () => {
		const sql = normalizeSQL(
			"CREATE TABLE t (\n  id INTEGER, -- primary key\n  name TEXT    -- display name\n);",
		);
		assert.equal(sql, "CREATE TABLE t ( id INTEGER, name TEXT );");
	});

	test("does not strip -- inside single-quoted strings", () => {
		const sql = normalizeSQL("SELECT '--not a comment'");
		assert.equal(sql, "SELECT '--not a comment';");
	});

	test("does not strip -- inside double-quoted identifiers", () => {
		const sql = normalizeSQL('SELECT "--not a comment"');
		assert.equal(sql, 'SELECT "--not a comment";');
	});

	test("handles SQL with only line comments on some lines", () => {
		const sql = normalizeSQL("-- header comment\nSELECT 1;");
		assert.equal(sql, "SELECT 1;");
	});

	test("handles multi-statement SQL with inline line comments", () => {
		const sql = normalizeSQL("INSERT INTO t VALUES (1); -- first row\nINSERT INTO t VALUES (2); -- second row");
		assert.equal(sql, "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);");
	});
});
