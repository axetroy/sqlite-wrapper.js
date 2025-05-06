import assert from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import outdent from "outdent";

import { SQLiteWrapper } from "./index.js";
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

afterEach(async () => {
	await sqlite.close();
});

describe("SQLiteWrapper", () => {
	test("create table", async () => {
		await sqlite.exec(outdent`
			CREATE TABLE IF NOT EXISTS users (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT
			);

			INSERT INTO users (name) VALUES ('Alice');
			INSERT INTO users (name) VALUES ('Bob');
		`);
	});

	test("create table and query", async () => {
		await sqlite.exec(outdent`
			CREATE TABLE IF NOT EXISTS users (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT
			);

			INSERT INTO users (name) VALUES ('Alice');
			INSERT INTO users (name) VALUES ('Bob');
		`);

		const rows = await sqlite.query("SELECT * FROM users");

		assert.deepEqual(rows, [
			{ id: 1, name: "Alice" },
			{ id: 2, name: "Bob" },
		]);
	});
});
