# 基于 Node.js 的 SQLite3 CLI 执行器技术白皮书

---

# 1. 项目概述

## 1.1 项目背景

SQLite 是目前最广泛使用的嵌入式数据库之一。

传统 Node.js 生态通常通过以下方式接入 SQLite：

- sqlite3
- better-sqlite3
- node-sqlite

这些方案本质上依赖：

- Native Addon
- Node ABI
- node-gyp
- C/C++ 编译环境

在 Electron、跨平台桌面软件、便携式工具链中，会产生以下问题：

- ABI 不兼容
- Electron 版本绑定
- 编译困难
- CI/CD 复杂
- 平台适配困难

因此，需要一种：

- 纯 Node.js
- 无 Native 模块
- 无 ABI 依赖
- 可跨平台运行

的 SQLite 执行方案。

---

## 1.2 核心思路

本方案基于：

```text id="e3a8g1"
sqlite3 可执行文件
```

通过：

```text id="m6k1r5"
stdin / stdout
```

与 sqlite3 进程进行通信。

Node.js 负责：

- 进程管理
- SQL 调度
- stdout 解析
- 协议管理
- 队列控制

sqlite3 CLI 负责：

- SQL 执行
- 数据存储
- 事务处理
- 文件锁管理

整体结构：

```text id="n8w2y4"
Node.js
   │
   │ stdin/stdout
   ▼
sqlite3 executable
   │
   ▼
SQLite Database
```

---

# 2. 技术目标

本项目目标：

构建一个：

- 长连接
- 高性能
- 纯 Node.js
- 可跨平台
- 可扩展
- 可流式读取
- 支持事务
- 可 Electron 集成

的 SQLite 执行器。

---

# 3. 技术架构

## 3.1 整体架构

```text id="t1f7z3"
┌────────────────────┐
│     Application    │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│   SQLiteExecutor   │
│                    │
│ - Queue            │
│ - Parser           │
│ - Protocol         │
│ - Transaction      │
│ - Timeout          │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│  Child Process     │
│  sqlite3 binary    │
└─────────┬──────────┘
          │
     stdin/stdout
          │
          ▼
┌────────────────────┐
│     sqlite3 CLI    │
└────────────────────┘
```

---

# 4. 为什么选择 sqlite3 CLI

## 4.1 SQLite CLI 的特点

sqlite3 官方提供：

```text id="k7q9x2"
sqlite3.exe
sqlite3
```

作为数据库交互终端。

CLI 本身具备：

- SQL 执行能力
- 事务能力
- JSON 输出能力
- stdin 输入能力
- stdout 输出能力

因此可以直接作为数据库 Runtime 使用。

---

## 4.2 与 Native Addon 对比

| 对比项        | sqlite3 CLI | Native Addon |
| ------------- | ----------- | ------------ |
| ABI 依赖      | 无          | 有           |
| Electron 兼容 | 极强        | 一般         |
| node-gyp      | 不需要      | 需要         |
| 跨平台        | 强          | 中           |
| 部署复杂度    | 低          | 高           |
| 调试难度      | 低          | 中           |
| 可移植性      | 高          | 中           |

---

# 5. 核心通信机制

## 5.1 stdin 输入

Node.js 通过：

```js id="g8h3d9"
proc.stdin.write(sql);
```

向 sqlite3 进程发送 SQL。

---

## 5.2 stdout 输出

sqlite3 将执行结果输出到：

```text id="u2w5m7"
stdout
```

Node.js 通过：

```js id="r4k1t6"
proc.stdout.on("data");
```

读取执行结果。

---

## 5.3 stderr 输出

sqlite3 错误输出：

```text id="b1n8c3"
stderr
```

Node.js 监听：

```js id="j7y4p2"
proc.stderr.on("data");
```

获取错误信息。

---

# 6. 长连接架构

## 6.1 为什么必须使用长连接

错误方案：

```text id="p6v8q4"
每次执行 SQL:
  启动 sqlite3
  执行 SQL
  退出进程
```

问题：

- 进程创建开销大
- 文件锁频繁
- 吞吐低
- Electron 卡顿
- 大量系统调用

---

## 6.2 正确方案

推荐：

```text id="s2m7x9"
整个应用生命周期:
  一个 sqlite3 进程
```

即：

```text id="f5c3r1"
Node.js
   ⇄
sqlite3 process
```

所有 SQL 通过同一个 stdin 流发送。

---

## 6.3 长连接优势

