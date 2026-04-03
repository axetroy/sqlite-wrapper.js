import { performance } from "node:perf_hooks";

import { escapeValue, interpolateSQL } from "../src/index.js";
import { normalizeSQL } from "../src/utils.js";

const ITERATIONS = 200000;

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
				interpolateSQL(
					"INSERT INTO users (name, age, city, active) VALUES (?, ?, ?, ?)",
					["Alice", 30, "New York", true],
				);
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

	// normalizeSQL batch benchmarks: simulate normalizing thousands of *distinct* SQL
	// strings, which exercises real-world GC pressure from unique string allocations.
	const BATCH_SIZES = [1000, 5000];
	for (const batchSize of BATCH_SIZES) {
		// Build a diverse set of SQL strings upfront so V8 cannot optimize them away
		// as a single repeated constant.
		const sqlStatements = Array.from({ length: batchSize }, (_, idx) => {
			const mod = idx % 6;
			if (mod === 0) return `SELECT * FROM users WHERE id = ${idx}`;
			if (mod === 1) return `  SELECT   name,  email  FROM   users  WHERE  age > ${idx}  `;
			if (mod === 2) return `INSERT INTO logs (user_id, action) VALUES (${idx}, 'login') -- auto-generated`;
			if (mod === 3) return `UPDATE users SET last_seen = datetime('now') WHERE id = ${idx}; -- update ts`;
			if (mod === 4) return `DELETE FROM sessions WHERE user_id = ${idx} AND expires_at < datetime('now')`;
			return `SELECT u.id, u.name, p.bio\n  FROM users u\n  JOIN profiles p ON p.user_id = u.id -- join\n WHERE u.id = ${idx}`;
		});

		results.push(
			await benchmarkWorkload(`normalizeSQL batch ${batchSize} distinct SQLs`, batchSize, async () => {
				for (let i = 0; i < batchSize; i++) {
					normalizeSQL(sqlStatements[i]);
				}
			}),
		);

		// Repeat the batch several times so the measurement is stable and GC runs
		// are more likely to occur within the timed window.
		const BATCH_REPEATS = 10;
		results.push(
			await benchmarkWorkload(
				`normalizeSQL batch ${batchSize} distinct SQLs ×${BATCH_REPEATS} (GC pressure)`,
				batchSize * BATCH_REPEATS,
				async () => {
					for (let r = 0; r < BATCH_REPEATS; r++) {
						for (let i = 0; i < batchSize; i++) {
							normalizeSQL(sqlStatements[i]);
						}
					}
				},
			),
		);
	}

	displayResults(results);
	console.log("Utils benchmarks completed!");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
