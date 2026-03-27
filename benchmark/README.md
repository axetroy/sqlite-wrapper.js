# Benchmarks

This directory contains benchmark tests for the SQLite Wrapper library.

## Running Benchmarks

To run the benchmarks, use the following command from the project root:

```bash
npm run benchmark
```

To run the standalone queue benchmark, use:

```bash
npm run benchmark:queue
```

To run the utils benchmark (escapeValue, interpolateSQL, normalizeSQL), use:

```bash
npm run benchmark:utils
```

## What is Benchmarked

The SQLite benchmark suite tests the following operations:

1. **Table Creation** - Creating new tables
2. **Single Row Insert** - Inserting individual rows
3. **Bulk Insert** - Inserting 100 rows
4. **Simple SELECT** - Querying 1000 rows without filters
5. **SELECT with WHERE** - Querying with filtering conditions
6. **UPDATE** - Updating individual rows
7. **DELETE** - Deleting individual rows
8. **JOIN Query** - Complex JOIN operations between two tables
9. **Transaction Simulation** - Multiple insert operations in sequence
10. **100k Row Dataset** - Point query, range query, aggregate query, and updates on a 100k-row table
11. **100k Simple Commands** - End-to-end time to execute 100000 simple SQL statements sequentially
12. **100k Sequential INSERT** - End-to-end time to execute 100000 INSERT statements sequentially
13. **100k Sequential UPDATE** - End-to-end time to execute 100000 UPDATE statements sequentially against a preloaded table
14. **20k Burst Enqueue INSERT** - End-to-end time to enqueue 20000 INSERT statements at once with `Promise.all`, then wait for full queue digestion
15. **20k Sequential Enqueue INSERT** - End-to-end time to enqueue 20000 INSERT statements one-by-one using `await` loop
16. **20k Chunked Enqueue INSERT** - End-to-end time to enqueue 20000 INSERT statements in chunks (1000 per chunk) with `Promise.all`
17. **20k Burst Enqueue UPDATE** - End-to-end time to enqueue 20000 UPDATE statements at once with `Promise.all`, then wait for full queue digestion

The standalone queue benchmark covers these in-memory workloads:

1. **Queue Enqueue Only** - Measuring raw enqueue throughput
2. **Queue Dequeue Only** - Measuring raw dequeue throughput after preloading the queue
3. **Queue Steady-State FIFO** - Alternating enqueue/dequeue in a steady-state workload
4. **Queue Find Tail** - Repeatedly scanning the queue to find the last item
5. **Queue FIFO Digest** - End-to-end enqueue + dequeue workload for the custom queue
6. **Array push/shift Digest** - Baseline comparison against a native array used as a FIFO queue

The standalone utils benchmark covers these pure-JS workloads:

1. **escapeValue string** - Escaping a plain string value
2. **escapeValue string with quotes** - Escaping a string containing single quotes
3. **escapeValue boolean** - Escaping boolean true/false
4. **escapeValue number** - Escaping a numeric value
5. **interpolateSQL simple** - Single-placeholder interpolation
6. **interpolateSQL multiple params** - Four-placeholder interpolation with mixed types
7. **interpolateSQL no params** - Fast path for SQL without placeholders
8. **interpolateSQL with quoted strings** - Interpolation where a literal `?` inside quotes is skipped
9. **normalizeSQL simple** - No-op normalization of a plain SELECT
10. **normalizeSQL with whitespace** - Collapsing excess whitespace
11. **normalizeSQL with line comments** - Stripping a trailing line comment
12. **normalizeSQL complex CREATE TABLE** - Multi-line CREATE TABLE with several inline comments

## Understanding Results

The benchmark results display the following metrics for each operation:

- **Avg (ms)**: Average execution time in milliseconds
- **Min (ms)**: Minimum execution time
- **Max (ms)**: Maximum execution time
- **Total (ms)**: Total execution time for the measured run
- **Ops/sec**: Operations per second (throughput)

For fixed-workload scenarios (including the queue benchmark, 100k scenarios, and 20k enqueue strategy comparisons), the benchmark is a single fixed workload rather than repeated sampling. In those rows:

- **Total (ms)** is the full time to digest 100000 commands
- **Avg (ms)** is the average time per command
- **Min (ms)** and **Max (ms)** are not applicable and will display as `-`

## Customizing Benchmarks

You can modify the SQLite benchmarks in `index.bench.js` and the queue benchmarks in `queue.bench.js`:

- Change the number of iterations for each benchmark
- Add new benchmark cases
- Modify test data sizes
- Adjust warmup iterations

## Example Output

```
================================================================================
SQLite Wrapper Benchmark Results
================================================================================
Benchmark                                  Avg (ms)   Min (ms)   Max (ms)    Ops/sec
--------------------------------------------------------------------------------
Benchmark                                  Avg (ms)   Min (ms)   Max (ms)   Total (ms)    Ops/sec
--------------------------------------------------------------------------------
Table Creation                                1.346      1.052      2.464       67.300     743.11
Single Row Insert                             0.900      0.686      5.135      900.000    1110.99
Bulk Insert (100 rows with transaction)      89.976     79.385    100.598      899.760      11.11
Simple SELECT (1000 rows)                     1.390      1.252      1.865      139.000     719.34
SELECT with WHERE clause                      0.975      0.713      1.095       97.500    1025.85
UPDATE Single Row                             0.839      0.648      6.727      419.500    1192.09
DELETE Single Row                             0.836      0.618      5.197      418.000    1196.73
JOIN Query (1000 orders, 100 customers)       1.576      1.524      1.833       78.800     634.53
Transaction (5 inserts)                       4.248      3.688      5.604      424.800     235.42
100k Simple Commands (SELECT 1)            0.016120          -          -     1611.959   62036.33
100k Sequential INSERT                     0.028500          -          -     2850.000   35087.72
100k Sequential UPDATE                     0.031200          -          -     3120.000   32051.28
================================================================================
```
