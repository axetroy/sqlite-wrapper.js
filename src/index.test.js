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
		assert.throws(
			() => interpolateSQL("SELECT 'abc ?", []),
			/Unterminated single-quoted string starting at position 8/,
		);
	});

	test("throws readable error for unterminated double-quoted identifier", () => {
		assert.throws(
			() => interpolateSQL('SELECT "abc ?', []),
			/Unterminated double-quoted identifier\/string starting at position 8/,
		);
	});

	test("throws readable error for unterminated block comment", () => {
		assert.throws(
			() => interpolateSQL("/* comment ?", []),
			/Unterminated block comment starting at position 1/,
		);
	});
});