| 优势     | 说明             |
| -------- | ---------------- |
| 高性能   | 避免重复 spawn   |
| 低延迟   | 减少 IPC 初始化  |
| 稳定     | 减少系统资源波动 |
| 易控制   | 可统一调度       |
| 支持事务 | 同连接上下文     |

---

# 7. SQL 执行协议设计

## 7.1 核心问题

stdout 是连续流：

```text id="z1k6v5"
{"id":1}
{"id":2}
{"id":3}
```

Node.js 无法知道：

- 哪条 SQL 已结束
- 多个请求如何区分
- 结果边界在哪里

因此必须设计协议层。

---

## 7.2 Sentinel 结束标记方案

推荐方案：

每次执行 SQL 时追加：

```sql id="x8w3t1"
SELECT '__END__TOKEN__';
```

例如：

```sql id="q5r9p7"
SELECT * FROM users;
SELECT '__END__abc123__';
```

stdout：

```text id="v2b6m8"
{"id":1}
{"id":2}
__END__abc123__
```

Node.js 检测到 token 后：

```text id="n4c7y2"
当前 SQL 执行结束
```

---

## 7.3 协议执行流程

```text id="m9f1k3"
execute(sql)
    │
    ▼
生成 token
    │
    ▼
拼接 sentinel SQL
    │
    ▼
stdin.write()
    │
    ▼
stdout 接收数据
    │
    ▼
解析结果
    │
    ▼
检测 token
    │
    ▼
结束 Promise
```

---

# 8. 输出格式设计

## 8.1 JSON 输出模式

sqlite3 提供：

```bash id="d7x2p6"
-json
```

输出格式：

```json id="h3v8m1"
{"id":1,"name":"Tom"}
{"id":2,"name":"Jerry"}
```

推荐始终使用：

```bash id="t6k4q9"
sqlite3 db.sqlite -json
```

---

## 8.2 JSON 模式优势

| 优势     | 说明           |
| -------- | -------------- |
| 易解析   | 无需 split     |
| 字段安全 | 避免分隔符问题 |
| 支持嵌套 | JSON 天然支持  |
| 更稳定   | 格式固定       |

---

# 9. 队列调度系统

## 9.1 为什么必须串行

sqlite3 CLI 本质是：

```text id="y1m5w8"
单 stdin 流
```

如果多个请求同时：

```js id="k4r7n2"
stdin.write();
```

可能产生：

```sql id="c8p3v6"
SELECT * FROINSERT INTO users...
```

导致 SQL 流损坏。

---

## 9.2 正确设计

必须：

```text id="u6x9t4"
串行队列
```

执行模型：

```text id="b2k8m5"
execute()
   │
   ▼
Queue
   │
   ▼
当前任务执行
   │
   ▼
结束后执行下一个
```

---

## 9.3 Promise Queue 与管线化

主 Executor 使用串行队列，一次仅允许一个 active task：

```text id="r7v1p3"
[
  {
    sql,
    token,
    resolve,
    reject
  }
]
```

但 **TaskWorker**（用于 ReaderPool）支持 **管线化（Pipelining）**：
将多个 SQL payload 合并为一次 `stdin.write()` 发送，由 sqlite3 顺序执行后，
在 stdout 解析时按 FIFO 顺序匹配 sentinel token 逐一完成 Promise。

```text id="pipeline-flow"
stdin:  [SQL_A][SENTINEL_A][SQL_B][SENTINEL_B]  ← 一次写入
stdout: [RESULT_A][SENTINEL_A][RESULT_B][SENTINEL_B]  ← 依次解析
```

管线化批量大小由 `batchSize` 控制（默认 10）。

---

# 10. stdout 流解析

## 10.1 数据读取模型

stdout 本质：

```text id="f8q2m6"
Stream
```

不是完整字符串。

因此：

```js id="n3w7k1"
stdout.on("data");
```

可能：

- 半行
- 多行
- 不完整 JSON

---

## 10.2 实际方案：流式 JSON 值解析器

本项目不使用 readline，而是实现了自定义的 **`createJsonValueParser`**：

- 逐字符扫描流式数据，通过括号/花括号嵌套计数检测完整的顶层 JSON 值
- 支持分块输入，通过 `readPos` 避免重复扫描已处理数据
- 每次解析出一个完整 JSON 值后通过回调通知

对于 **stream 类型**（流式读取），额外使用 **`createRowStreamParser`**：
- 在 JSON 数组内逐元素回调 `onRow`，避免一次性解析全部结果
- 支持跨分块的元素解析

