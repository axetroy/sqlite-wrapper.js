# sqlite-wrapper.js

[![Badge](https://img.shields.io/badge/link-996.icu-%23FF4D5B.svg?style=flat-square)](https://996.icu/#/en_US)
[![LICENSE](https://img.shields.io/badge/license-Anti%20996-blue.svg?style=flat-square)](https://github.com/996icu/996.ICU/blob/master/LICENSE)
![Node](https://img.shields.io/badge/node-%3E=18-blue.svg?style=flat-square)
[![npm version](https://badge.fury.io/js/sqlite-wrapper.js.svg)](https://badge.fury.io/js/sqlite-wrapper.js)
![CI](https://github.com/axetroy/sqlite-wrapper.js/actions/workflows/build.yml/badge.svg)

A lightweight wrapper for SQLite3 with a focus on simplicity and ease of use.

It uses the SQLite3 executable file for database operations and it's **zero-dependencies**.

## Features

- 🚀 **Zero dependencies** - No native bindings required
- 📦 **Uses SQLite3 CLI** - Works with the SQLite3 command-line executable
- 🔒 **Automatic SQL escaping** - Built-in parameter escaping to prevent SQL injection
- 📝 **TypeScript support** - Full TypeScript type definitions included
- 🔄 **Promise-based API** - Modern async/await interface
- 📦 **Dual module support** - Works with both ESM and CommonJS

## Requirements

- Node.js >= 18 (tested on Node.js 22)
- SQLite3 executable installed on your system

## Installation

```bash
npm install sqlite-wrapper.js --save
```

or using yarn:

```bash
yarn add sqlite-wrapper.js
```

## Quick Start

```js
import { SQLiteWrapper } from "sqlite-wrapper.js";

// Initialize the sqlite process
const sqlite = new SQLiteWrapper("/path/to/sqlite3", { dbPath: "/path/to/database.db" });

// Create a table
await sqlite.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)");

// Insert data
await sqlite.exec("INSERT INTO users (name) VALUES (?)", ["Alice"]);
await sqlite.exec("INSERT INTO users (name) VALUES (?)", ["Bob"]);

// Query data
const result = await sqlite.query("SELECT * FROM users");
console.log(result); // Output: [ { id: 1, name: 'Alice' }, { id: 2, name: 'Bob' } ]

// Update data
await sqlite.exec("UPDATE users SET name = ? WHERE id = ?", ["Charlie", 1]);
const results = await sqlite.query("SELECT * FROM users WHERE id = ?", [1]);
console.log(results); // Output: [ { id: 1, name: 'Charlie' } ]

// Update with affected row count
const { changes } = await sqlite.run("UPDATE users SET name = ? WHERE id = ?", ["Dave", 1]);
console.log(changes); // Output: 1

// Close the SQLite3 process
await sqlite.close();
```

## API Reference

### `SQLiteWrapper`

The main class for interacting with SQLite databases.

#### Constructor

```js
new SQLiteWrapper(exePath, options?)
```

| Parameter          | Type               | Description                                                                                 |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------- |
| `exePath`          | `string`           | Path to the SQLite3 executable                                                              |
| `options.dbPath`   | `string`           | (Optional) Path to the SQLite database file. If not provided, an in-memory database is used |
| `options.logger`   | `Logger`           | (Optional) Logger instance for debugging                                                    |
| `options.onTiming` | `(timing) => void` | (Optional) Per-SQL timing callback for queue/run/total metrics                              |
| `options.maxInFlight` | `number`        | (Optional, default `128`) Max inflight statements per dispatch cycle                        |
| `options.maxBatchChars` | `number`      | (Optional, default `131072`) Max SQL payload size per process write                         |

#### Methods

##### `get pendingQueries()`

Returns the number of pending SQL queries in the queue.

##### `exec(sql, params?)`

Executes a SQL statement without returning results. Use for `CREATE`, `INSERT`, `UPDATE`, `DELETE` operations when you don't need execution metadata.

```js
await sqlite.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
await sqlite.exec("INSERT INTO users (name) VALUES (?)", ["Alice"]);
```

| Parameter | Type     | Description                                              |
| --------- | -------- | -------------------------------------------------------- |
| `sql`     | `string` | SQL statement to execute                                 |
| `params`  | `any[]`  | (Optional) Parameters to substitute for `?` placeholders |

##### `run(sql, params?)`

Executes a write SQL statement and returns execution metadata. Use for `INSERT`, `UPDATE`, or `DELETE` when you need to know how many rows were affected or the rowid of the inserted row.

```js
const { changes, lastInsertRowid } = await sqlite.run("INSERT INTO users (name) VALUES (?)", ["Alice"]);
console.log(changes);        // 1
console.log(lastInsertRowid); // 1 (the new row's rowid)

const { changes: updated } = await sqlite.run("UPDATE users SET name = ? WHERE id = ?", ["Bob", 1]);
console.log(updated); // 1
```

| Parameter      | Type                                            | Description                                              |
| -------------- | ----------------------------------------------- | -------------------------------------------------------- |
| `sql`          | `string`                                        | SQL statement to execute                                 |
| `params`       | `any[]`                                         | (Optional) Parameters to substitute for `?` placeholders |
| **Returns**    | `Promise<{ changes: number, lastInsertRowid: number }>` | Rows affected and last inserted rowid      |

##### `query<T>(sql, params?)`

Executes a SQL query and returns the results as an array of objects.

```js
const users = await sqlite.query("SELECT * FROM users WHERE id = ?", [1]);
// Returns: [{ id: 1, name: 'Alice' }]
```

| Parameter   | Type           | Description                                              |
| ----------- | -------------- | -------------------------------------------------------- |
| `sql`       | `string`       | SQL query to execute                                     |
| `params`    | `any[]`        | (Optional) Parameters to substitute for `?` placeholders |
| **Returns** | `Promise<T[]>` | Array of result objects                                  |

##### `close()`

Closes the SQLite3 process. Always call this when done with the database.

```js
await sqlite.close();
```

### Utility Functions

#### `escapeValue(value)`

Escapes a single value for safe use in SQL queries.

```js
import { escapeValue } from "sqlite-wrapper.js";

escapeValue("Alice"); // "'Alice'"
escapeValue("O'Brien"); // "'O''Brien'"
escapeValue(42); // "42"
escapeValue(null); // "NULL"
escapeValue(true); // "TRUE"
escapeValue(new Date()); // "'2024-01-15T10:30:00.000Z'" (ISO 8601 format)
```

#### `interpolateSQL(sql, params)`

Interpolates parameters into a SQL string.

```js
import { interpolateSQL } from "sqlite-wrapper.js";

const sql = interpolateSQL("SELECT * FROM users WHERE name = ? AND age = ?", ["Alice", 25]);
// Returns: "SELECT * FROM users WHERE name = 'Alice' AND age = 25"
```

## Supported Parameter Types

The following types are supported for SQL parameters:

| Type                 | SQL Output                              |
| -------------------- | --------------------------------------- |
| `string`             | `'value'` (with proper escaping)        |
| `number`             | `123`                                   |
| `bigint`             | `123`                                   |
| `boolean`            | `TRUE` or `FALSE`                       |
| `null` / `undefined` | `NULL`                                  |
| `Date`               | `'YYYY-MM-DDTHH:mm:ss.sssZ'` (ISO 8601) |

## Usage Examples

### In-Memory Database

```js
import { SQLiteWrapper } from "sqlite-wrapper.js";

// Create an in-memory database (no dbPath)
const sqlite = new SQLiteWrapper("/usr/bin/sqlite3");

await sqlite.exec("CREATE TABLE temp_data (id INTEGER, value TEXT)");
await sqlite.exec("INSERT INTO temp_data VALUES (?, ?)", [1, "test"]);
const data = await sqlite.query("SELECT * FROM temp_data");

await sqlite.close();
```

### Using with Logger

```js
import { SQLiteWrapper } from "sqlite-wrapper.js";

const logger = {
	log: console.log,
	info: console.info,
	warn: console.warn,
	error: console.error,
	debug: console.debug,
};

const sqlite = new SQLiteWrapper("/usr/bin/sqlite3", {
	dbPath: "./mydb.sqlite",
	logger: logger,
});
```

### Using with Timing Callback

```js
import { SQLiteWrapper } from "sqlite-wrapper.js";

const sqlite = new SQLiteWrapper("/usr/bin/sqlite3", {
	onTiming: (timing) => {
		// queueMs: time spent waiting in queue before being dispatched
		// runMs: time spent after dispatch until completion
		// totalMs: end-to-end latency for this SQL task
		console.log("[SQL Timing]", timing.status, {
			sql: timing.sql,
			isQuery: timing.isQuery,
			queueMs: timing.queueMs,
			runMs: timing.runMs,
			totalMs: timing.totalMs,
		});
	},
});

await sqlite.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)");
await sqlite.exec("INSERT INTO users (name) VALUES (?)", ["Alice"]);

await sqlite.close();
```

### Performance Tuning Options

```js
import { SQLiteWrapper } from "sqlite-wrapper.js";

const sqlite = new SQLiteWrapper("/usr/bin/sqlite3", {
	dbPath: "./mydb.sqlite",
	maxInFlight: 256,
	maxBatchChars: 256 * 1024,
});
```

Use higher values only after benchmark validation in your workload.

### TypeScript Usage

```typescript
import { SQLiteWrapper } from "sqlite-wrapper.js";

interface User {
	id: number;
	name: string;
	email: string;
}

const sqlite = new SQLiteWrapper("/usr/bin/sqlite3", { dbPath: "./users.db" });

await sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL
  )
`);

await sqlite.exec("INSERT INTO users (name, email) VALUES (?, ?)", ["Alice", "alice@example.com"]);

// Type-safe query results
const users = await sqlite.query<User>("SELECT * FROM users");
// users is of type User[]

await sqlite.close();
```

### CommonJS Usage

```js
const { SQLiteWrapper } = require("sqlite-wrapper.js");

const sqlite = new SQLiteWrapper("/usr/bin/sqlite3", { dbPath: "./db.sqlite" });

// ... use sqlite
```

### Multiple Statements in Single Execution

You can execute multiple SQL statements in a single `exec()` call. Parameters are substituted sequentially across all statements:

```js
import { SQLiteWrapper } from "sqlite-wrapper.js";

const sqlite = new SQLiteWrapper("/usr/bin/sqlite3");

// The first ? is replaced with "Alice", the second ? with "Bob"
await sqlite.exec(
	`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT
  );

  INSERT INTO users (name) VALUES (?);
  INSERT INTO users (name) VALUES (?);
`,
	["Alice", "Bob"],
);

await sqlite.close();
```

## Why Use This Library?

Unlike other SQLite libraries for Node.js that require native bindings (like `better-sqlite3` or `sqlite3`), this library:

- **No compilation required** - Works immediately without building native modules
- **Cross-platform** - Works anywhere SQLite3 CLI is available
- **Simple deployment** - No need to worry about native dependencies in Docker/CI environments
- **Lightweight** - Zero npm dependencies

## Benchmarks

The library includes comprehensive benchmarks to measure performance. Run them with:

```bash
npm run benchmark
```

This will test various operations including table creation, inserts, queries, updates, deletes, and JOIN operations. See the [benchmark directory](./benchmark/README.md) for more details.

## Project Structure

```text
src/         Core runtime implementation and public types
benchmark/   Performance benchmark suites
test/        Distribution-level integration tests
script/      Utility scripts (for example sqlite binary download)
fixtures/    CJS/ESM fixtures for packaging tests
bin/         Downloaded sqlite binaries for local test/benchmark
dist/        Build outputs
```

## Naming and Maintenance Conventions

- Keep public API surface in `src/index.js` and corresponding declarations in `src/index.d.ts`.
- Keep internal queue logic isolated in `src/queue.js`.
- Use `node:` protocol imports for built-in modules.
- Prefer explicit option objects over positional boolean arguments.
- Add tests for behavior changes in `src/index.test.js` before refactoring internals.

## Performance Best Practices

- Prefer transaction-wrapped write batches for heavy write workloads.
- Add proper indexes for `UPDATE` and `WHERE` filters.
- Use `onTiming` to distinguish queue pressure from execution bottlenecks.
- Tune `maxInFlight` and `maxBatchChars` with benchmark data, not guesses.

<details><summary>Apple M3 Pro Benchmark Results</summary>

```
================================================================================================================================
SQLite Wrapper Benchmark Results
================================================================================================================================
Benchmark                                                                  Avg (ms)   Min (ms)   Max (ms)  Total (ms)    Ops/sec
--------------------------------------------------------------------------------------------------------------------------------
Table Creation                                                                0.296      0.210      0.721      14.816    3374.69
Single Row Insert                                                             0.324      0.208      2.436     324.119    3085.28
Bulk Insert (100 rows with transaction)                                       1.997      1.729      2.699      19.968     500.80
Simple SELECT (1000 rows)                                                     1.882      1.717      2.167     188.205     531.34
SELECT with WHERE clause                                                      0.996      0.910      1.253      99.582    1004.19
UPDATE Single Row                                                             0.177      0.019      0.355      88.517    5648.66
DELETE Single Row                                                             0.294      0.173      3.665     147.141    3398.11
JOIN Query (1000 orders, 100 customers)                                       2.146      2.072      2.330     107.278     466.08
Transaction (5 inserts)                                                       0.351      0.275      0.576      35.134    2846.25
100k Point Query by ID (100000 rows)                                          0.028      0.018      0.261      28.050   35651.01
100k Range Query by Category (100000 rows)                                    0.240      0.214      0.282      48.072    4160.41
100k Aggregate Query (100000 rows)                                           87.898     81.206    139.058    8789.809      11.38
100k Single Row Update (100000 rows)                                          0.307      0.219      2.384     307.271    3254.45
100k Batch Update 100 rows (100000 rows)                                      1.443      1.213      2.027     144.257     693.21
100k Simple Commands (SELECT 1)                                            0.017037          -          -    1703.738   58694.47
100k Sequential INSERT                                                     0.248893          -          -   24889.290    4017.79
100k Sequential UPDATE                                                     0.247484          -          -   24748.373    4040.67
20k Burst Enqueue INSERT (Promise.all)                                     0.008727          -          -     174.537  114588.86
20k Sequential Enqueue INSERT (await loop)                                 0.019912          -          -     398.241   50220.84
20k Chunked Enqueue INSERT (1000/chunk)                                    0.004907          -          -      98.138  203794.57
20k Burst Enqueue UPDATE (Promise.all)                                     0.009929          -          -     198.575  100717.36
================================================================================================================================
```

</summary>
</details>

## License

The [Anti 996 License](LICENSE)
