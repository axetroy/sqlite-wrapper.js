# Benchmarks

This directory contains benchmark tests for the SQLite Wrapper library.

## Running Benchmarks

To run the benchmarks, use the following command from the project root:

```bash
npm run benchmark
```

## What is Benchmarked

The benchmark suite tests the following operations:

1. **Table Creation** - Creating new tables
2. **Single Row Insert** - Inserting individual rows
3. **Bulk Insert** - Inserting 100 rows
4. **Simple SELECT** - Querying 1000 rows without filters
5. **SELECT with WHERE** - Querying with filtering conditions
6. **UPDATE** - Updating individual rows
7. **DELETE** - Deleting individual rows
8. **JOIN Query** - Complex JOIN operations between two tables
9. **Transaction Simulation** - Multiple insert operations in sequence

## Understanding Results

The benchmark results display the following metrics for each operation:

- **Avg (ms)**: Average execution time in milliseconds
- **Min (ms)**: Minimum execution time
- **Max (ms)**: Maximum execution time
- **Ops/sec**: Operations per second (throughput)

## Customizing Benchmarks

You can modify the benchmarks in `index.bench.js`:

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
Table Creation                                1.346      1.052      2.464     743.11
Single Row Insert                             0.900      0.686      5.135    1110.99
Bulk Insert (100 rows)                       89.976     79.385    100.598      11.11
Simple SELECT (1000 rows)                     1.390      1.252      1.865     719.34
SELECT with WHERE clause                      0.975      0.713      1.095    1025.85
UPDATE Single Row                             0.839      0.648      6.727    1192.09
DELETE Single Row                             0.836      0.618      5.197    1196.73
JOIN Query (1000 orders, 100 customers)       1.576      1.524      1.833     634.53
Transaction Simulation (5 inserts)            4.248      3.688      5.604     235.42
================================================================================
```