```text id="parser-flow"
stdout chunk
    │
    ▼
createJsonValueParser
    │ 识别完整 JSON 值
    ▼
#handleParsedValue / #handleJsonValue
    │
    ├── isSentinelRow → 任务结束 / reject
    ├── query 结果数组 → task.rows.push
    └── stream 类型 → onRow 逐行回调
```

---

# 11. 错误处理机制

## 11.1 stderr 错误监听

sqlite3 SQL 错误：

```text id="w6k3p9"
near "xxx": syntax error
```

输出到：

```text id="t1v7m5"
stderr
```

Node.js 必须监听：

```js id="q4n8x2"
proc.stderr.on("data");
```

并映射到当前任务。

---

## 11.2 超时控制

必须实现：

```text id="h8m4c1"
SQL Timeout
```

否则：

- 死锁
- 长事务
- IO 阻塞

会导致 Promise 永远不结束。

推荐：

```js id="y2p6v9"
setTimeout();
```

强制 reject。

---

# 12. 大结果集处理

## 12.1 问题

以下 SQL：

```sql id="g5t8k3"
SELECT * FROM huge_table;
```

可能返回：

- 数百万行
- GB 级输出

如果：

```js id="r1x7m4"
result.push(row);
```

会导致：

```text id="n9v2c6"
Node.js 内存暴涨
```

---

## 12.2 流式读取

提供两种 API：

**1. 回调模式：**

```js id="k3m8t1"
await db.queryStream(sql, (row) => { ... });
```

**2. Async Iterator 模式（推荐）：**

```js id="v6k1x9"
for await (const row of db.stream(sql)) {
	console.log(row);
}
```

模式：

```text id="p7x4v9"
stdout chunk
   │
   ▼
createRowStreamParser
   │ 逐元素
   ▼
onRow(row)  /  AsyncRowBuffer → for await
```

而不是：

```text id="m2c6r8"
全部缓存
```

---

# 13. 事务系统设计

## 13.1 基础事务

事务本质：

```sql id="v4k1p7"
BEGIN;
...
COMMIT;
```

失败：

```sql id="x9m3t5"
ROLLBACK;
```

---

## 13.2 推荐 API

```js id="c7r2v8"
await db.transaction(async (trx) => {
  await trx.execute(...);
});
```

内部：

```text id="q1x6m4"
BEGIN
执行用户逻辑
成功 -> COMMIT
失败 -> ROLLBACK
```

---

## 13.3 为什么长连接支持事务

SQLite 事务依赖：

```text id="t8v5k2"
同一个 connection context
```

而：

```text id="m3p7x1"
sqlite3 CLI process
```

本身就是单连接上下文。

因此天然支持事务。

---

# 14. 进程生命周期管理

## 14.1 必须监听的事件

```js id="n6k2v9"
proc.on("exit");
proc.on("close");
proc.on("error");
```

---

## 14.2 崩溃恢复机制

当 sqlite3 进程退出：

需要：

```text id="r4x8m3"
1. reject 当前任务
2. 清空队列
3. 自动重启 sqlite3
```

否则：

- Promise 永远 pending
- 队列锁死
- 数据库不可用

---

# 15. 性能优化策略

## 15.1 WAL 模式

推荐启动时执行：

```sql id="p2v7k5"
PRAGMA journal_mode=WAL;
```

优势：

| 优势       | 说明            |
| ---------- | --------------- |
| 提升并发   | 读写分离        |
| 提高写性能 | 减少锁竞争      |
| 降低阻塞   | WAL append 模式 |

---

## 15.2 减少 JSON 解析开销

JSON.parse 是主要 CPU 消耗之一。

优化方向：

- 行级解析
- 避免深拷贝
- 减少对象转换

---

## 15.3 避免频繁 spawn

spawn 是重量级系统调用。

必须：

```text id="x5m9r1"
单实例长期运行
```

---

# 16. Electron 场景优势

## 16.1 Electron 最大问题

Electron 使用：

```text id="k8v3p6"
自定义 Node ABI
```

导致：

- better-sqlite3 需要 rebuild
- sqlite3 addon 需要重新编译

---

## 16.2 CLI 方案优势

stdin/stdout 模式：

```text id="m1x7t4"
完全无 ABI
```

因此：

- 不需要 rebuild
- 不需要 node-gyp
- 不需要 Python
- 不需要 Visual Studio

非常适合：

- Electron
- Tauri
- NW.js
- 桌面工具

---

# 17. 推荐模块结构

