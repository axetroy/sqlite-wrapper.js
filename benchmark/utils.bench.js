import { performance } from "node:perf_hooks";

import { escapeValue, interpolateSQL } from "../src/index.js";
import { normalizeSQL } from "../src/utils.js";

const ITERATIONS = 200000;

function formatBytes(bytes) {
	const units = ["B", "KB", "MB", "GB"];
	let i = 0;
	let n = bytes;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return `${n.toFixed(2)} ${units[i]}`;
}

function createLargeSQL(targetBytes, withComments = false) {
	const chunk = withComments
		? "SELECT id, name FROM users WHERE note = 'a -- literal' AND age > 18; -- comment\n"
		: "SELECT id, name FROM users WHERE age > 18;\n";

	const parts = [];
	let size = 0;
	while (size < targetBytes) {
		parts.push(chunk);
		size += chunk.length;
	}

	return parts.join("");
}

async function benchmarkWorkload(name, operationCount, fn) {
	const start = performance.now();
	await fn();
	const totalTime = performance.now() - start;
	const avgTime = totalTime / operationCount;
	const opsPerSecond = operationCount / (totalTime / 1000);

	return {
		name,
		avgTime: avgTime.toFixed(6),
		minTime: "-",
		maxTime: "-",
		totalTime: totalTime.toFixed(3),
		opsPerSecond: opsPerSecond.toFixed(2),
	};
}

