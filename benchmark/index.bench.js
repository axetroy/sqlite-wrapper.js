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
const BURST_INSERT_COUNT = 20000;
const CHUNKED_ENQUEUE_SIZE = 1000;

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
 * @param {string} [title] - Optional title override
 */
function displayResults(results, title = "SQLite Wrapper Benchmark Results") {
	const terminalWidth = Number(process.stdout.columns) || 120;
	const separators = 5; // one space between each adjacent column
	const minNameWidth = 20;
	const maxNameWidth = 72;
	const metricTitles = ["Avg (ms)", "Min (ms)", "Max (ms)", "Total (ms)", "Ops/sec"];
	const metricWidths = [10, 10, 10, 11, 10];
	const metricMinWidths = [8, 8, 8, 10, 8];

	const metricWidthSum = () => metricWidths.reduce((sum, width) => sum + width, 0);
	let nameWidth = Math.max(minNameWidth, Math.min(maxNameWidth, terminalWidth - metricWidthSum() - separators));
	let tableWidth = nameWidth + metricWidthSum() + separators;

	if (tableWidth > terminalWidth) {
		let overflow = tableWidth - terminalWidth;

		while (overflow > 0 && nameWidth > minNameWidth) {
			nameWidth--;
			overflow--;
		}

		while (overflow > 0) {
			let shrunk = false;

			for (let i = 0; i < metricWidths.length && overflow > 0; i++) {
				if (metricWidths[i] > metricMinWidths[i]) {
					metricWidths[i]--;
					overflow--;
					shrunk = true;
				}
			}

			if (!shrunk) break;
		}

		tableWidth = Math.min(terminalWidth, nameWidth + metricWidthSum() + separators);
	}

	const truncate = (text, width) => {
		if (text.length <= width) return text;
		if (width <= 3) return text.slice(0, width);
		return text.slice(0, width - 3) + "...";
	};

	const formatLeft = (text, width) => truncate(String(text), width).padEnd(width);
	const formatRight = (text, width) => {
		const value = String(text);
		if (value.length > width) return value.slice(0, width);
		return value.padStart(width);
	};

	console.log("\n" + "=".repeat(tableWidth));
	console.log(title);
	console.log("=".repeat(tableWidth));
	console.log(
		[
			formatLeft("Benchmark", nameWidth),
			formatRight(metricTitles[0], metricWidths[0]),
			formatRight(metricTitles[1], metricWidths[1]),
			formatRight(metricTitles[2], metricWidths[2]),
			formatRight(metricTitles[3], metricWidths[3]),
			formatRight(metricTitles[4], metricWidths[4]),
		].join(" "),
	);
	console.log("-".repeat(tableWidth));

	for (const result of results) {
		console.log(
			[
				formatLeft(result.name, nameWidth),
				formatRight(result.avgTime, metricWidths[0]),
				formatRight(result.minTime, metricWidths[1]),
				formatRight(result.maxTime, metricWidths[2]),
				formatRight(result.totalTime, metricWidths[3]),
				formatRight(result.opsPerSecond, metricWidths[4]),
			].join(" "),
		);
	}

	console.log("=".repeat(tableWidth) + "\n");
}

/**
 * 并排显示单进程模式与读写分离模式的对比结果
 * @param {Array<{label: string, concurrency: number, single: object, pool: object, poolSize: number}>} pairs
 */
function displayComparisonResults(pairs) {
	const terminalWidth = Number(process.stdout.columns) || 140;

	// 列宽定义
	const labelWidth = 36;
	const numWidth = 14;
	const speedupWidth = 10;
	// 6 列之间 5 个空格分隔
	const tableWidth = Math.min(terminalWidth, labelWidth + numWidth * 4 + speedupWidth + 5);

	const padL = (s, w) => {
		const str = String(s);
		return str.length >= w ? str.slice(0, w) : str.padEnd(w);
	};
	const padR = (s, w) => {
		const str = String(s);
		return str.length >= w ? str.slice(0, w) : str.padStart(w);
	};

	console.log("\n" + "=".repeat(tableWidth));
	console.log("读写分离（readPoolSize）对比结果");
	console.log("=".repeat(tableWidth));
	console.log(
		[
			padL("测试场景", labelWidth),
			padR("单进程 Avg(ms)", numWidth),
			padR("Pool Avg(ms)", numWidth),
			padR("单进程 Ops/s", numWidth),
			padR("Pool Ops/s", numWidth),
			padR("提升", speedupWidth),
		].join(" "),
	);
	console.log("-".repeat(tableWidth));

	for (const { label, single, pool } of pairs) {
		const speedup = (parseFloat(pool.opsPerSecond) / parseFloat(single.opsPerSecond)).toFixed(2);
		console.log(
			[
				padL(label, labelWidth),
				padR(single.avgTime, numWidth),
				padR(pool.avgTime, numWidth),
				padR(single.opsPerSecond, numWidth),
				padR(pool.opsPerSecond, numWidth),
				padR(`${speedup}x`, speedupWidth),
			].join(" "),
		);
	}

	console.log("=".repeat(tableWidth));
	console.log("注：Ops/s = 每秒完成的批次数（每批含多个并发查询）；提升 = Pool Ops/s ÷ 单进程 Ops/s\n");
}

