import { performance } from "node:perf_hooks";

const DATASET_COUNT = 3;
const ITERATIONS = 120;

/**
 * @typedef {{
 *  name: string;
 *  chunks: string[];
 *  expectedStdout: string;
 *  expectedStderr: string;
 * }} Dataset
 */

/**
 * Build synthetic stream chunks that emulate sqlite stdout/stderr line framing.
 * The line feed is intentionally fragmented by chunk boundaries to stress parser overhead.
 * @param {number} totalLines
 * @param {number} lineChars
 * @param {number} chunkChars
 * @param {number} stderrEvery
 * @returns {Dataset}
 */
function buildDataset(totalLines, lineChars, chunkChars, stderrEvery) {
	const lines = [];
	for (let i = 1; i <= totalLines; i++) {
		const payload = `row:${i};` + "x".repeat(Math.max(0, lineChars - String(i).length - 5));
		if (i % stderrEvery === 0) {
			lines.push(`ERR ${payload}`);
		} else {
			lines.push(payload);
		}
	}

	const source = lines.join("\n") + "\n";
	const chunks = [];
	for (let i = 0; i < source.length; i += chunkChars) {
		chunks.push(source.slice(i, i + chunkChars));
	}

	const stdoutLines = [];
	const stderrLines = [];
	for (const line of lines) {
		if (line.startsWith("ERR ")) stderrLines.push(line.slice(4));
		else stdoutLines.push(line);
	}

	return {
		name: `${totalLines} lines / ${lineChars} chars / chunk ${chunkChars}`,
		chunks,
		expectedStdout: stdoutLines.join("\n"),
		expectedStderr: stderrLines.join("\n"),
	};
}

/**
 * Parse chunked lines and accumulate output using string concatenation.
 * This mirrors current sqlite-wrapper data-path design.
 * @param {string[]} chunks
 */