function displayResults(results) {
	const terminalWidth = Number(process.stdout.columns) || 120;
	const separators = 5;
	const metricTitles = ["Avg (ms)", "Min (ms)", "Max (ms)", "Total (ms)", "Ops/sec"];
	const metricWidths = [10, 10, 10, 11, 12];
	const nameWidth = Math.max(24, terminalWidth - metricWidths.reduce((sum, width) => sum + width, 0) - separators);
	const tableWidth = nameWidth + metricWidths.reduce((sum, width) => sum + width, 0) + separators;

	const truncate = (text, width) => {
		const value = String(text);
		if (value.length <= width) return value;
		if (width <= 3) return value.slice(0, width);
		return value.slice(0, width - 3) + "...";
	};

	const formatLeft = (text, width) => truncate(text, width).padEnd(width);
	const formatRight = (text, width) => truncate(text, width).padStart(width);

	console.log("\n" + "=".repeat(tableWidth));
	console.log("Utils Benchmark Results");
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

function benchmarkNormalizeSQLMemory(name, sql, iterations) {
	if (global.gc) global.gc();

	for (let i = 0; i < 3; i++) normalizeSQL(sql);

	if (global.gc) global.gc();
	const before = process.memoryUsage();
	let peakHeap = before.heapUsed;

	const start = performance.now();
	let checksum = 0;
	for (let i = 0; i < iterations; i++) {
		const out = normalizeSQL(sql);
		checksum += out.length;
		const heapNow = process.memoryUsage().heapUsed;
		if (heapNow > peakHeap) peakHeap = heapNow;
	}
	const totalTime = performance.now() - start;

	if (global.gc) global.gc();
	const after = process.memoryUsage();

	return {
		name,
		inputSize: sql.length,
		iterations,
		totalTime: totalTime.toFixed(3),
		avgTime: (totalTime / iterations).toFixed(6),
		heapBefore: before.heapUsed,
		heapPeak: peakHeap,
		heapAfter: after.heapUsed,
		checksum,
	};
}

async function main() {
	const results = [];

	console.log("Starting utils benchmarks...\n");

	// escapeValue benchmarks
	results.push(
		await benchmarkWorkload(`escapeValue string (${ITERATIONS})`, ITERATIONS, async () => {
			for (let i = 0; i < ITERATIONS; i++) {
				escapeValue("hello world");
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`escapeValue string with quotes (${ITERATIONS})`, ITERATIONS, async () => {
			for (let i = 0; i < ITERATIONS; i++) {
				escapeValue("it's a test with 'single' quotes");
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`escapeValue boolean (${ITERATIONS * 2})`, ITERATIONS * 2, async () => {
			for (let i = 0; i < ITERATIONS; i++) {
				escapeValue(true);
				escapeValue(false);
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`escapeValue number (${ITERATIONS})`, ITERATIONS, async () => {
			for (let i = 0; i < ITERATIONS; i++) {
				escapeValue(42);
			}
		}),
	);

	// interpolateSQL benchmarks
	results.push(
		await benchmarkWorkload(`interpolateSQL simple (${ITERATIONS})`, ITERATIONS, async () => {
			for (let i = 0; i < ITERATIONS; i++) {
				interpolateSQL("SELECT * FROM users WHERE id = ?", [42]);
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`interpolateSQL multiple params (${ITERATIONS})`, ITERATIONS, async () => {
			for (let i = 0; i < ITERATIONS; i++) {
				interpolateSQL("INSERT INTO users (name, age, city, active) VALUES (?, ?, ?, ?)", ["Alice", 30, "New York", true]);
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`interpolateSQL no params (${ITERATIONS})`, ITERATIONS, async () => {
			for (let i = 0; i < ITERATIONS; i++) {
				interpolateSQL("SELECT 1", []);
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`interpolateSQL with quoted strings (${ITERATIONS})`, ITERATIONS, async () => {
			for (let i = 0; i < ITERATIONS; i++) {
				interpolateSQL("SELECT * FROM t WHERE name = 'literal?' AND id = ?", [99]);
			}
		}),
	);

	// normalizeSQL benchmarks
	results.push(
		await benchmarkWorkload(`normalizeSQL simple (${ITERATIONS})`, ITERATIONS, async () => {
			for (let i = 0; i < ITERATIONS; i++) {
				normalizeSQL("SELECT * FROM users");
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`normalizeSQL with whitespace (${ITERATIONS})`, ITERATIONS, async () => {
			for (let i = 0; i < ITERATIONS; i++) {
				normalizeSQL("  SELECT   *   FROM   users  WHERE  id = 1  ");
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`normalizeSQL with line comments (${ITERATIONS})`, ITERATIONS, async () => {
			for (let i = 0; i < ITERATIONS; i++) {
				normalizeSQL("SELECT * FROM users -- get all users\nWHERE id = 1");
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`normalizeSQL complex CREATE TABLE (${ITERATIONS / 10})`, ITERATIONS / 10, async () => {
			for (let i = 0; i < ITERATIONS / 10; i++) {
				normalizeSQL(`
					CREATE TABLE IF NOT EXISTS products (
						id INTEGER PRIMARY KEY AUTOINCREMENT, -- primary key
						name TEXT NOT NULL,                   -- product name
						price REAL NOT NULL,                  -- price in USD
						category TEXT,
						created_at TEXT DEFAULT (datetime('now'))
					)
				`);
			}
		}),
	);

	const largeNoComment = createLargeSQL(5 * 1024 * 1024, false);
	const largeWithComment = createLargeSQL(5 * 1024 * 1024, true);
	const xLargeNoComment = createLargeSQL(20 * 1024 * 1024, false);
	const xLargeWithComment = createLargeSQL(20 * 1024 * 1024, true);
	const xxLargeNoComment = createLargeSQL(50 * 1024 * 1024, false);
	const xxLargeWithComment = createLargeSQL(50 * 1024 * 1024, true);
	const memoryResults = [
		benchmarkNormalizeSQLMemory("normalizeSQL large 5MB no-comment", largeNoComment, 12),
		benchmarkNormalizeSQLMemory("normalizeSQL large 5MB with-comment", largeWithComment, 12),
		benchmarkNormalizeSQLMemory("normalizeSQL xlarge 20MB no-comment", xLargeNoComment, 4),
		benchmarkNormalizeSQLMemory("normalizeSQL xlarge 20MB with-comment", xLargeWithComment, 4),
		benchmarkNormalizeSQLMemory("normalizeSQL xxlarge 50MB no-comment", xxLargeNoComment, 2),
		benchmarkNormalizeSQLMemory("normalizeSQL xxlarge 50MB with-comment", xxLargeWithComment, 2),
	];

	displayResults(results);

	console.log("normalizeSQL Large SQL Memory (run with --expose-gc for best stability)");
	console.table(
		memoryResults.map((item) => ({
			Benchmark: item.name,
			Input: formatBytes(item.inputSize),
			Iterations: item.iterations,
			"Avg (ms/op)": item.avgTime,
			"Total (ms)": item.totalTime,
			"Heap Before": formatBytes(item.heapBefore),
			"Heap Peak": formatBytes(item.heapPeak),
			"Heap After": formatBytes(item.heapAfter),
			"Peak Delta": formatBytes(item.heapPeak - item.heapBefore),
			Checksum: item.checksum,
		})),
	);

	console.log("Utils benchmarks completed!");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