async function main() {
	// Get SQLite3 path (downloaded or system)
	const sqlite3Path = await getSqlite3Path();
	console.log(`Using SQLite3 at: ${sqlite3Path}\n`);

	const results = [];
	const comparisonPairs = [];

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

	// Benchmark 14: burst enqueue tens-of-thousands inserts end-to-end
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		await sqlite.exec("DROP TABLE IF EXISTS burst_enqueued_insert_bench");
		await sqlite.exec(`
			CREATE TABLE burst_enqueued_insert_bench (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				score INTEGER NOT NULL
			)
		`);

		results.push(
			await benchmarkWorkload(`20k Burst Enqueue INSERT (Promise.all)`, BURST_INSERT_COUNT, async () => {
				await sqlite.exec("BEGIN TRANSACTION");

				const jobs = [];
				for (let i = 1; i <= BURST_INSERT_COUNT; i++) {
					jobs.push(
						sqlite.exec("INSERT INTO burst_enqueued_insert_bench (id, name, score) VALUES (?, ?, ?)", [i, `User ${i}`, i % 1000]),
					);
				}

				await Promise.all(jobs);
				await sqlite.exec("COMMIT");
			}),
		);
		sqlite.close();
	}

	// Benchmark 15: sequential enqueue tens-of-thousands inserts end-to-end
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		await sqlite.exec("DROP TABLE IF EXISTS sequential_enqueued_insert_bench");
		await sqlite.exec(`
			CREATE TABLE sequential_enqueued_insert_bench (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				score INTEGER NOT NULL
			)
		`);

		results.push(
			await benchmarkWorkload(`20k Sequential Enqueue INSERT (await loop)`, BURST_INSERT_COUNT, async () => {
				await sqlite.exec("BEGIN TRANSACTION");

				for (let i = 1; i <= BURST_INSERT_COUNT; i++) {
					await sqlite.exec("INSERT INTO sequential_enqueued_insert_bench (id, name, score) VALUES (?, ?, ?)", [
						i,
						`User ${i}`,
						i % 1000,
					]);
				}

				await sqlite.exec("COMMIT");
			}),
		);
		sqlite.close();
	}

	// Benchmark 16: chunked enqueue tens-of-thousands inserts end-to-end
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		await sqlite.exec("DROP TABLE IF EXISTS chunked_enqueued_insert_bench");
		await sqlite.exec(`
			CREATE TABLE chunked_enqueued_insert_bench (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				score INTEGER NOT NULL
			)
		`);

		results.push(
			await benchmarkWorkload(
				`20k Chunked Enqueue INSERT (${CHUNKED_ENQUEUE_SIZE}/chunk)` ,
				BURST_INSERT_COUNT,
				async () => {
					await sqlite.exec("BEGIN TRANSACTION");

					for (let start = 1; start <= BURST_INSERT_COUNT; start += CHUNKED_ENQUEUE_SIZE) {
						const end = Math.min(start + CHUNKED_ENQUEUE_SIZE - 1, BURST_INSERT_COUNT);
						const jobs = [];

						for (let i = start; i <= end; i++) {
							jobs.push(
								sqlite.exec("INSERT INTO chunked_enqueued_insert_bench (id, name, score) VALUES (?, ?, ?)", [
									i,
									`User ${i}`,
									i % 1000,
								]),
							);
						}

						await Promise.all(jobs);
					}

					await sqlite.exec("COMMIT");
				},
			),
		);
		sqlite.close();
	}

	// Benchmark 17: burst enqueue tens-of-thousands updates end-to-end
	{
		const sqlite = new SQLiteWrapper(sqlite3Path, { dbPath });
		await sqlite.exec("DROP TABLE IF EXISTS burst_enqueued_update_bench");
		await sqlite.exec(`
			CREATE TABLE burst_enqueued_update_bench (
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
				SELECT n + 1 FROM seq WHERE n < ${BURST_INSERT_COUNT}
			)
			INSERT INTO burst_enqueued_update_bench (id, name, score, updated_at)
			SELECT n, 'User ' || n, n % 1000, datetime('now')
			FROM seq
		`);

		results.push(
			await benchmarkWorkload(`20k Burst Enqueue UPDATE (Promise.all)`, BURST_INSERT_COUNT, async () => {
				await sqlite.exec("BEGIN TRANSACTION");

				const jobs = [];
				for (let i = 1; i <= BURST_INSERT_COUNT; i++) {
					jobs.push(
						sqlite.exec(
							"UPDATE burst_enqueued_update_bench SET score = ?, updated_at = datetime('now') WHERE id = ?",
							[(i + 7) % 1000, i],
						),
					);
				}

				await Promise.all(jobs);
				await sqlite.exec("COMMIT");
			}),
		);
		sqlite.close();
	}

	// ============================================================
	// 读写分离（readPoolSize）对比基准（18-20）
	// 相同负载分别用单进程模式与 readPoolSize=4 运行，量化读进程池带来的吞吐提升。
	// ============================================================

	const readPoolDbPath = path.join(__dirname, "benchmark-readpool.db");
	const READ_POOL_TABLE_ROWS = 100000;
	const CONCURRENT_QUERY_COUNT = 20;
	const READS_PER_WRITE = 5;
	const POOL_SIZE = 4;
	const CONCURRENT_BENCH_ITERS = 100;
	const RW_BENCH_ITERS = 500;

	// 清理可能残留的文件
	for (const ext of ["", "-wal", "-shm"]) {
		const p = readPoolDbPath + ext;
		if (fs.existsSync(p)) fs.unlinkSync(p);
	}

	// 初始化共享只读数据表
	{
		console.log(`Preparing read-pool comparison table (${READ_POOL_TABLE_ROWS} rows)...`);
		const setupDb = new SQLiteWrapper(sqlite3Path, { dbPath: readPoolDbPath });
		await setupDb.exec(`
			CREATE TABLE read_pool_bench (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				category INTEGER NOT NULL,
				score INTEGER NOT NULL
			)
		`);
		await setupDb.exec(`
			WITH RECURSIVE seq(n) AS (
				SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${READ_POOL_TABLE_ROWS}
			)
			INSERT INTO read_pool_bench SELECT n, 'User ' || n, n % 100, (n * 13) % 1000 FROM seq
		`);
		await setupDb.exec("CREATE INDEX idx_rpb_category ON read_pool_bench(category)");
		await setupDb.exec("CREATE INDEX idx_rpb_score ON read_pool_bench(score)");
		setupDb.close();
	}

	// 基准 18: 并发点查询（单进程 vs 读写分离）
	// 每次迭代同时发出 CONCURRENT_QUERY_COUNT 个点查询（Promise.all）
	{
		let qid = 0;
		const single = new SQLiteWrapper(sqlite3Path, { dbPath: readPoolDbPath });
		const singleResult = await benchmark(
			`并发点查询 (${CONCURRENT_QUERY_COUNT}路) - 单进程`,
			async () => {
				await Promise.all(
					Array.from({ length: CONCURRENT_QUERY_COUNT }, () =>
						single.query("SELECT id, name, score FROM read_pool_bench WHERE id = ?", [(qid++ % READ_POOL_TABLE_ROWS) + 1]),
					),
				);
			},
			CONCURRENT_BENCH_ITERS,
		);
		single.close();

		qid = 0;
		const pool = new SQLiteWrapper(sqlite3Path, { dbPath: readPoolDbPath, readPoolSize: POOL_SIZE });
		await pool.exec("SELECT 1"); // 等待 WAL 初始化完成
		const poolResult = await benchmark(
			`并发点查询 (${CONCURRENT_QUERY_COUNT}路) - 读写分离(pool=${POOL_SIZE})`,
			async () => {
				await Promise.all(
					Array.from({ length: CONCURRENT_QUERY_COUNT }, () =>
						pool.query("SELECT id, name, score FROM read_pool_bench WHERE id = ?", [(qid++ % READ_POOL_TABLE_ROWS) + 1]),
					),
				);
			},
			CONCURRENT_BENCH_ITERS,
		);
		pool.close();

		results.push(singleResult);
		results.push(poolResult);
		comparisonPairs.push({
			label: `并发点查询 (${CONCURRENT_QUERY_COUNT}路并发)`,
			concurrency: CONCURRENT_QUERY_COUNT,
			single: singleResult,
			pool: poolResult,
		});
	}

	// 基准 19: 并发范围查询（单进程 vs 读写分离）
	// 每次迭代同时发出 CONCURRENT_QUERY_COUNT 个范围查询（Promise.all）
	{
		let cat = 0;
		const single = new SQLiteWrapper(sqlite3Path, { dbPath: readPoolDbPath });
		const singleResult = await benchmark(
			`并发范围查询 (${CONCURRENT_QUERY_COUNT}路) - 单进程`,
			async () => {
				await Promise.all(
					Array.from({ length: CONCURRENT_QUERY_COUNT }, (_, i) =>
						single.query("SELECT id, score FROM read_pool_bench WHERE category = ? ORDER BY id LIMIT 50", [(cat + i) % 100]),
					),
				);
				cat = (cat + CONCURRENT_QUERY_COUNT) % 100;
			},
			CONCURRENT_BENCH_ITERS,
		);
		single.close();

		cat = 0;
		const pool = new SQLiteWrapper(sqlite3Path, { dbPath: readPoolDbPath, readPoolSize: POOL_SIZE });
		await pool.exec("SELECT 1");
		const poolResult = await benchmark(
			`并发范围查询 (${CONCURRENT_QUERY_COUNT}路) - 读写分离(pool=${POOL_SIZE})`,
			async () => {
				await Promise.all(
					Array.from({ length: CONCURRENT_QUERY_COUNT }, (_, i) =>
						pool.query("SELECT id, score FROM read_pool_bench WHERE category = ? ORDER BY id LIMIT 50", [(cat + i) % 100]),
					),
				);
				cat = (cat + CONCURRENT_QUERY_COUNT) % 100;
			},
			CONCURRENT_BENCH_ITERS,
		);
		pool.close();

		results.push(singleResult);
		results.push(poolResult);
		comparisonPairs.push({
			label: `并发范围查询 (${CONCURRENT_QUERY_COUNT}路并发)`,
			concurrency: CONCURRENT_QUERY_COUNT,
			single: singleResult,
			pool: poolResult,
		});
	}

	// 基准 20: 读写并发（1次写入 + READS_PER_WRITE 个并发读取，单进程 vs 读写分离）
	// 每次迭代：1 个 exec() INSERT 与 READS_PER_WRITE 个 query() SELECT 并发执行
	{
		const single = new SQLiteWrapper(sqlite3Path, { dbPath: readPoolDbPath });
		await single.exec("CREATE TABLE IF NOT EXISTS rw_bench_single (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
		let wid = 0;
		const singleResult = await benchmark(
			`读写并发 (1写+${READS_PER_WRITE}读) - 单进程`,
			async () => {
				const readId = (wid % READ_POOL_TABLE_ROWS) + 1;
				await Promise.all([
					single.exec("INSERT INTO rw_bench_single (val) VALUES (?)", [`v${wid++}`]),
					...Array.from({ length: READS_PER_WRITE }, () =>
						single.query("SELECT id, name, score FROM read_pool_bench WHERE id = ?", [readId]),
					),
				]);
			},
			RW_BENCH_ITERS,
		);
		single.close();

		const pool = new SQLiteWrapper(sqlite3Path, { dbPath: readPoolDbPath, readPoolSize: POOL_SIZE });
		await pool.exec("SELECT 1");
		await pool.exec("CREATE TABLE IF NOT EXISTS rw_bench_pool (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
		wid = 0;
		const poolResult = await benchmark(
			`读写并发 (1写+${READS_PER_WRITE}读) - 读写分离(pool=${POOL_SIZE})`,
			async () => {
				const readId = (wid % READ_POOL_TABLE_ROWS) + 1;
				await Promise.all([
					pool.exec("INSERT INTO rw_bench_pool (val) VALUES (?)", [`v${wid++}`]),
					...Array.from({ length: READS_PER_WRITE }, () =>
						pool.query("SELECT id, name, score FROM read_pool_bench WHERE id = ?", [readId]),
					),
				]);
			},
			RW_BENCH_ITERS,
		);
		pool.close();

		results.push(singleResult);
		results.push(poolResult);
		comparisonPairs.push({
			label: `读写并发 (1写+${READS_PER_WRITE}读)`,
			concurrency: READS_PER_WRITE + 1,
			single: singleResult,
			pool: poolResult,
		});
	}

	// 清理读写分离对比测试数据库
	for (const ext of ["", "-wal", "-shm"]) {
		const p = readPoolDbPath + ext;
		if (fs.existsSync(p)) fs.unlinkSync(p);
	}

	// Display results
	displayResults(results);
	displayComparisonResults(comparisonPairs);

	// Clean up
	if (fs.existsSync(dbPath)) {
		fs.unlinkSync(dbPath);
	}

	console.log("Benchmarks completed!");
}

main().catch(console.error);
