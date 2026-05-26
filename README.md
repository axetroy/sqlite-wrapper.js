# sqlite-executor

[![Badge](https://img.shields.io/badge/link-996.icu-%23FF4D5B.svg?style=flat-square)](https://996.icu/#/en_US)
[![LICENSE](https://img.shields.io/badge/license-Anti%20996-blue.svg?style=flat-square)](https://github.com/996icu/996.ICU/blob/master/LICENSE)
![Node](https://img.shields.io/badge/node-%3E=18-blue.svg?style=flat-square)
[![npm version](https://badge.fury.io/js/sqlite-executor.svg)](https://badge.fury.io/js/sqlite-executor)
![CI](https://github.com/axetroy/sqlite-wrapper.js/actions/workflows/build.yml/badge.svg)

A lightweight, zero-dependency SQLite wrapper for Node.js that communicates with the `sqlite3` CLI via stdin/stdout — no native addons, no `node-gyp`, no ABI headaches.

## Features

- 🚀 **Zero native dependencies** — pure JavaScript, no compilation needed
- ⚡ **Long-lived process** — single `sqlite3` process for the entire app lifecycle
- 🔄 **Promise-based API** — `execute()`, `query()`, `stream()`
- 📦 **Async Iterator support** — `for await (const row of db.stream(sql))`
- 🔐 **Transactions** — automatic `BEGIN … COMMIT / ROLLBACK` with concurrent caller serialization
- 📊 **Read/Write Split** — dedicated reader pool for concurrent read queries
- ⏱️ **Timeout control** — per-statement timeout with process-level failure recovery
- 🔁 **Auto-restart** — crashed process restarts automatically
- 📈 **Runtime metrics** — QPS, avg query time, timeout count, process restarts
- 📝 **Full TypeScript types** — included
- 📦 **Dual module** — ESM + CommonJS

## Requirements

- Node.js >= 18
- `sqlite3` CLI executable available on the system

## Installation

```bash
npm install sqlite-executor --save
```

## Quick Start

```js
import { SQLiteExecutor } from "sqlite-executor";

const db = new SQLiteExecutor({ database: "./app.db" });

await db.execute(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT
)`);

await db.execute("INSERT INTO users (name) VALUES (?)", ["Alice"]);
await db.execute("INSERT INTO users (name) VALUES (?)", ["Bob"]);

const rows = await db.query("SELECT * FROM users ORDER BY id ASC");
console.log(rows);
// [ { id: 1, name: 'Alice' }, { id: 2, name: 'Bob' } ]

await db.close();
```

## API Reference

### `SQLiteExecutor`

#### Constructor

```js
new SQLiteExecutor(options?)
```

| Option              | Type      | Default        | Description                                              |
| ------------------- | --------- | -------------- | -------------------------------------------------------- |
| `binary`            | `string`  | `"sqlite3"`    | Path to the `sqlite3` executable                          |
| `database`          | `string`  | `":memory:"`   | Database file path                                       |
| `logger`            | `Logger`  | —              | Optional logger (`log`, `info`, `warn`, `error`, `debug`) |
| `statementTimeout`  | `number`  | `30000`        | Per-statement timeout in milliseconds                     |
| `autoRestart`       | `boolean` | `true`         | Auto-restart on process crash                             |
| `poolSize`          | `number`  | `0`            | Reader pool size (read/write split, file DB only)         |
| `metrics`           | `Metrics` | auto-created   | Shared metrics instance                                   |

#### `db.execute(sql, params?, options?)`

Executes a SQL statement without returning rows. Use for `CREATE`, `INSERT`, `UPDATE`, `DELETE`.

```js
await db.execute("CREATE TABLE t (id INTEGER)");
await db.execute("INSERT INTO t (id) VALUES (?)", [1]);
await db.execute("UPDATE t SET id = ? WHERE id = ?", [2, 1]);
```

#### `db.query(sql, params?, options?)`

Executes a query and returns all result rows as an array.

```js
const rows = await db.query("SELECT * FROM users WHERE id = ?", [1]);
// [ { id: 1, name: 'Alice' } ]
```

#### `db.stream(sql, params?, options?)`

Returns an `AsyncIterable` for `for await` consumption.

```js
for await (const row of db.stream("SELECT * FROM huge_table")) {
  process(row);
}
```

Supports early `break` — the underlying process is not affected.

#### `db.transaction(fn, options?)`

Executes a callback inside a SQLite transaction (`BEGIN` / `COMMIT` / `ROLLBACK`). Concurrent calls are serialized — they never interleave.

```js
await db.transaction(async (tx) => {
  await tx.execute("INSERT INTO accounts (id, balance) VALUES (?, ?)", [1, 100]);
  await tx.execute("INSERT INTO accounts (id, balance) VALUES (?, ?)", [2, 200]);
}, "IMMEDIATE");
```

Inside the transaction callback, use the `tx` handle (`execute`, `query`, `stream`) — bare `db.*` calls would break transactional isolation.

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `mode` | `"DEFERRED"` \| `"IMMEDIATE"` \| `"EXCLUSIVE"` | `"DEFERRED"` | SQLite transaction lock mode |

#### `db.close()`

Closes the sqlite3 process and rejects all pending tasks.

```js
await db.close();
```

`SQLiteExecutor` also implements `Symbol.asyncDispose` and `Symbol.dispose`:

```js
// Using explicit resource management (ES2025)
await using db = new SQLiteExecutor({ database: "./app.db" });
```

#### `db.pendingStatements`

Returns the total number of pending statements across the writer queue, reader pool, and deferred queue.

#### `db.readerPool`

Returns the `ReaderPool` instance when `poolSize > 0` and the database is a file DB. Returns `null` otherwise.

#### `db.metrics`

Returns the `Metrics` instance. See below.

### `Metrics`

Runtime metrics collector, accessible via `db.metrics`.

```js
const stats = db.metrics.snapshot();
console.log(stats);
// {
//   tasksTotal: 42,
//   tasksSuccess: 40,
//   tasksFailed: 2,
//   tasksTimeout: 1,
//   processRestarts: 0,
//   executeCount: 20,
//   queryCount: 22,
//   streamCount: 0,
//   avgQueryTime: 15.3,   // ms
//   qps: 8.2,             // queries per second
//   uptime: 5.1,          // seconds
// }
```

| Method / Getter        | Returns        | Description                          |
| ---------------------- | -------------- | ------------------------------------ |
| `snapshot()`           | `object`       | All metrics as a plain object         |
| `tasksTotal`           | `number`       | Total tasks enqueued                  |
| `tasksSuccess`         | `number`       | Successfully completed tasks          |
| `tasksFailed`          | `number`       | Failed tasks                          |
| `tasksTimeout`         | `number`       | Timed-out tasks                       |
| `processRestarts`      | `number`       | sqlite3 process restarts              |
| `executeCount`         | `number`       | `execute` calls                       |
| `queryCount`           | `number`       | `query` calls                         |
| `streamCount`          | `number`       | `stream` calls                        |

Multiple executors / workers can share the same `Metrics` instance:

```js
import { SQLiteExecutor, Metrics } from "sqlite-executor";

const metrics = new Metrics();

const db1 = new SQLiteExecutor({ database: "./a.db", metrics });
const db2 = new SQLiteExecutor({ database: "./b.db", metrics });
```

### TypeScript Usage

```typescript
import { SQLiteExecutor } from "sqlite-executor";

interface User {
  id: number;
  name: string;
}

const db = new SQLiteExecutor({ database: "./users.db" });

await db.execute(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
)`);

const users = await db.query<User>("SELECT * FROM users");
// users: User[]
```

## Advanced Usage

### Read/Write Split with Reader Pool

For file-based databases, you can enable a reader pool for concurrent read queries:

```js
const db = new SQLiteExecutor({
  database: "./app.db",
  poolSize: 3,   // 3 reader processes
});
```

Writes always go through the main writer process. Reads (`SELECT`, `WITH`, `VALUES`, `EXPLAIN`) are dispatched to a pool of `TaskWorker` instances via round-robin. This prevents long-running reads from blocking writes.

### Parameterized Queries

SQL parameters use `?` placeholders with automatic escaping:

```js
await db.execute("INSERT INTO users (name, email) VALUES (?, ?)", ["Alice", "alice@example.com"]);
const rows = await db.query("SELECT * FROM users WHERE email = ?", ["alice@example.com"]);
```

Supported parameter types:

| Type                 | SQL Output                              |
| -------------------- | --------------------------------------- |
| `string`             | `'value'` (properly escaped)            |
| `number`             | `123`                                   |
| `bigint`             | `123`                                   |
| `boolean`            | `TRUE` / `FALSE`                        |
| `null` / `undefined` | `NULL`                                  |
| `Date`               | `'2024-01-15T10:30:00.000Z'` (ISO 8601) |

### Error Handling

SQL errors from sqlite3 are captured and the task promise is rejected:

```js
try {
  await db.query("SELECT * FROM nonexistent");
} catch (err) {
  console.log(err.message);  // "Parse error near line 1: no such table: nonexistent"
}
```

Process crashes are handled automatically — the current task and all queued tasks are rejected, and a new process is spawned (if `autoRestart` is enabled, which is the default).

### Using with Logger

```js
const db = new SQLiteExecutor({
  database: "./app.db",
  logger: {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  },
});
```

### Streaming Large Result Sets

```js
for await (const row of db.stream("SELECT * FROM logs WHERE created_at > ?", [date])) {
  sendToClient(row);
}
```

## Benchmarks

```bash
npm run benchmark
```

See the [benchmark directory](./benchmark/README.md) for details.

## Project Structure

```text
src/         Source code
benchmark/   Performance benchmarks
script/      Utility scripts (e.g. sqlite binary download)
fixtures/    CJS/ESM fixtures for packaging tests
bin/         Downloaded sqlite3 binaries
dist/        Build outputs
```

## License

The [Anti 996 License](LICENSE)
