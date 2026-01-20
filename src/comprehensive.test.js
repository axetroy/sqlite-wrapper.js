import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import test, { afterEach, beforeEach, describe } from "node:test";

import { SQLiteWrapper } from "./index.js";

// Use system sqlite3 for testing
const SQLITE3_PATH = "/usr/bin/sqlite3";

/**
 * @type {import("./index.js").SQLiteWrapper}
 */
let sqlite;

beforeEach(() => {
	sqlite = new SQLiteWrapper(SQLITE3_PATH);
});

afterEach(() => sqlite.close());

describe("SQLiteWrapper - Data Types", () => {
	test("handles various data types in INSERT and SELECT", async () => {
		await sqlite.exec(`
			CREATE TABLE test_types (
				id INTEGER PRIMARY KEY,
				text_col TEXT,
				int_col INTEGER,
				float_col REAL,
				bool_col INTEGER,
				null_col TEXT,
				date_col TEXT
			)
		`);

		const date = new Date("2024-01-15T10:30:00.000Z");
		await sqlite.exec(
			"INSERT INTO test_types VALUES (?, ?, ?, ?, ?, ?, ?)",
			[1, "hello", 42, 3.14, true, null, date]
		);

		const rows = await sqlite.query("SELECT * FROM test_types");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].id, 1);
		assert.equal(rows[0].text_col, "hello");
		assert.equal(rows[0].int_col, 42);
		assert.equal(rows[0].float_col, 3.14);
		assert.equal(rows[0].bool_col, 1); // SQLite stores booleans as integers
		assert.equal(rows[0].null_col, null);
		assert.equal(rows[0].date_col, date.toISOString());
	});

	test("handles strings with special characters", async () => {
		await sqlite.exec("CREATE TABLE test_strings (id INTEGER, value TEXT)");

		const specialStrings = [
			"O'Brien",
			"It's a test",
			'String with "quotes"',
			"String\nwith\nnewlines",
			"String\twith\ttabs",
			"",
		];

		for (let i = 0; i < specialStrings.length; i++) {
			await sqlite.exec("INSERT INTO test_strings VALUES (?, ?)", [i, specialStrings[i]]);
		}

		const rows = await sqlite.query("SELECT * FROM test_strings ORDER BY id");
		assert.equal(rows.length, specialStrings.length);
		for (let i = 0; i < specialStrings.length; i++) {
			assert.equal(rows[i].value, specialStrings[i]);
		}
	});

	test("handles bigint values", async () => {
		await sqlite.exec("CREATE TABLE test_bigint (id INTEGER, value INTEGER)");
		const bigValue = 9007199254740991n;
		await sqlite.exec("INSERT INTO test_bigint VALUES (?, ?)", [1, bigValue]);

		const rows = await sqlite.query("SELECT * FROM test_bigint");
		assert.equal(rows[0].value, Number(bigValue));
	});

	test("handles zero and negative numbers", async () => {
		await sqlite.exec("CREATE TABLE test_numbers (id INTEGER, value INTEGER)");
		await sqlite.exec("INSERT INTO test_numbers VALUES (1, ?), (2, ?), (3, ?)", [0, -100, -3.14]);

		const rows = await sqlite.query("SELECT * FROM test_numbers ORDER BY id");
		assert.equal(rows[0].value, 0);
		assert.equal(rows[1].value, -100);
		assert.equal(rows[2].value, -3.14);
	});
});

