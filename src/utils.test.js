import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { escapeValue, interpolateSQL } from "./utils.js";

describe("escapeValue", () => {
	test("escapes simple string", () => {
		assert.equal(escapeValue("hello"), "'hello'");
	});

	test("escapes string with single quotes", () => {
		assert.equal(escapeValue("O'Brien"), "'O''Brien'");
		assert.equal(escapeValue("It's a test"), "'It''s a test'");
	});

	test("escapes string with multiple single quotes", () => {
		assert.equal(escapeValue("'quoted'"), "'''quoted'''");
	});

	test("escapes empty string", () => {
		assert.equal(escapeValue(""), "''");
	});

	test("handles null value", () => {
		assert.equal(escapeValue(null), "NULL");
	});

	test("handles undefined value", () => {
		assert.equal(escapeValue(undefined), "NULL");
	});

	test("handles integer number", () => {
		assert.equal(escapeValue(42), "42");
		assert.equal(escapeValue(0), "0");
		assert.equal(escapeValue(-100), "-100");
	});

	test("handles float number", () => {
		assert.equal(escapeValue(3.14), "3.14");
		assert.equal(escapeValue(-2.5), "-2.5");
	});

	test("handles bigint", () => {
		assert.equal(escapeValue(9007199254740991n), "9007199254740991");
		assert.equal(escapeValue(-9007199254740991n), "-9007199254740991");
	});

	test("handles boolean true", () => {
		assert.equal(escapeValue(true), "TRUE");
	});

	test("handles boolean false", () => {
		assert.equal(escapeValue(false), "FALSE");
	});

	test("handles Date object", () => {
		const date = new Date("2024-01-15T10:30:00.000Z");
		assert.equal(escapeValue(date), "'2024-01-15T10:30:00.000Z'");
	});

	test("handles Date object with milliseconds", () => {
		const date = new Date("2024-12-31T23:59:59.999Z");
		assert.equal(escapeValue(date), "'2024-12-31T23:59:59.999Z'");
	});

	test("throws error for unsupported types", () => {
		assert.throws(() => escapeValue(Symbol("test")), TypeError);
		assert.throws(() => escapeValue({ key: "value" }), TypeError);
		assert.throws(() => escapeValue([1, 2, 3]), TypeError);
		assert.throws(() => escapeValue(() => {}), TypeError);
	});
});

describe("interpolateSQL", () => {
	test("interpolates single parameter", () => {
		const result = interpolateSQL("SELECT * FROM users WHERE name = ?", ["Alice"]);
		assert.equal(result, "SELECT * FROM users WHERE name = 'Alice'");
	});

	test("interpolates multiple parameters", () => {
		const result = interpolateSQL("INSERT INTO users (name, age) VALUES (?, ?)", ["Bob", 25]);
		assert.equal(result, "INSERT INTO users (name, age) VALUES ('Bob', 25)");
	});

	test("interpolates parameters with quotes", () => {
		const result = interpolateSQL("SELECT * FROM users WHERE name = ?", ["O'Brien"]);
		assert.equal(result, "SELECT * FROM users WHERE name = 'O''Brien'");
	});

	test("interpolates null parameter", () => {
		const result = interpolateSQL("UPDATE users SET email = ? WHERE id = ?", [null, 1]);
		assert.equal(result, "UPDATE users SET email = NULL WHERE id = 1");
	});

	test("interpolates boolean parameters", () => {
		const result = interpolateSQL("UPDATE users SET active = ?, verified = ?", [true, false]);
		assert.equal(result, "UPDATE users SET active = TRUE, verified = FALSE");
	});

	test("interpolates date parameter", () => {
		const date = new Date("2024-01-15T10:30:00.000Z");
		const result = interpolateSQL("INSERT INTO logs (created_at) VALUES (?)", [date]);
		assert.equal(result, "INSERT INTO logs (created_at) VALUES ('2024-01-15T10:30:00.000Z')");
	});

	test("interpolates bigint parameter", () => {
		const result = interpolateSQL("SELECT * FROM data WHERE id = ?", [9007199254740991n]);
		assert.equal(result, "SELECT * FROM data WHERE id = 9007199254740991");
	});

	test("handles SQL without parameters", () => {
		const result = interpolateSQL("SELECT * FROM users", []);
		assert.equal(result, "SELECT * FROM users");
	});

	test("handles empty parameter array", () => {
		const result = interpolateSQL("CREATE TABLE test (id INTEGER)", []);
		assert.equal(result, "CREATE TABLE test (id INTEGER)");
	});

	test("throws error when too few parameters", () => {
		assert.throws(
			() => interpolateSQL("SELECT * FROM users WHERE name = ? AND age = ?", ["Alice"]),
			/Too few parameters provided/
		);
	});

	test("ignores extra parameters", () => {
		const result = interpolateSQL("SELECT * FROM users WHERE name = ?", ["Alice", "Bob", 25]);
		assert.equal(result, "SELECT * FROM users WHERE name = 'Alice'");
	});

	test("interpolates complex SQL with multiple placeholders", () => {
		const result = interpolateSQL(
			"UPDATE users SET name = ?, email = ?, age = ?, active = ? WHERE id = ?",
			["Charlie", "charlie@example.com", 30, true, 1]
		);
		assert.equal(
			result,
			"UPDATE users SET name = 'Charlie', email = 'charlie@example.com', age = 30, active = TRUE WHERE id = 1"
		);
	});

	test("handles sequential parameter substitution", () => {
		const result = interpolateSQL(
			"INSERT INTO users (name) VALUES (?); INSERT INTO users (name) VALUES (?);",
			["Alice", "Bob"]
		);
		assert.equal(
			result,
			"INSERT INTO users (name) VALUES ('Alice'); INSERT INTO users (name) VALUES ('Bob');"
		);
	});

	test("handles zero as parameter", () => {
		const result = interpolateSQL("UPDATE users SET count = ? WHERE id = ?", [0, 1]);
		assert.equal(result, "UPDATE users SET count = 0 WHERE id = 1");
	});

	test("handles empty string as parameter", () => {
		const result = interpolateSQL("UPDATE users SET name = ? WHERE id = ?", ["", 1]);
		assert.equal(result, "UPDATE users SET name = '' WHERE id = 1");
	});

	test("handles string with special characters", () => {
		const result = interpolateSQL("INSERT INTO logs (message) VALUES (?)", [
			"Error: file not found\nLine 2\tTab\rCarriage return",
		]);
		assert.equal(
			result,
			"INSERT INTO logs (message) VALUES ('Error: file not found\nLine 2\tTab\rCarriage return')"
		);
	});
});