```text id="q7p2v5"
src/
 ├── core/
 │    ├── executor.js      # SQLiteExecutor：主入口，串行队列 + 事务 + 自动重启
 │    ├── taskWorker.js     # TaskWorker：单进程任务执行器，支持管线化
 │    ├── readerPool.js     # ReaderPool：只读连接池，round-robin 分发
 │    ├── metrics.js        # Metrics：运行时指标收集器
 │    ├── classifier.js     # SQL 分类器（read / write）用于读写分离
 │    ├── parser.js         # JSON 流式解析器（createJsonValueParser / createRowStreamParser）
 │    ├── protocol.js       # Sentinel 协议（buildPayload / isSentinelRow）
 │    ├── queue.js          # 双端队列
 │    └── process.js        # 子进程管理器
 │
 ├── transaction/
 │    └── transaction.js    # 事务工具（VALID_TRANSACTION_MODES, createTransactionHandle）
 │
 ├── stream/
 │    └── queryStream.js    # 流式查询（setupStreamParser, AsyncRowBuffer）
 │
 ├── utils/
 │    ├── timeout.js        # 超时控制
 │    └── token.js          # 唯一 token 生成
 │
 ├── constants.js           # 共享常量（TOKEN_COLUMN）
 ├── utils.js               # SQL 工具（normalizeSQL, interpolateSQL, escapeValue）
 ├── which.js               # 可执行文件查找
 └── index.js               # 模块入口
```

---

# 18. 推荐 API 设计

## 18.1 初始化

```js id="v3k8m1"
const db = new SQLiteExecutor({
	binary: "./sqlite3.exe",
	database: "./test.db",
});
```

---

## 18.2 execute

```js id="t6x2p7"
await db.execute(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT
  )
`);
```

---

## 18.3 query

```js id="m9r4v2"
const rows = await db.query(`
  SELECT * FROM users
`);
```

---

## 18.4 stream query

```js id="x1p7k5"
await db.queryStream(sql, (row) => {
	console.log(row);
});
```

---

## 18.5 transaction

```js id="k4v8m3"
await db.transaction(async trx => {
  await trx.execute(...);
  await trx.execute(...);
});
```

---

# 19. 核心设计总结

## 19.1 本质

该项目本质上是：

```text id="p8x3m6"
SQLite CLI Protocol Runtime
```

Node.js 负责：

- 协议层
- 调度层
- 流解析
- 生命周期管理

sqlite3 CLI 负责：

- SQL 执行
- 数据存储
- 事务管理

---

## 19.2 核心技术点

| 技术点          | 重要程度 |
| --------------- | -------- |
| 长连接          | 极高     |
| Sentinel 协议   | 极高     |
| Queue 串行化    | 极高     |
| stdout 流解析   | 极高     |
| 管线化 Pipelining | 高     |
| 读写分离        | 高       |
| 超时控制        | 高       |
| 崩溃恢复        | 高       |
| 流式读取        | 高       |
| WAL 模式        | 高       |
| 运行时指标      | 中       |
| SQL 分类器      | 中       |
| 只读连接池      | 中       |

---

## 19.3 实际架构

```text id="y6v2k9"
Node.js — SQLiteExecutor
  │
  ├── Queue Scheduler（串行队列 + 事务域隔离）
  ├── SQL Protocol（buildPayload / isSentinelRow）
  ├── Stream Parser（createJsonValueParser / createRowStreamParser）
  ├── Transaction Manager（BEGIN / COMMIT / ROLLBACK）
  ├── Timeout Manager（setTimeout + process级故障恢复）
  ├── Crash Recovery（autoRestart）
  ├── SQL Classifier（classifySQL：区分 read / write）
  ├── ReaderPool（多个 TaskWorker，round-robin 分发只读任务）
  │     └── TaskWorker（单进程执行器，支持管线化 batch）
  ├── Metrics（QPS / avgQueryTime / timeoutCount / ...）
  └── Query Stream（AsyncRowBuffer → AsyncIterator）
          │
          ▼
sqlite3 executable (--json mode)
          │
          ▼
SQLite Database
```

---

# 20. 已实现 & 后续扩展方向

> ✅ = 已实现的核心功能 ｜ 其余为后续扩展方向

# 20.1 多进程执行架构

✅ **已实现** — 见 `ReaderPool` / `TaskWorker`

当前架构：

```text id="r2m8x5"
Node.js SQLiteExecutor
   │
   ├── Writer（ProcessManager，单进程）
   └── ReaderPool
         ├── TaskWorker-0
         ├── TaskWorker-1
         └── TaskWorker-2
