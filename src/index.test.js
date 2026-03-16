import assert from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import test, { afterEach, beforeEach, describe } from "node:test";

import outdent from "outdent";

import { SQLiteWrapper } from "./index.js";
import { interpolateSQL } from "./utils.js";
import downloadSQLite3 from "../script/download-sqlite3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.join(__dirname, "..");

const SQLite3BinaryFile = path.join(root, "bin", "sqlite3");

/**
 * @type {import("./index.js").SQLiteWrapper}
 */
let sqlite;

beforeEach(async () => {
	// download the SQLite3 binary if it doesn't exist
	await downloadSQLite3();

	sqlite = new SQLiteWrapper(SQLite3BinaryFile);
});

afterEach(() => sqlite.close());

describe("SQLiteWrapper", () => {
	test("create table", async () => {
		await sqlite.exec(
			outdent`
				CREATE TABLE IF NOT EXISTS users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT
				);

				INSERT INTO users (name) VALUES (?);
				INSERT INTO users (name) VALUES (?);
		`,
			["Alice", "Bob"],
		);
	});

	test("create table and query", async () => {
		await sqlite.exec(
			outdent`
				CREATE TABLE IF NOT EXISTS users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT
				);

				INSERT INTO users (name) VALUES (?);
				INSERT INTO users (name) VALUES (?);
		`,
			["Alice", "Bob"],
		);

		const rows = await sqlite.query("SELECT * FROM users");

		assert.deepEqual(rows, [
			{ id: 1, name: "Alice" },
			{ id: 2, name: "Bob" },
		]);
	});

	test("create table and query and update", async () => {
		await sqlite.exec(
			outdent`
				CREATE TABLE IF NOT EXISTS users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT
				);

				INSERT INTO users (name) VALUES (?);
				INSERT INTO users (name) VALUES (?);
		`,
			["Alice", "Bob"],
		);

		const rows = await sqlite.query("SELECT * FROM users");

		assert.deepEqual(rows, [
			{ id: 1, name: "Alice" },
			{ id: 2, name: "Bob" },
		]);

		// Update
		await sqlite.exec("UPDATE users SET name = 'Charlie' WHERE id = ?", [1]);
		const updatedRows = await sqlite.query("SELECT * FROM users WHERE id = ?", [1]);
		assert.deepEqual(updatedRows, [{ id: 1, name: "Charlie" }]);
	});

	test("handles concurrent enqueued writes correctly", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS concurrent_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

		const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

		await Promise.all(names.map((name) => sqlite.exec("INSERT INTO concurrent_users (name) VALUES (?)", [name])));

		const rows = await sqlite.query("SELECT name FROM concurrent_users ORDER BY id ASC");
		assert.deepEqual(
			rows.map((row) => row.name),
			names,
		);
	});

	test("keeps result sets separated for batched concurrent queries", async () => {
		await sqlite.exec(
			outdent`
				CREATE TABLE IF NOT EXISTS query_users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT
				);

				INSERT INTO query_users (name) VALUES (?);
				INSERT INTO query_users (name) VALUES (?);
				INSERT INTO query_users (name) VALUES (?);
			`,
			["Alice", "Bob", "Carol"],
		);

		const [firstRows, secondRows, countRows] = await Promise.all([
			sqlite.query("SELECT id, name FROM query_users WHERE id <= ? ORDER BY id ASC", [2]),
			sqlite.query("SELECT id, name FROM query_users WHERE id > ? ORDER BY id ASC", [2]),
			sqlite.query("SELECT COUNT(*) AS total FROM query_users"),
		]);

		assert.deepEqual(firstRows, [
			{ id: 1, name: "Alice" },
			{ id: 2, name: "Bob" },
		]);

		assert.deepEqual(secondRows, [{ id: 3, name: "Carol" }]);
		assert.deepEqual(countRows, [{ total: 3 }]);
	});

	test("isolates a failed statement from a later successful statement in the same batch", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS batch_isolation_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
		await sqlite.exec("INSERT INTO batch_isolation_users (name) VALUES (?)", ["Alice"]);

		const [failedResult, successResult] = await Promise.allSettled([
			sqlite.query("SELECT * FROM missing_batch_table"),
			sqlite.query("SELECT id, name FROM batch_isolation_users ORDER BY id ASC"),
		]);

		assert.equal(failedResult.status, "rejected");
		assert.match(failedResult.reason.message, /no such table: missing_batch_table/);

		assert.equal(successResult.status, "fulfilled");
		assert.deepEqual(successResult.value, [{ id: 1, name: "Alice" }]);
	});

		test.skip("keeps parsing correct with four batched statements where 1 and 3 succeed, 2 and 4 fail", async () => {
		await sqlite.exec("CREATE TABLE IF NOT EXISTS mixed_batch_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
		await sqlite.exec(
			outdent`
				INSERT INTO mixed_batch_users (name) VALUES (?);
				INSERT INTO mixed_batch_users (name) VALUES (?);
			`,
			["Alice", "Bob"],
		);

		const results = await Promise.allSettled([
			sqlite.query("SELECT id, name FROM mixed_batch_users WHERE id = ?", [1]),
				sqlite.query("SELECT broken syntax FROM"),
			sqlite.query("SELECT id, name FROM mixed_batch_users WHERE id = ?", [2]),
				sqlite.query("SELECT another broken syntax FROM"),
		]);

		assert.equal(results[0].status, "fulfilled");
		assert.deepEqual(results[0].value, [{ id: 1, name: "Alice" }]);

		assert.equal(results[1].status, "rejected");
			assert.match(results[1].reason.message, /Parse error|syntax error/i);

		assert.equal(results[2].status, "fulfilled");
		assert.deepEqual(results[2].value, [{ id: 2, name: "Bob" }]);

		assert.equal(results[3].status, "rejected");
		assert.match(results[3].reason.message, /Parse error|syntax error/i);
	});

	test("rejects when sqlite binary is missing", async () => {
		const missingPath = path.join(os.tmpdir(), "missing-sqlite3-binary");
		const wrapper = new SQLiteWrapper(missingPath);

		// Allow spawn error handler to mark the wrapper as closed
		await new Promise((resolve) => setImmediate(resolve));

		await assert.rejects(wrapper.exec("SELECT 1;"), /closed SQLiteWrapper/);
		wrapper.close();
	});

	test("rejects pending queued requests when close is called", async () => {
		const p1 = sqlite.exec("SELECT 1;");
		const p2 = sqlite.exec("SELECT 2;");

		sqlite.close();

		const settled = await Promise.race([
			Promise.allSettled([p1, p2]),
			new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for promises")), 1000)),
		]);

		assert.deepEqual(
			settled.map((item) => item.status),
			["rejected", "rejected"],
		);
	});
});

