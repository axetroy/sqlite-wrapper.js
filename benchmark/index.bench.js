import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import { SQLiteWrapper } from "../src/index.js";
import downloadSQLite3 from "../script/download-sqlite3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.join(__dirname, "..");
const dbPath = path.join(__dirname, "benchmark.db");

// Clean up database before starting
if (fs.existsSync(dbPath)) {
	fs.unlinkSync(dbPath);
}

// Benchmark configuration constants
const PRODUCT_COUNT = 1000;
const CUSTOMER_COUNT = 100;
const ORDER_COUNT = 1000;
const TEMP_DATA_COUNT = 5000;
const LARGE_TABLE_ROW_COUNT = 100000;
const SIMPLE_COMMAND_COUNT = 100000;

/**
 * Get SQLite3 path, trying downloaded binary first, then system sqlite3
 * @returns {Promise<string>}
 */
async function getSqlite3Path() {
	const downloadedPath = path.join(root, "bin", "sqlite3" + (process.platform === "win32" ? ".exe" : ""));

	if (fs.existsSync(downloadedPath)) {
		return downloadedPath;
	}

	// Try to download SQLite3 binary
	try {
		await downloadSQLite3();
		if (fs.existsSync(downloadedPath)) {
			return downloadedPath;
		}
	} catch (error) {
		// Download failed, will use system sqlite3
		console.error("Failed to download SQLite3 binary, falling back to system sqlite3:", error);
	}

	// If none found, fall back to system sqlite3
	return "sqlite3" + (process.platform === "win32" ? ".exe" : "");
}

/**
 * Benchmark runner
 * @param {string} name - Benchmark name
 * @param {Function} fn - Function to benchmark
 * @param {number} iterations - Number of iterations
 * @returns {Promise<{name: string, avgTime: number, minTime: number, maxTime: number, totalTime: number, opsPerSecond: number}>}
 */
async function benchmark(name, fn, iterations = 100) {
	const times = [];

	// Warmup
	for (let i = 0; i < Math.min(10, iterations); i++) {
		await fn();
	}

	// Actual benchmark
	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		await fn();
		const end = performance.now();
		times.push(end - start);
	}

	const totalTime = times.reduce((a, b) => a + b, 0);
	const avgTime = totalTime / iterations;
	const minTime = Math.min(...times);
	const maxTime = Math.max(...times);
	const opsPerSecond = 1000 / avgTime;

	return {
		name,
		kind: "sample",
		avgTime: avgTime.toFixed(3),
		minTime: minTime.toFixed(3),
		maxTime: maxTime.toFixed(3),
		totalTime: totalTime.toFixed(3),
		opsPerSecond: opsPerSecond.toFixed(2),
	};
}

/**
 * Measure a fixed-size workload end-to-end.
 * @param {string} name - Benchmark name
 * @param {number} operationCount - Number of operations executed by fn
 * @param {Function} fn - Function that executes the whole workload
 * @returns {Promise<{name: string, kind: string, operationCount: number, avgTime: string, minTime: string, maxTime: string, totalTime: string, opsPerSecond: string}>}
 */
async function benchmarkWorkload(name, operationCount, fn) {
	const start = performance.now();
	await fn();
	const totalTime = performance.now() - start;
	const avgTime = totalTime / operationCount;
	const opsPerSecond = operationCount / (totalTime / 1000);

	return {
		name,
		kind: "workload",
		operationCount,
		avgTime: avgTime.toFixed(6),
		minTime: "-",
		maxTime: "-",
		totalTime: totalTime.toFixed(3),
		opsPerSecond: opsPerSecond.toFixed(2),
	};
}

/**
 * Format and display benchmark results
 * @param {Array} results - Array of benchmark results
 */
