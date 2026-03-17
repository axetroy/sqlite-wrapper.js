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

| Parameter        | Type     | Description                                                                                 |
| ---------------- | -------- | ------------------------------------------------------------------------------------------- |
| `exePath`        | `string` | Path to the SQLite3 executable                                                              |
| `options.dbPath` | `string` | (Optional) Path to the SQLite database file. If not provided, an in-memory database is used |
| `options.logger` | `Logger` | (Optional) Logger instance for debugging                                                    |

#### Methods

##### `exec(sql, params?)`

Executes a SQL statement without returning results. Use for `CREATE`, `INSERT`, `UPDATE`, `DELETE` operations.

```js
await sqlite.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
await sqlite.exec("INSERT INTO users (name) VALUES (?)", ["Alice"]);
```

| Parameter | Type     | Description                                              |
| --------- | -------- | -------------------------------------------------------- |
| `sql`     | `string` | SQL statement to execute                                 |
| `params`  | `any[]`  | (Optional) Parameters to substitute for `?` placeholders |

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

<details><summary>Apple M3 Pro Benchmark Results</summary>

```
================================================================================
SQLite Wrapper Benchmark Results
================================================================================
Benchmark                                  Avg (ms)   Min (ms)   Max (ms)   Total (ms)    Ops/sec
--------------------------------------------------------------------------------
Table Creation                                0.317      0.242      0.594       15.864    3151.82
Single Row Insert                             0.346      0.220      2.223      346.000    2890.18
Bulk Insert (100 rows with transaction)       2.652      1.904      4.826       26.519     377.09
Simple SELECT (1000 rows)                     2.180      1.897      5.782      217.974     458.77
SELECT with WHERE clause                      1.086      0.997      1.876      108.609     920.73
UPDATE Single Row                             0.289      0.022      6.153      144.744    3454.38
DELETE Single Row                             0.294      0.199      1.375      147.227    3396.11
JOIN Query (1000 orders, 100 customers)       2.280      2.056      3.487      114.013     438.55
Transaction (5 inserts)                       0.400      0.325      0.680       40.026    2498.37
100k Point Query by ID (100000 rows)          0.029      0.018      0.180       28.564   35009.15
100k Range Query by Category (100000 rows)      0.231      0.210      0.271       46.134    4335.23
100k Aggregate Query (100000 rows)           87.897     82.129    141.772     8789.676      11.38
100k Single Row Update (100000 rows)          0.292      0.212      1.099      291.707    3428.09
100k Batch Update 100 rows (100000 rows)      1.522      1.248      2.442      152.213     656.97
100k Simple Commands (SELECT 1)            0.014345          -          -     1434.511   69710.16
100k Sequential INSERT                     0.243934          -          -    24393.382    4099.47
100k Sequential UPDATE                     0.235999          -          -    23599.891    4237.31
================================================================================
```

</summary>
</details>

## License

The [Anti 996 License](LICENSE)