describe("Error handling", () => {
	test("If sqlite executable file is not found", async () => {
		const sqlite = new SQLiteWrapper("/path/to/nonexistent/sqlite3");

		await assert
			.rejects(
				async () => {
					await sqlite.exec(
						outdent`
						CREATE TABLE IF NOT EXISTS users (
							id INTEGER PRIMARY KEY AUTOINCREMENT,
							name TEXT
						);

						INSERT INTO users (name) VALUES (?);
						INSERT INTO users (name) VALUES (?);
					`,
						["Alice", "Bob"],
					);
				},
				{
					message: /sqlite3 process error: spawn \/path\/to\/nonexistent\/sqlite3 ENOENT/,
				},
			)
			.finally(() => {
				sqlite.close();
			});
	});
});

describe("interpolateSQL", () => {
	test("throws when too many parameters are provided", () => {
		assert.throws(() => interpolateSQL("SELECT ?", [1, 2]), /Too many parameters provided/);
	});

	test("does not replace question marks inside single-quoted strings", () => {
		const sql = "SELECT '?', ?";
		assert.equal(interpolateSQL(sql, [1]), "SELECT '?', 1");
	});

	test("does not replace question marks inside double-quoted identifiers", () => {
		const sql = 'SELECT "?", ?';
		assert.equal(interpolateSQL(sql, [1]), 'SELECT "?", 1');
	});

	test("does not replace question marks inside line comments", () => {
		const sql = "-- ? in comment\nSELECT ?";
		assert.equal(interpolateSQL(sql, [1]), "-- ? in comment\nSELECT 1");
	});

	test("does not replace question marks inside block comments", () => {
		const sql = "/* ? in comment */ SELECT ?";
		assert.equal(interpolateSQL(sql, [1]), "/* ? in comment */ SELECT 1");
	});

	test("throws readable error for unterminated single-quoted string", () => {
		assert.throws(() => interpolateSQL("SELECT 'abc ?", []), /Unterminated single-quoted string starting at position 8/);
	});

	test("throws readable error for unterminated double-quoted identifier", () => {
		assert.throws(() => interpolateSQL('SELECT "abc ?', []), /Unterminated double-quoted identifier\/string starting at position 8/);
	});

	test("throws readable error for unterminated block comment", () => {
		assert.throws(() => interpolateSQL("/* comment ?", []), /Unterminated block comment starting at position 1/);
	});
});
