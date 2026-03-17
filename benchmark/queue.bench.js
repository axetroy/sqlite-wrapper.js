import { performance } from "node:perf_hooks";

import { Queue } from "../src/queue.js";

const PURE_QUEUE_COUNT = 500000;
const MIXED_OPERATION_PAIRS = 250000;
const COMPARISON_COUNT = 100000;
const FIND_QUEUE_SIZE = 100000;
const FIND_ITERATIONS = 1000;

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
	const metricWidths = [10, 10, 10, 11, 10];
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
	console.log("Queue Benchmark Results");
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

	console.log("Starting queue benchmarks...\n");

	results.push(
		await benchmarkWorkload(`Queue Enqueue Only (${PURE_QUEUE_COUNT})`, PURE_QUEUE_COUNT, async () => {
			const queue = new Queue();
			for (let i = 0; i < PURE_QUEUE_COUNT; i++) {
				queue.enqueue(i);
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`Queue Dequeue Only (${PURE_QUEUE_COUNT})`, PURE_QUEUE_COUNT, async () => {
			const queue = new Queue();
			for (let i = 0; i < PURE_QUEUE_COUNT; i++) {
				queue.enqueue(i);
			}

			for (let i = 0; i < PURE_QUEUE_COUNT; i++) {
				queue.dequeue();
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`Queue Steady-State FIFO (${MIXED_OPERATION_PAIRS * 2} ops)`, MIXED_OPERATION_PAIRS * 2, async () => {
			const queue = new Queue();

			for (let i = 0; i < 1024; i++) {
				queue.enqueue(i);
			}

			for (let i = 0; i < MIXED_OPERATION_PAIRS; i++) {
				queue.enqueue(i);
				queue.dequeue();
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`Queue Find Tail (${FIND_ITERATIONS} scans / ${FIND_QUEUE_SIZE} items)`, FIND_ITERATIONS, async () => {
			const queue = new Queue();
			for (let i = 0; i < FIND_QUEUE_SIZE; i++) {
				queue.enqueue({ id: i });
			}

			for (let i = 0; i < FIND_ITERATIONS; i++) {
				const item = queue.find((value) => value.id === FIND_QUEUE_SIZE - 1);
				if (!item) throw new Error("Expected to find queue tail item");
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`Queue FIFO Digest (${COMPARISON_COUNT} items)`, COMPARISON_COUNT * 2, async () => {
			const queue = new Queue();
			for (let i = 0; i < COMPARISON_COUNT; i++) {
				queue.enqueue(i);
			}

			for (let i = 0; i < COMPARISON_COUNT; i++) {
				queue.dequeue();
			}
		}),
	);

	results.push(
		await benchmarkWorkload(`Array push/shift Digest (${COMPARISON_COUNT} items)`, COMPARISON_COUNT * 2, async () => {
			const queue = [];
			for (let i = 0; i < COMPARISON_COUNT; i++) {
				queue.push(i);
			}

			for (let i = 0; i < COMPARISON_COUNT; i++) {
				queue.shift();
			}
		}),
	);

	displayResults(results);
	console.log("Queue benchmarks completed!");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});