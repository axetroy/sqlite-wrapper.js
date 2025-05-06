import assert from "node:assert";
import path from "path";
import outdent from "outdent";

import test, { afterEach, beforeEach, describe } from "node:test";

import { SQLiteWrapper } from "./index.js";
import { fileURLToPath } from "url";

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
})

afterEach(async () => {
	await sqlite.close();
});

describe("SQLiteWrapper", () => {
	test("connect", async () => {
		sqlite = new SQLiteWrapper(SQLite3BinaryFile);

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