describe("SQLiteWrapper - CRUD Operations", () => {
	beforeEach(async () => {
		await sqlite.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				email TEXT,
				age INTEGER,
				active INTEGER
			)
		`);
	});

	test("INSERT multiple rows", async () => {
		await sqlite.exec("INSERT INTO users (name, age) VALUES (?, ?)", ["Alice", 25]);
		await sqlite.exec("INSERT INTO users (name, age) VALUES (?, ?)", ["Bob", 30]);
		await sqlite.exec("INSERT INTO users (name, age) VALUES (?, ?)", ["Charlie", 35]);

		const rows = await sqlite.query("SELECT * FROM users");
		assert.equal(rows.length, 3);
		assert.equal(rows[0].name, "Alice");
		assert.equal(rows[1].name, "Bob");
		assert.equal(rows[2].name, "Charlie");
	});

	test("UPDATE operations", async () => {
		await sqlite.exec("INSERT INTO users (name, age) VALUES (?, ?), (?, ?)", [
			"Alice",
			25,
			"Bob",
			30,
		]);

		await sqlite.exec("UPDATE users SET age = ? WHERE name = ?", [26, "Alice"]);

		const rows = await sqlite.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
		assert.equal(rows[0].age, 26);
	});

	test("DELETE operations", async () => {
		await sqlite.exec("INSERT INTO users (name, age) VALUES (?, ?), (?, ?), (?, ?)", [
			"Alice",
			25,
			"Bob",
			30,
			"Charlie",
			35,
		]);

		await sqlite.exec("DELETE FROM users WHERE name = ?", ["Bob"]);

		const rows = await sqlite.query("SELECT * FROM users");
		assert.equal(rows.length, 2);
		assert.equal(rows[0].name, "Alice");
		assert.equal(rows[1].name, "Charlie");
	});

	test("DELETE all rows", async () => {
		await sqlite.exec("INSERT INTO users (name, age) VALUES (?, ?), (?, ?)", ["Alice", 25, "Bob", 30]);

		await sqlite.exec("DELETE FROM users");

		const rows = await sqlite.query("SELECT * FROM users");
		assert.equal(rows.length, 0);
	});

	test("SELECT with WHERE clause", async () => {
		await sqlite.exec("INSERT INTO users (name, age) VALUES (?, ?), (?, ?), (?, ?)", [
			"Alice",
			25,
			"Bob",
			30,
			"Charlie",
			35,
		]);

		const rows = await sqlite.query("SELECT * FROM users WHERE age > ?", [27]);
		assert.equal(rows.length, 2);
		assert.equal(rows[0].name, "Bob");
		assert.equal(rows[1].name, "Charlie");
	});

	test("SELECT with ORDER BY", async () => {
		await sqlite.exec("INSERT INTO users (name, age) VALUES (?, ?), (?, ?), (?, ?)", [
			"Charlie",
			35,
			"Alice",
			25,
			"Bob",
			30,
		]);

		const rows = await sqlite.query("SELECT * FROM users ORDER BY age ASC");
		assert.equal(rows[0].name, "Alice");
		assert.equal(rows[1].name, "Bob");
		assert.equal(rows[2].name, "Charlie");
	});

	test("SELECT with LIMIT", async () => {
		await sqlite.exec("INSERT INTO users (name, age) VALUES (?, ?), (?, ?), (?, ?)", [
			"Alice",
			25,
			"Bob",
			30,
			"Charlie",
			35,
		]);

		const rows = await sqlite.query("SELECT * FROM users LIMIT ?", [2]);
		assert.equal(rows.length, 2);
	});
});

describe("SQLiteWrapper - Query Results", () => {
	test("returns empty array for no results", async () => {
		await sqlite.exec("CREATE TABLE empty_table (id INTEGER, name TEXT)");
		const rows = await sqlite.query("SELECT * FROM empty_table");
		assert.deepEqual(rows, []);
	});

	test("returns all columns correctly", async () => {
		await sqlite.exec("CREATE TABLE test (a INTEGER, b TEXT, c REAL)");
		await sqlite.exec("INSERT INTO test VALUES (?, ?, ?)", [1, "test", 3.14]);

		const rows = await sqlite.query("SELECT * FROM test");
		assert.equal(Object.keys(rows[0]).length, 3);
		assert.equal(rows[0].a, 1);
		assert.equal(rows[0].b, "test");
		assert.equal(rows[0].c, 3.14);
	});

	test("SELECT specific columns", async () => {
		await sqlite.exec("CREATE TABLE test (id INTEGER, name TEXT, age INTEGER)");
		await sqlite.exec("INSERT INTO test VALUES (?, ?, ?)", [1, "Alice", 25]);

		const rows = await sqlite.query("SELECT name, age FROM test");
		assert.equal(Object.keys(rows[0]).length, 2);
		assert.equal(rows[0].name, "Alice");
		assert.equal(rows[0].age, 25);
		assert.equal(rows[0].id, undefined);
	});

	test("handles aggregate functions", async () => {
		await sqlite.exec("CREATE TABLE numbers (value INTEGER)");
		await sqlite.exec("INSERT INTO numbers VALUES (?), (?), (?), (?)", [10, 20, 30, 40]);

		const rows = await sqlite.query("SELECT COUNT(*) as count, SUM(value) as sum, AVG(value) as avg FROM numbers");
		assert.equal(rows[0].count, 4);
		assert.equal(rows[0].sum, 100);
		assert.equal(rows[0].avg, 25);
	});
});

describe("SQLiteWrapper - Multiple Operations", () => {
	test("executes multiple statements in sequence", async () => {
		await sqlite.exec("CREATE TABLE test1 (id INTEGER)");
		await sqlite.exec("CREATE TABLE test2 (id INTEGER)");
		await sqlite.exec("INSERT INTO test1 VALUES (1)");
		await sqlite.exec("INSERT INTO test2 VALUES (2)");

		const rows1 = await sqlite.query("SELECT * FROM test1");
		const rows2 = await sqlite.query("SELECT * FROM test2");
		assert.equal(rows1[0].id, 1);
		assert.equal(rows2[0].id, 2);
	});

	test("handles rapid sequential queries", async () => {
		await sqlite.exec("CREATE TABLE test (id INTEGER)");
		await sqlite.exec("INSERT INTO test VALUES (1), (2), (3), (4), (5)");

		const promises = [];
		for (let i = 0; i < 5; i++) {
			promises.push(sqlite.query("SELECT * FROM test WHERE id = ?", [i + 1]));
		}

		const results = await Promise.all(promises);
		for (let i = 0; i < 5; i++) {
			assert.equal(results[i][0].id, i + 1);
		}
	});
});

describe("SQLiteWrapper - Error Handling", () => {
	test("rejects on invalid SQL syntax", async () => {
		await assert.rejects(async () => {
			await sqlite.exec("INVALID SQL SYNTAX");
		}, /Error/);
	});

	test("rejects on accessing non-existent table", async () => {
		await assert.rejects(async () => {
			await sqlite.query("SELECT * FROM non_existent_table");
		}, /Error/);
	});

	test("rejects on too few parameters", async () => {
		await sqlite.exec("CREATE TABLE test (id INTEGER, name TEXT)");
		await assert.rejects(async () => {
			await sqlite.exec("INSERT INTO test VALUES (?, ?)", [1]);
		}, /Too few parameters/);
	});

	test("handles operations after close", async () => {
		const tempSqlite = new SQLiteWrapper(SQLITE3_PATH);
		tempSqlite.close();

		await assert.rejects(async () => {
			await tempSqlite.exec("CREATE TABLE test (id INTEGER)");
		}, /closed SQLiteWrapper/);
	});
});

describe("SQLiteWrapper - Logger", () => {
	test("works with logger provided", async () => {
		const logs = [];
		const logger = {
			log: (msg) => logs.push(msg),
			info: (msg) => logs.push(msg),
			warn: (msg) => logs.push(msg),
			error: (msg) => logs.push(msg),
			debug: (msg) => logs.push(msg),
		};

		const sqliteWithLogger = new SQLiteWrapper(SQLITE3_PATH, { logger });
		await sqliteWithLogger.exec("CREATE TABLE test (id INTEGER)");
		sqliteWithLogger.close();

		assert.ok(logs.length > 0);
	});

	test("works without logger", async () => {
		const sqliteNoLogger = new SQLiteWrapper(SQLITE3_PATH);
		await sqliteNoLogger.exec("CREATE TABLE test (id INTEGER)");
		const rows = await sqliteNoLogger.query("SELECT * FROM test");
		assert.deepEqual(rows, []);
		sqliteNoLogger.close();
	});
});

describe("SQLiteWrapper - Database with File Path", () => {
	let tempDbPath;

	beforeEach(() => {
		tempDbPath = path.join(os.tmpdir(), `test-${Date.now()}.db`);
	});

	afterEach(() => {
		if (fs.existsSync(tempDbPath)) {
			fs.unlinkSync(tempDbPath);
		}
	});

	test("creates and uses file-based database", async () => {
		const fileSqlite = new SQLiteWrapper(SQLITE3_PATH, { dbPath: tempDbPath });

		await fileSqlite.exec("CREATE TABLE test (id INTEGER, name TEXT)");
		await fileSqlite.exec("INSERT INTO test VALUES (?, ?)", [1, "test"]);

		const rows = await fileSqlite.query("SELECT * FROM test");
		assert.equal(rows[0].id, 1);
		assert.equal(rows[0].name, "test");

		fileSqlite.close();

		// Verify file was created
		assert.ok(fs.existsSync(tempDbPath));
	});

	test("persists data across connections", async () => {
		const sqlite1 = new SQLiteWrapper(SQLITE3_PATH, { dbPath: tempDbPath });
		await sqlite1.exec("CREATE TABLE test (id INTEGER, name TEXT)");
		await sqlite1.exec("INSERT INTO test VALUES (?, ?)", [1, "persistent"]);
		sqlite1.close();

		// Open a new connection to the same file
		const sqlite2 = new SQLiteWrapper(SQLITE3_PATH, { dbPath: tempDbPath });
		const rows = await sqlite2.query("SELECT * FROM test");
		assert.equal(rows[0].id, 1);
		assert.equal(rows[0].name, "persistent");
		sqlite2.close();
	});
});

describe("SQLiteWrapper - SQL Injection Protection", () => {
	test("protects against SQL injection in string parameters", async () => {
		await sqlite.exec("CREATE TABLE users (id INTEGER, name TEXT)");
		await sqlite.exec("INSERT INTO users VALUES (1, ?), (2, ?)", ["Alice", "Bob"]);

		// Attempt SQL injection
		const maliciousInput = "'; DROP TABLE users; --";
		await sqlite.exec("INSERT INTO users VALUES (3, ?)", [maliciousInput]);

		// Table should still exist and have all records
		const rows = await sqlite.query("SELECT * FROM users");
		assert.equal(rows.length, 3);
		assert.equal(rows[2].name, "'; DROP TABLE users; --");
	});

	test("handles quotes in parameters correctly", async () => {
		await sqlite.exec("CREATE TABLE test (value TEXT)");
		await sqlite.exec("INSERT INTO test VALUES (?)", ["It's a test with 'quotes'"]);

		const rows = await sqlite.query("SELECT * FROM test");
		assert.equal(rows[0].value, "It's a test with 'quotes'");
	});
});

describe("SQLiteWrapper - Complex Queries", () => {
	beforeEach(async () => {
		await sqlite.exec(`
			CREATE TABLE customers (
				id INTEGER PRIMARY KEY,
				name TEXT,
				email TEXT
			)
		`);

		await sqlite.exec(`
			CREATE TABLE orders (
				id INTEGER PRIMARY KEY,
				customer_id INTEGER,
				product TEXT,
				amount REAL
			)
		`);

		await sqlite.exec("INSERT INTO customers VALUES (1, ?, ?), (2, ?, ?)", [
			"Alice",
			"alice@example.com",
			"Bob",
			"bob@example.com",
		]);

		await sqlite.exec("INSERT INTO orders VALUES (1, ?, ?, ?), (2, ?, ?, ?), (3, ?, ?, ?)", [
			1,
			"Widget",
			19.99,
			1,
			"Gadget",
			29.99,
			2,
			"Doohickey",
			39.99,
		]);
	});

	test("handles JOIN queries", async () => {
		const rows = await sqlite.query(`
			SELECT customers.name, orders.product, orders.amount
			FROM customers
			JOIN orders ON customers.id = orders.customer_id
			WHERE customers.id = ?
		`, [1]);

		assert.equal(rows.length, 2);
		assert.equal(rows[0].name, "Alice");
		assert.equal(rows[0].product, "Widget");
	});

	test("handles GROUP BY queries", async () => {
		const rows = await sqlite.query(`
			SELECT customer_id, COUNT(*) as order_count, SUM(amount) as total
			FROM orders
			GROUP BY customer_id
		`);

		assert.equal(rows.length, 2);
		assert.equal(rows[0].order_count, 2);
		assert.equal(rows[1].order_count, 1);
	});

	test("handles subqueries", async () => {
		const rows = await sqlite.query(`
			SELECT name FROM customers
			WHERE id IN (SELECT customer_id FROM orders WHERE amount > ?)
		`, [25]);

		assert.equal(rows.length, 2);
	});
});