```

其中 ReaderPool 使用 **Round Robin** 策略分发只读任务，写操作始终由 writer 进程执行（**Read/Write Split**）。

---

## 20.1.1 调度策略

| 策略             | 说明       | 状态   |
| ---------------- | ---------- | ------ |
| Round Robin      | 轮询       | ✅ 已实现 |
| Read/Write Split | 读写分离   | ✅ 已实现 |
| Least Busy       | 最小负载   | ❌ 待实现 |
| Sticky Session   | 会话固定   | ❌ 待实现 |

---

# 20.2 Worker Thread 调度架构

## 20.2.1 当前问题

当前：

```text id="k1x6m8"
stdout JSON.parse
```

运行在主线程。

大量数据时：

- 阻塞 Event Loop
- UI 卡顿
- Electron Renderer Freeze

---

## 20.2.2 Worker Thread 化

可将：

```text id="v5p2k7"
Parser
Queue
Protocol
```

放入 Worker Thread。

架构：

```text id="m8x4v1"
Main Thread
    │
    ▼
Worker Thread
    │
    ▼
sqlite3 process
```

---

# 20.3 Binary Protocol 扩展

## 20.3.1 当前问题

JSON 模式：

```text id="t3v7k2"
stdout → JSON.parse
```

存在：

- 文本编码开销
- JSON 序列化开销
- GC 压力

---

## 20.3.2 Binary Row 协议

后续可设计：

```text id="p6x1m9"
Binary Row Stream
```

例如：

```text id="k9v4x7"
[length][columnCount][binaryData]
```

Node.js 使用：

```js id="m2p8v5"
Buffer;
DataView;
```

直接解析。

---

# 20.4 Shared Memory 通信

## 20.4.1 当前模式

当前通信：

```text id="x4m7k1"
stdin/stdout
```

本质：

```text id="v8p3x6"
Pipe IPC
```

---

## 20.4.2 后续方向

可实现：

```text id="k5x9m2"
Shared Memory IPC
```

架构：

```text id="p1v6k8"
Node.js
   ⇄ Shared Memory ⇄
SQLite Runtime
```

---

# 20.5 SQLite Runtime 抽象层

## 20.5.1 Runtime 抽象

统一：

| Runtime       | 说明          |
| ------------- | ------------- |
| sqlite3 CLI   | 默认          |
| libsql        | 分布式 SQLite |
| sqlcipher     | 加密 SQLite   |
| wasm sqlite   | WebAssembly   |
| remote sqlite | TCP 模式      |

---

## 20.5.2 抽象接口

```ts id="n3x7v4"
interface SQLiteRuntime {
	execute(sql: string): Promise<any>;
	query(sql: string): Promise<any[]>;
	close(): Promise<void>;
}
```

---

# 20.6 Remote SQLite 扩展

## 20.6.1 远程执行器

后续可扩展：

```text id="x7k2m5"
Client ⇄ TCP ⇄ SQLite Executor Server
```

---

## 20.6.2 远程协议

可设计：

```text id="m1v8p3"
JSON-RPC
Binary RPC
MessagePack RPC
```

---

# 20.7 SQLite 微服务化

## 20.7.1 Executor Server

可封装：

```text id="p9x4k6"
SQLite Executor Daemon
```

架构：

```text id="v2m7x1"
┌──────────────────┐
│ SQLite Service   │
├──────────────────┤
│ Queue            │
│ Runtime          │
│ WAL              │
│ Cache            │
│ Transaction      │
└──────────────────┘
```

---

# 20.8 本地 AI Agent 集成

## 20.8.1 Agent Memory

SQLite 非常适合作为：

```text id="k4x9m7"
LLM Local Memory
```

后续可扩展：

- Memory Store
- Conversation Index
- Embedding Metadata
- Retrieval Cache

---

## 20.8.2 向量索引支持

可集成：

```text id="x5v1p8"
sqlite-vss
sqlite-vector
```

实现：

```text id="m8k3x2"
本地 RAG Runtime
```

---

# 20.9 流式查询协议

## 20.9.1 Async Iterator

✅ **已实现** — `SQLiteExecutor.stream()` 返回 `AsyncIterable<T>`

API：

```js id="v6k1x9"
for await (const row of db.stream(sql)) {
	console.log(row);
}
```

内部通过 `AsyncRowBuffer` 将回调驱动的行流桥接到 async iterator 协议，支持提前 `break`。

---

# 20.10 Reactive Query 系统

## 20.10.1 自动订阅

后续可实现：

```text id="k7m3x5"
Reactive SQLite
```

例如：

```js id="x1v8p6"
db.watch(
	`
  SELECT * FROM users
`,
	(rows) => {
		render(rows);
	},
);
```

---

# 20.11 Query Planner 层

## 20.11.1 SQL 生命周期

后续可加入：

```text id="m4x9k2"
Query Planner
```

负责：

- SQL 分析
- 自动分页
- LIMIT 注入
- 大查询拦截
- Stream 自动切换

---

# 20.12 Prepared Pipeline

## 20.12.1 Prepared SQL Pipeline

可实现：

```text id="p8k5x1"
prepare
   │
   ▼