function parseWithString(chunks) {
	let remainder = "";
	let stdout = "";
	let stderr = "";

	for (const chunk of chunks) {
		remainder += chunk;

		let lineStart = 0;
		let lineEnd = remainder.indexOf("\n", lineStart);
		while (lineEnd !== -1) {
			const raw = remainder.slice(lineStart, lineEnd);
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

			if (line.startsWith("ERR ")) {
				const v = line.slice(4).trim();
				if (v) {
					if (stderr.length > 0) stderr += "\n";
					stderr += v;
				}
			} else {
				if (stdout.length > 0) stdout += "\n";
				stdout += line;
			}

			lineStart = lineEnd + 1;
			lineEnd = remainder.indexOf("\n", lineStart);
		}

		remainder = remainder.slice(lineStart);
	}

	const tail = remainder.trim();
	if (tail) {
		if (tail.startsWith("ERR ")) {
			const v = tail.slice(4).trim();
			if (v) {
				if (stderr.length > 0) stderr += "\n";
				stderr += v;
			}
		} else {
			if (stdout.length > 0) stdout += "\n";
			stdout += tail;
		}
	}

	return { stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Parse chunked lines and accumulate output as Buffer segments.
 * @param {string[]} chunks
 */
function parseWithBuffer(chunks) {
	let remainder = "";
	const stdout = [];
	const stderr = [];

	for (const chunk of chunks) {
		remainder += chunk;

		let lineStart = 0;
		let lineEnd = remainder.indexOf("\n", lineStart);
		while (lineEnd !== -1) {
			const raw = remainder.slice(lineStart, lineEnd);
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

			if (line.startsWith("ERR ")) {
				const v = line.slice(4).trim();
				if (v) stderr.push(Buffer.from(v));
			} else {
				stdout.push(Buffer.from(line));
			}

			lineStart = lineEnd + 1;
			lineEnd = remainder.indexOf("\n", lineStart);
		}

		remainder = remainder.slice(lineStart);
	}

	const tail = remainder.trim();
	if (tail) {
		if (tail.startsWith("ERR ")) {
			const v = tail.slice(4).trim();
			if (v) stderr.push(Buffer.from(v));
		} else {
			stdout.push(Buffer.from(tail));
		}
	}

	const out = stdout.length > 0 ? Buffer.concat(joinBufferLines(stdout)).toString("utf8") : "";
	const err = stderr.length > 0 ? Buffer.concat(joinBufferLines(stderr)).toString("utf8") : "";
	return { stdout: out.trim(), stderr: err.trim() };
}

/**
 * Parse chunked lines and accumulate output as Uint8Array segments.
 * @param {string[]} chunks
 */
function parseWithUint8Array(chunks) {
	let remainder = "";
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const stdout = [];
	const stderr = [];

	for (const chunk of chunks) {
		remainder += chunk;

		let lineStart = 0;
		let lineEnd = remainder.indexOf("\n", lineStart);
		while (lineEnd !== -1) {
			const raw = remainder.slice(lineStart, lineEnd);
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

			if (line.startsWith("ERR ")) {
				const v = line.slice(4).trim();
				if (v) stderr.push(encoder.encode(v));
			} else {
				stdout.push(encoder.encode(line));
			}

			lineStart = lineEnd + 1;
			lineEnd = remainder.indexOf("\n", lineStart);
		}

		remainder = remainder.slice(lineStart);
	}

	const tail = remainder.trim();
	if (tail) {
		if (tail.startsWith("ERR ")) {
			const v = tail.slice(4).trim();
			if (v) stderr.push(encoder.encode(v));
		} else {
			stdout.push(encoder.encode(tail));
		}
	}

	const out = stdout.length > 0 ? decoder.decode(joinUint8Lines(stdout)) : "";
	const err = stderr.length > 0 ? decoder.decode(joinUint8Lines(stderr)) : "";
	return { stdout: out.trim(), stderr: err.trim() };
}

/**
 * @param {Buffer[]} lines
 */
function joinBufferLines(lines) {
	if (lines.length === 1) return lines;
	const parts = [];
	for (let i = 0; i < lines.length; i++) {
		parts.push(lines[i]);
		if (i < lines.length - 1) parts.push(Buffer.from("\n"));
	}
	return parts;
}

/**
 * @param {Uint8Array[]} lines
 */
function joinUint8Lines(lines) {
	if (lines.length === 1) return lines[0];
	const newline = 10; // '\n'
	let total = 0;
	for (const line of lines) total += line.length;
	total += lines.length - 1;

	const out = new Uint8Array(total);
	let pos = 0;
	for (let i = 0; i < lines.length; i++) {
		out.set(lines[i], pos);
		pos += lines[i].length;
		if (i < lines.length - 1) out[pos++] = newline;
	}
	return out;
}

/**
 * @param {Dataset} dataset
 * @param {string} strategyName
 * @param {(chunks: string[]) => {stdout: string, stderr: string}} runner
 */
function runBenchmark(dataset, strategyName, runner) {
	for (let i = 0; i < 8; i++) runner(dataset.chunks);

	if (global.gc) global.gc();
	const before = process.memoryUsage();
	let peak = before.heapUsed;
	let checksum = 0;

	const start = performance.now();
	for (let i = 0; i < ITERATIONS; i++) {
		const { stdout, stderr } = runner(dataset.chunks);
		if (stdout !== dataset.expectedStdout || stderr !== dataset.expectedStderr) {
			throw new Error(`${strategyName} failed verification on dataset: ${dataset.name}`);
		}
		checksum += stdout.length + stderr.length;
		const heap = process.memoryUsage().heapUsed;
		if (heap > peak) peak = heap;
	}
	const total = performance.now() - start;

	if (global.gc) global.gc();
	const after = process.memoryUsage();

	return {
		dataset: dataset.name,
		strategy: strategyName,
		iterations: ITERATIONS,
		avgMs: (total / ITERATIONS).toFixed(4),
		totalMs: total.toFixed(2),
		heapBefore: before.heapUsed,
		heapPeak: peak,
		heapAfter: after.heapUsed,
		peakDelta: peak - before.heapUsed,
		checksum,
	};
}

function formatBytes(bytes) {
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value.toFixed(2)} ${units[i]}`;
}

function main() {
	console.log("\nProcess Stream Strategy Benchmark");
	console.log("Comparing String vs Buffer vs Uint8Array for high-volume chunk parsing\n");

	const datasets = [
		buildDataset(10_000, 120, 256, 17),
		buildDataset(40_000, 140, 512, 19),
		buildDataset(80_000, 160, 1024, 23),
	].slice(0, DATASET_COUNT);

	const all = [];
	for (const dataset of datasets) {
		all.push(runBenchmark(dataset, "string", parseWithString));
		all.push(runBenchmark(dataset, "buffer", parseWithBuffer));
		all.push(runBenchmark(dataset, "uint8array", parseWithUint8Array));
	}

	console.table(
		all.map((x) => ({
			dataset: x.dataset,
			strategy: x.strategy,
			iterations: x.iterations,
			"avg(ms/op)": x.avgMs,
			"total(ms)": x.totalMs,
			"heap before": formatBytes(x.heapBefore),
			"heap peak": formatBytes(x.heapPeak),
			"heap after": formatBytes(x.heapAfter),
			"peak delta": formatBytes(x.peakDelta),
			checksum: x.checksum,
		})),
	);

	if (!global.gc) {
		console.log("\nTip: use `node --expose-gc benchmark/process-stream.bench.js` for stabler memory numbers.");
	}
}

main();
