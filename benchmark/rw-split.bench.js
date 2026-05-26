import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import { SQLiteExecutor } from "../src/index.js";
import downloadSQLite3 from "../script/download-sqlite3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.join(__dirname, "..");

const ROW_COUNT = 50000;
const SAMPLES = 10;

async function getSqlite3Path() {
	const p = path.join(root, "bin", "sqlite3" + (process.platform === "win32" ? ".exe" : ""));
	if (fs.existsSync(p)) return p;
	try { await downloadSQLite3(); } catch {}
	return p;
}

function printResults(rows) {
	const w = [36, 14, 14, 14, 16, 14];
	const h = ["Scenario", "Concurrency", "Avg (ms)", "Min (ms)", "Total (ms)", "Ops/sec"];
	const sep = "  ";
	const pad = (c, i) => (i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]));

	const tw = w.reduce((a, b) => a + b, 0) + sep.length * (w.length - 1);
	console.log("\n" + "=".repeat(tw));
	console.log("Read/Write Split Benchmark");
	console.log("=".repeat(tw));
	console.log(h.map((c, i) => pad(c, i)).join(sep));
	console.log("-".repeat(tw));
	for (const r of rows) console.log([r.scenario, r.concurrency, r.avgTime, r.minTime, r.totalTime, r.ops].map((c, i) => pad(c, i)).join(sep));
	console.log("=".repeat(tw) + "\n");
}

async function setupDb(exec) {
	await exec.execute("DROP TABLE IF EXISTS bench");
	await exec.execute(`CREATE TABLE bench (id INTEGER PRIMARY KEY, category INTEGER NOT NULL, score INTEGER NOT NULL)`);
	await exec.execute(`INSERT INTO bench SELECT value, value % 100, (value * 7) % 1000 FROM generate_series(1, ${ROW_COUNT})`);
	await exec.execute("CREATE INDEX IF NOT EXISTS idx_cat ON bench(category)");
	await exec.execute("CREATE INDEX IF NOT EXISTS idx_score ON bench(score)");
}

const READ_QUERIES = [
	"SELECT COUNT(*) AS cnt FROM bench",
	"SELECT id, score FROM bench WHERE category = 42",
	"SELECT id, score FROM bench WHERE score BETWEEN 300 AND 400 ORDER BY score LIMIT 100",
	"SELECT category, COUNT(*) AS total, AVG(score) AS avg_score FROM bench GROUP BY category",
];

async function benchReadOnly(poolSize, sqlite3Path) {
	const dbFile = path.join(__dirname, `bench-ro-${poolSize}.db`);
	try { fs.unlinkSync(dbFile); } catch {}

	const exec = new SQLiteExecutor({ binary: sqlite3Path, database: dbFile, poolSize, statementTimeout: 30000 });
	await setupDb(exec);
	await exec.query("SELECT 1").catch(() => {});

	const results = [];
	for (const concurrency of [1, 2, 4, 8]) {
		// warmup
		for (let w = 0; w < 2; w++) {
			const jobs = [];
			for (let i = 0; i < concurrency; i++) jobs.push(exec.query(READ_QUERIES[i % READ_QUERIES.length]));
			await Promise.all(jobs);
		}

		const times = [];
		for (let s = 0; s < SAMPLES; s++) {
			const jobs = [];
			for (let i = 0; i < concurrency; i++) jobs.push(exec.query(READ_QUERIES[i % READ_QUERIES.length]));
			const start = performance.now();
			await Promise.all(jobs);
			times.push(performance.now() - start);
		}

		const total = times.reduce((a, b) => a + b, 0);
		const avg = total / times.length;
		results.push({ scenario: `Read-only (pool=${poolSize})`, concurrency, avgTime: avg.toFixed(3), minTime: Math.min(...times).toFixed(3), totalTime: total.toFixed(3), ops: ((concurrency * SAMPLES * 1000) / total).toFixed(2) });
	}

	await exec.close();
	try { fs.unlinkSync(dbFile); } catch {}
	return results;
}

async function benchMixed(poolSize, sqlite3Path) {
	const dbFile = path.join(__dirname, `bench-mx-${poolSize}.db`);
	try { fs.unlinkSync(dbFile); } catch {}

	const exec = new SQLiteExecutor({ binary: sqlite3Path, database: dbFile, poolSize, statementTimeout: 30000 });
	await setupDb(exec);
	await exec.query("SELECT 1").catch(() => {});

	let counter = ROW_COUNT + 1;
	const writeSQL = "INSERT INTO bench (id, category, score) VALUES (?, ?, ?)";

	const results = [];
	for (const concurrency of [4, 8]) {
		for (let w = 0; w < 2; w++) {
			const jobs = [];
			for (let i = 0; i < concurrency; i++) {
				if (i % 4 === 0) jobs.push(exec.execute(writeSQL, [counter++, i % 100, counter % 1000]));
				else jobs.push(exec.query(READ_QUERIES[i % READ_QUERIES.length]));
			}
			await Promise.all(jobs);
		}

		const times = [];
		for (let s = 0; s < SAMPLES; s++) {
			const jobs = [];
			for (let i = 0; i < concurrency; i++) {
				if (i % 4 === 0) jobs.push(exec.execute(writeSQL, [counter++, i % 100, counter % 1000]));
				else jobs.push(exec.query(READ_QUERIES[i % READ_QUERIES.length]));
			}
			const start = performance.now();
			await Promise.all(jobs);
			times.push(performance.now() - start);
		}

		const total = times.reduce((a, b) => a + b, 0);
		const avg = total / times.length;
		const opsPerBatch = concurrency;
		results.push({ scenario: `Mixed r+w (pool=${poolSize})`, concurrency, avgTime: avg.toFixed(3), minTime: Math.min(...times).toFixed(3), totalTime: total.toFixed(3), ops: ((opsPerBatch * SAMPLES * 1000) / total).toFixed(2) });
	}

	await exec.close();
	try { fs.unlinkSync(dbFile); } catch {}
	return results;
}

async function main() {
	const sqlite3Path = await getSqlite3Path();
	console.log(`SQLite3: ${sqlite3Path}   Dataset: ${ROW_COUNT} rows`);

	const all = [];
	all.push(...await benchReadOnly(0, sqlite3Path));
	all.push(...await benchReadOnly(4, sqlite3Path));
	all.push(...await benchMixed(0, sqlite3Path));
	all.push(...await benchMixed(4, sqlite3Path));

	printResults(all);
}

main().catch(console.error);