cache
   │
   ▼
reuse
```

---

# 20.13 Cache Layer

## 20.13.1 查询缓存

可加入：

```text id="x3m7v9"
LRU Query Cache
```

缓存：

- SQL
- Result
- Metadata

---

# 20.14 插件系统

## 20.14.1 Plugin Runtime

后续可支持：

```text id="m6x2k8"
Plugin API
```

例如：

```js id="v9p4x3"
db.use(plugin);
```

---

# 20.15 Metrics 系统

## 20.15.1 Runtime Metrics

✅ **已实现** — `Metrics` 类，`SQLiteExecutor.metrics` / `metrics.snapshot()`

统计：

| 指标              | 说明              | 获取方式                  |
| ----------------- | ----------------- | ------------------------- |
| tasksTotal        | 任务总数          | `metrics.snapshot().qps`   |
| tasksSuccess      | 成功任务数        | `metrics.snapshot().tasksSuccess` |
| tasksFailed       | 失败任务数        | `metrics.snapshot().tasksFailed`  |
| tasksTimeout      | 超时任务数        | `metrics.snapshot().tasksTimeout` |
| processRestarts   | 进程重启次数      | `metrics.snapshot().processRestarts` |
| executeCount      | execute 执行次数  | `metrics.executeCount`     |
| queryCount        | query 执行次数    | `metrics.queryCount`       |
| streamCount       | stream 执行次数   | `metrics.streamCount`      |
| avgQueryTime      | 平均耗时（ms）    | `metrics.snapshot().avgQueryTime` |
| qps               | 每秒查询数        | `metrics.snapshot().qps`    |
| uptime            | 运行时间（秒）    | `metrics.snapshot().uptime` |

Metrics 实例可通过构造参数传入，支持多个 Executor / TaskWorker 共享同一实例。

---

# 20.16 DevTools 集成

## 20.16.1 调试面板

可扩展：

```text id="x7p2m5"
SQLite DevTools
```

功能：

- SQL Monitor
- Queue Viewer
- WAL State
- Live Query
- Stream Inspector

---

# 20.17 WASM Runtime 扩展

## 20.17.1 浏览器支持

后续可替换：

```text id="m3k8x1"
sqlite3 executable
```

为：

```text id="v5x9p2"
sqlite wasm runtime
```

实现：

```text id="k4m7x8"
Node.js / Browser Unified Runtime
```

---

# 20.18 分布式 SQLite 扩展

## 20.18.1 libSQL

后续支持：

```text id="x8m1k5"
libSQL
```

实现：

- 多节点同步
- Edge SQLite
- Remote WAL

---

## 20.18.2 Turso 集成

可扩展：

```text id="p6x3v7"
Local First SQLite
```

架构：

```text id="m2k9x4"
Local sqlite
     ⇄
Remote sync
```

---

# 20.19 SQLite Runtime SDK 化

## 20.19.1 SDK 方向

后续可演化为：

```text id="v1x8m6"
SQLite Runtime SDK
```

支持：

| 平台     | 支持 |
| -------- | ---- |
| Node.js  | √    |
| Electron | √    |
| Browser  | √    |
| Bun      | √    |
| Deno     | √    |
| Tauri    | √    |

---

# 20.20 Runtime Kernel 化

## 20.20.1 最终演化方向

最终可演化为：

```text id="k9x4m2"
Database Runtime Kernel
```

架构：

```text id="x5m1v7"
┌────────────────────┐
│ Runtime Kernel     │
├────────────────────┤
│ Queue              │
│ Protocol           │
│ WAL                │
│ Stream             │
│ Cache              │
│ Plugin             │
│ Metrics            │
│ Replication        │
└────────────────────┘
```