function displayResults(results) {
	console.log("\n" + "=".repeat(80));
	console.log("SQLite Wrapper Benchmark Results");
	console.log("=".repeat(80));
	console.log(
		`${"Benchmark".padEnd(40)} ${"Avg (ms)".padStart(10)} ${"Min (ms)".padStart(10)} ${"Max (ms)".padStart(10)} ${"Total (ms)".padStart(12)} ${"Ops/sec".padStart(
			10,
		)}`,
	);
	console.log("-".repeat(80));

	for (const result of results) {
		console.log(
			`${result.name.padEnd(40)} ${result.avgTime.padStart(10)} ${result.minTime.padStart(10)} ${result.maxTime.padStart(
				10,
			)} ${result.totalTime.padStart(12)} ${result.opsPerSecond.padStart(10)}`,
		);
	}

	console.log("=".repeat(80) + "\n");
}

async function main() {
	// Get SQLite3 path (downloaded or system)
	const sqlite3Path = await getSqlite3Path();
	console.log(`Using SQLite3 at: ${sqlite3Path}\n`);

	const results = [];

	console.log("Starting benchmarks...\n");

	// Benchmark 1: Table creation
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		let counter = 0;
		results.push(
			await benchmark(
				"Table Creation",
				async () => {
					await sqlite.exec(`CREATE TABLE IF NOT EXISTS test_table_${counter++} (id INTEGER PRIMARY KEY, name TEXT)`);
				},
				50,
			),
		);
		sqlite.close();
	}

	// Benchmark 2: Single insert
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		await sqlite.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, age INTEGER)");
		results.push(
			await benchmark(
				"Single Row Insert",
				async () => {
					await sqlite.exec("INSERT INTO users (name, age) VALUES (?, ?)", ["John Doe", 30]);
				},
				1000,
			),
		);
		sqlite.close();
	}

	// Benchmark 3: Bulk insert (with transaction)
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		await sqlite.exec("CREATE TABLE IF NOT EXISTS bulk_test (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)");
		results.push(
			await benchmark(
				"Bulk Insert (100 rows with transaction)",
				async () => {
					await sqlite.exec("BEGIN TRANSACTION");
					for (let i = 0; i < 100; i++) {
						await sqlite.exec("INSERT INTO bulk_test (value) VALUES (?)", [`value_${i}`]);
					}
					await sqlite.exec("COMMIT");
				},
				10,
			),
		);
		sqlite.close();
	}

	// Benchmark 4: Simple SELECT query
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		await sqlite.exec("CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price REAL)");
		// Insert test data with transaction for efficiency
		await sqlite.exec("BEGIN TRANSACTION");
		for (let i = 0; i < PRODUCT_COUNT; i++) {
			await sqlite.exec("INSERT INTO products (name, price) VALUES (?, ?)", [`Product ${i}`, Math.random() * 100]);
		}
		await sqlite.exec("COMMIT");
		results.push(
			await benchmark(
				`Simple SELECT (${PRODUCT_COUNT} rows)`,
				async () => {
					await sqlite.query("SELECT * FROM products");
				},
				100,
			),
		);
		sqlite.close();
	}

	// Benchmark 5: SELECT with WHERE clause
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		results.push(
			await benchmark(
				"SELECT with WHERE clause",
				async () => {
					await sqlite.query("SELECT * FROM products WHERE price > ?", [50]);
				},
				100,
			),
		);
		sqlite.close();
	}

	// Benchmark 6: UPDATE operation
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		results.push(
			await benchmark(
				"UPDATE Single Row",
				async () => {
					const id = Math.floor(Math.random() * PRODUCT_COUNT) + 1;
					await sqlite.exec("UPDATE products SET price = ? WHERE id = ?", [99.99, id]);
				},
				500,
			),
		);
		sqlite.close();
	}

	// Benchmark 7: DELETE operation
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		await sqlite.exec("CREATE TABLE IF NOT EXISTS temp_data (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT)");
		// Pre-populate with data using transaction
		await sqlite.exec("BEGIN TRANSACTION");
		for (let i = 0; i < TEMP_DATA_COUNT; i++) {
			await sqlite.exec("INSERT INTO temp_data (data) VALUES (?)", [`data_${i}`]);
		}
		await sqlite.exec("COMMIT");
		let deleteId = 1;
		results.push(
			await benchmark(
				"DELETE Single Row",
				async () => {
					await sqlite.exec("DELETE FROM temp_data WHERE id = ?", [deleteId++]);
				},
				500,
			),
		);
		sqlite.close();
	}

	// Benchmark 8: Complex JOIN query
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		await sqlite.exec(`
			CREATE TABLE IF NOT EXISTS orders (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER,
				total REAL
			)
		`);
		await sqlite.exec(`
			CREATE TABLE IF NOT EXISTS customers (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT
			)
		`);
		// Insert test data with transactions for efficiency
		await sqlite.exec("BEGIN TRANSACTION");
		for (let i = 0; i < CUSTOMER_COUNT; i++) {
			await sqlite.exec("INSERT INTO customers (name) VALUES (?)", [`Customer ${i}`]);
		}
		await sqlite.exec("COMMIT");

		await sqlite.exec("BEGIN TRANSACTION");
		for (let i = 0; i < ORDER_COUNT; i++) {
			await sqlite.exec("INSERT INTO orders (user_id, total) VALUES (?, ?)", [
				Math.floor(Math.random() * CUSTOMER_COUNT) + 1,
				Math.random() * 1000,
			]);
		}
		await sqlite.exec("COMMIT");

		results.push(
			await benchmark(
				`JOIN Query (${ORDER_COUNT} orders, ${CUSTOMER_COUNT} customers)`,
				async () => {
					await sqlite.query("SELECT orders.*, customers.name FROM orders JOIN customers ON orders.user_id = customers.id");
				},
				50,
			),
		);
		sqlite.close();
	}

	// Benchmark 9: Transaction with multiple operations
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		await sqlite.exec("CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, amount REAL)");
		results.push(
			await benchmark(
				"Transaction (5 inserts)",
				async () => {
					await sqlite.exec("BEGIN TRANSACTION");
					for (let i = 0; i < 5; i++) {
						await sqlite.exec("INSERT INTO transactions (amount) VALUES (?)", [Math.random() * 100]);
					}
					await sqlite.exec("COMMIT");
				},
				100,
			),
		);
		sqlite.close();
	}

	// Benchmark 10: 100k-row table (query + update performance)
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		console.log(`Preparing 100k-row benchmark table (${LARGE_TABLE_ROW_COUNT} rows)...`);

		await sqlite.exec("DROP TABLE IF EXISTS large_bench");
		await sqlite.exec(`
			CREATE TABLE large_bench (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				category INTEGER NOT NULL,
				score INTEGER NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);

		// Use recursive CTE to seed 100k rows in one statement to keep setup time manageable.
		await sqlite.exec(`
			WITH RECURSIVE seq(n) AS (
				SELECT 1
				UNION ALL
				SELECT n + 1 FROM seq WHERE n < ${LARGE_TABLE_ROW_COUNT}
			)
			INSERT INTO large_bench (id, name, category, score, updated_at)
			SELECT
				n,
				'User ' || n,
				n % 100,
				(n * 13) % 1000,
				datetime('now')
			FROM seq
		`);

		await sqlite.exec("CREATE INDEX IF NOT EXISTS idx_large_bench_category ON large_bench(category)");
		await sqlite.exec("CREATE INDEX IF NOT EXISTS idx_large_bench_score ON large_bench(score)");

		let queryId = 1;
		results.push(
			await benchmark(
				`100k Point Query by ID (${LARGE_TABLE_ROW_COUNT} rows)`,
				async () => {
					await sqlite.query("SELECT id, name, score FROM large_bench WHERE id = ?", [queryId]);
					queryId++;
					if (queryId > LARGE_TABLE_ROW_COUNT) queryId = 1;
				},
				1000,
			),
		);

		let category = 0;
		results.push(
			await benchmark(
				`100k Range Query by Category (${LARGE_TABLE_ROW_COUNT} rows)`,
				async () => {
					await sqlite.query("SELECT id, score FROM large_bench WHERE category = ? ORDER BY id LIMIT 200", [category]);
					category = (category + 1) % 100;
				},
				200,
			),
		);

		results.push(
			await benchmark(
				`100k Aggregate Query (${LARGE_TABLE_ROW_COUNT} rows)`,
				async () => {
					await sqlite.query("SELECT category, COUNT(*) AS total, AVG(score) AS avg_score FROM large_bench GROUP BY category");
				},
				100,
			),
		);

		let updateId = 1;
		results.push(
			await benchmark(
				`100k Single Row Update (${LARGE_TABLE_ROW_COUNT} rows)`,
				async () => {
					await sqlite.exec("UPDATE large_bench SET score = ?, updated_at = datetime('now') WHERE id = ?", [999, updateId]);
					updateId++;
					if (updateId > LARGE_TABLE_ROW_COUNT) updateId = 1;
				},
				1000,
			),
		);

		let updateOffset = 0;
		results.push(
			await benchmark(
				`100k Batch Update 100 rows (${LARGE_TABLE_ROW_COUNT} rows)`,
				async () => {
					const minId = (updateOffset % (LARGE_TABLE_ROW_COUNT - 100)) + 1;
					const maxId = minId + 99;
					await sqlite.exec("BEGIN TRANSACTION");
					await sqlite.exec("UPDATE large_bench SET score = score + 1, updated_at = datetime('now') WHERE id BETWEEN ? AND ?", [
						minId,
						maxId,
					]);
					await sqlite.exec("COMMIT");
					updateOffset += 100;
				},
				100,
			),
		);

		sqlite.close();
	}

	// Benchmark 11: digest 100k simple commands end-to-end
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		results.push(
			await benchmarkWorkload(`100k Simple Commands (SELECT 1)`, SIMPLE_COMMAND_COUNT, async () => {
				for (let i = 0; i < SIMPLE_COMMAND_COUNT; i++) {
					await sqlite.exec("SELECT 1");
				}
			}),
		);
		sqlite.close();
	}

	// Benchmark 12: digest 100k inserts end-to-end
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		await sqlite.exec("DROP TABLE IF EXISTS insert_100k_bench");
		await sqlite.exec(`
			CREATE TABLE insert_100k_bench (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				score INTEGER NOT NULL
			)
		`);

		results.push(
			await benchmarkWorkload(`100k Sequential INSERT`, SIMPLE_COMMAND_COUNT, async () => {
				for (let i = 1; i <= SIMPLE_COMMAND_COUNT; i++) {
					await sqlite.exec("INSERT INTO insert_100k_bench (id, name, score) VALUES (?, ?, ?)", [i, `User ${i}`, i % 1000]);
				}
			}),
		);
		sqlite.close();
	}

	// Benchmark 13: digest 100k updates end-to-end
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		await sqlite.exec("DROP TABLE IF EXISTS update_100k_bench");
		await sqlite.exec(`
			CREATE TABLE update_100k_bench (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				score INTEGER NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);

		await sqlite.exec(`
			WITH RECURSIVE seq(n) AS (
				SELECT 1
				UNION ALL
				SELECT n + 1 FROM seq WHERE n < ${SIMPLE_COMMAND_COUNT}
			)
			INSERT INTO update_100k_bench (id, name, score, updated_at)
			SELECT
				n,
				'User ' || n,
				n % 1000,
				datetime('now')
			FROM seq
		`);

		results.push(
			await benchmarkWorkload(`100k Sequential UPDATE`, SIMPLE_COMMAND_COUNT, async () => {
				for (let i = 1; i <= SIMPLE_COMMAND_COUNT; i++) {
					await sqlite.exec("UPDATE update_100k_bench SET score = ?, updated_at = datetime('now') WHERE id = ?", [(i + 1) % 1000, i]);
				}
			}),
		);
		sqlite.close();
	}

	// Display results
	displayResults(results);

	// Clean up
	if (fs.existsSync(dbPath)) {
		fs.unlinkSync(dbPath);
	}

	console.log("Benchmarks completed!");
}

main().catch(console.error);
