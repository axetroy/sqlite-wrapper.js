import { performance } from "node:perf_hooks";

const ITERATIONS = 180;
const CHAR_LF = 10;
const CHAR_CR = 13;
const CHAR_SPACE = 32;
const CHAR_TAB = 9;

/**
 * @typedef {{
 *  name: string;
 *  chunks: string[];
 *  expectedStdout: string;
 *  expectedStderr: string;
 * }} Dataset
 */

/**
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
 * Legacy handler style (indexOf + line.trim()).
 * @param {string[]} chunks
 */
function parseLegacyString(chunks) {
	let stdoutChunkRemainder = "";
	let stderrChunkRemainder = "";
	let stdoutResult = "";
	let stderrResult = "";

	for (const chunk of chunks) {
		stdoutChunkRemainder += chunk;

		let lineStart = 0;
		let lineEnd = stdoutChunkRemainder.indexOf("\n", lineStart);
		while (lineEnd !== -1) {
			let line = stdoutChunkRemainder.slice(lineStart, lineEnd);
			if (line.endsWith("\r")) line = line.slice(0, -1);

			if (line.startsWith("ERR ")) {
				const err = line.slice(4);
				stderrChunkRemainder += err + "\n";
			} else {
				if (stdoutResult.length > 0) stdoutResult += "\n";
				stdoutResult += line;
			}

			lineStart = lineEnd + 1;
			lineEnd = stdoutChunkRemainder.indexOf("\n", lineStart);
		}

		stdoutChunkRemainder = stdoutChunkRemainder.slice(lineStart);
	}

	if (stderrChunkRemainder.length > 0) {
		let lineStart = 0;
		let lineEnd = stderrChunkRemainder.indexOf("\n", lineStart);
		while (lineEnd !== -1) {
			let line = stderrChunkRemainder.slice(lineStart, lineEnd);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			const normalized = line.trim();
			if (normalized) {
				if (stderrResult.length > 0) stderrResult += "\n";
				stderrResult += normalized;
			}
			lineStart = lineEnd + 1;
			lineEnd = stderrChunkRemainder.indexOf("\n", lineStart);
		}

		const tail = stderrChunkRemainder.slice(lineStart).trim();
		if (tail) {
			if (stderrResult.length > 0) stderrResult += "\n";
			stderrResult += tail;
		}
	}

	const tailOut = stdoutChunkRemainder.trim();
	if (tailOut) {
		if (stdoutResult.length > 0) stdoutResult += "\n";
		stdoutResult += tailOut;
	}

	return {
		stdout: stdoutResult.trim(),
		stderr: stderrResult.trim(),
	};
}

/**
 * Current optimized style (single-pass char scan + index-based stderr trim ranges).
 * @param {string[]} chunks
 */
function parseOptimizedString(chunks) {
	let stdoutChunkRemainder = "";
	let stderrChunkRemainder = "";
	let stdoutResult = "";
	let stderrResult = "";

	for (const chunk of chunks) {
		let remainder = stdoutChunkRemainder;
		remainder += chunk;

		let lineStart = 0;
		for (let i = 0; i < remainder.length; i++) {
			if (remainder.charCodeAt(i) !== CHAR_LF) continue;

			let endExclusive = i;
			if (endExclusive > lineStart && remainder.charCodeAt(endExclusive - 1) === CHAR_CR) endExclusive--;

			const line = remainder.slice(lineStart, endExclusive);
			if (line.startsWith("ERR ")) {
				if (stderrChunkRemainder.length > 0) stderrChunkRemainder += "\n";
				stderrChunkRemainder += line.slice(4);
			} else {
				if (stdoutResult.length > 0) stdoutResult += "\n";
				stdoutResult += line;
			}
			lineStart = i + 1;
		}

		stdoutChunkRemainder = remainder.slice(lineStart);
	}

	if (stderrChunkRemainder.length > 0) {
		let remainder = stderrChunkRemainder;
		let lineStart = 0;
		for (let i = 0; i < remainder.length; i++) {
			if (remainder.charCodeAt(i) !== CHAR_LF) continue;

			let endExclusive = i;
			if (endExclusive > lineStart && remainder.charCodeAt(endExclusive - 1) === CHAR_CR) endExclusive--;

			let s = lineStart;
			let e = endExclusive;
			while (s < e) {
				const code = remainder.charCodeAt(s);
				if (code !== CHAR_SPACE && code !== CHAR_TAB && code !== CHAR_LF && code !== CHAR_CR) break;
				s++;
			}
			while (e > s) {
				const code = remainder.charCodeAt(e - 1);
				if (code !== CHAR_SPACE && code !== CHAR_TAB && code !== CHAR_LF && code !== CHAR_CR) break;
				e--;
			}

			if (s < e) {
				if (stderrResult.length > 0) stderrResult += "\n";
				stderrResult += remainder.slice(s, e);
			}

			lineStart = i + 1;
		}

		let s = lineStart;
		let e = remainder.length;
		while (s < e) {
			const code = remainder.charCodeAt(s);
			if (code !== CHAR_SPACE && code !== CHAR_TAB && code !== CHAR_LF && code !== CHAR_CR) break;
			s++;
		}
		while (e > s) {
			const code = remainder.charCodeAt(e - 1);
			if (code !== CHAR_SPACE && code !== CHAR_TAB && code !== CHAR_LF && code !== CHAR_CR) break;
			e--;
		}
		if (s < e) {
			if (stderrResult.length > 0) stderrResult += "\n";
			stderrResult += remainder.slice(s, e);
		}
	}

	const tailOut = stdoutChunkRemainder.trim();
	if (tailOut) {
		if (stdoutResult.length > 0) stdoutResult += "\n";
		stdoutResult += tailOut;
	}

	return {
		stdout: stdoutResult.trim(),
		stderr: stderrResult.trim(),
	};
}

/**
 * @param {Dataset} dataset
 * @param {string} name
 * @param {(chunks: string[]) => {stdout: string, stderr: string}} runner
 */
function bench(dataset, name, runner) {
	for (let i = 0; i < 10; i++) runner(dataset.chunks);

	if (global.gc) global.gc();
	const before = process.memoryUsage();
	let peak = before.heapUsed;
	let checksum = 0;

	const t0 = performance.now();
	for (let i = 0; i < ITERATIONS; i++) {
		const out = runner(dataset.chunks);
		if (out.stdout !== dataset.expectedStdout || out.stderr !== dataset.expectedStderr) {
			throw new Error(`${name} verification failed on ${dataset.name}`);
		}
		checksum += out.stdout.length + out.stderr.length;
		const heap = process.memoryUsage().heapUsed;
		if (heap > peak) peak = heap;
	}
	const total = performance.now() - t0;

	if (global.gc) global.gc();
	const after = process.memoryUsage();

	return {
		dataset: dataset.name,
		strategy: name,
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
	console.log("\nStream Handler Compare Benchmark");
	console.log("Comparing legacy line handling vs optimized handlers\n");

	const datasets = [
		buildDataset(10_000, 120, 256, 17),
		buildDataset(40_000, 140, 512, 19),
		buildDataset(80_000, 160, 1024, 23),
	];

	const results = [];
	for (const dataset of datasets) {
		results.push(bench(dataset, "legacy", parseLegacyString));
		results.push(bench(dataset, "optimized", parseOptimizedString));
	}

	console.table(
		results.map((x) => ({
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
		console.log("\nTip: use node --expose-gc for more stable memory numbers.");
	}
}

main();
