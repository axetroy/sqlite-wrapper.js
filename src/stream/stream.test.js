import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { setupStreamParser, createRowStreamParser, AsyncRowBuffer } from "./stream.js";

describe("setupStreamParser", () => {
	test("stream 类型任务创建行流解析器", () => {
		const rows = [];
		const task = {
			kind: "stream",
			onRow: (row) => rows.push(row),
			consumerError: null,
		};

		const parser = setupStreamParser(task);
		assert.ok(parser);
		assert.equal(typeof parser.feed, "function");

		parser.feed('[{"id":1},{"id":2}]');
		assert.equal(rows.length, 2);
		assert.deepEqual(rows[0], { id: 1 });
		assert.deepEqual(rows[1], { id: 2 });
	});

	test("非 stream 类型返回 null", () => {
		assert.equal(setupStreamParser({ kind: "query" }), null);
		assert.equal(setupStreamParser({ kind: "execute" }), null);
		assert.equal(setupStreamParser({ kind: "unknown" }), null);
	});

	test("onRow 抛错时设置 consumerError", () => {
		const task = {
			kind: "stream",
			onRow: (row) => {
				if (row.id === 2) throw new Error("consumer failed");
			},
			consumerError: null,
		};

		const parser = setupStreamParser(task);
		parser.feed('[{"id":1},{"id":2},{"id":3}]');

		assert.ok(task.consumerError);
		assert.ok(task.consumerError.message.includes("consumer failed"));
	});

	test("消费者错误后继续解析但跳过后续回调", () => {
		const called = [];
		const task = {
			kind: "stream",
			onRow: (row) => {
				called.push(row.id);
				if (row.id === 2) throw new Error("stop");
			},
			consumerError: null,
		};

		const parser = setupStreamParser(task);
		parser.feed('[{"id":1},{"id":2},{"id":3}]');

		assert.deepEqual(called, [1, 2]);
		assert.ok(task.consumerError);
	});

	test("sentinel 行被回喂给 valueParser", () => {
		const valueParserFeed = [];
		const task = {
			kind: "stream",
			onRow: () => {},
			consumerError: null,
		};

		const parser = setupStreamParser(task, {
			feed: (raw) => valueParserFeed.push(raw),
		});
		parser.feed('[{"__sqlite_executor_token__":"abc"}]');

		assert.equal(valueParserFeed.length, 1);
		assert.ok(valueParserFeed[0].includes("__sqlite_executor_token__"));
	});

	test("数据行不回喂给 valueParser", () => {
		const valueParserFeed = [];
		const task = {
			kind: "stream",
			onRow: () => {},
			consumerError: null,
		};

		const parser = setupStreamParser(task, {
			feed: (raw) => valueParserFeed.push(raw),
		});
		parser.feed('[{"id":1,"name":"Alice"}]');

		assert.equal(valueParserFeed.length, 0);
	});

	test("sentinel 行回喂时包裹为数组格式", () => {
		const valueParserFeed = [];
		const task = {
			kind: "stream",
			onRow: () => {},
			consumerError: null,
		};

		const parser = setupStreamParser(task, {
			feed: (raw) => valueParserFeed.push(raw),
		});
		const sentinelRaw = '{"__sqlite_executor_token__":"tok-123"}';
		parser.feed(`[${sentinelRaw}]`);

		assert.equal(valueParserFeed.length, 1);
		assert.equal(valueParserFeed[0], `[${sentinelRaw}]`);
	});
});

describe("createRowStreamParser 重新导出", () => {
	test("与 core/parser 中的导出一致", async () => {
		const { createRowStreamParser: original } = await import("../core/parser.js");
		assert.equal(createRowStreamParser, original);
	});
});

describe("AsyncRowBuffer", () => {
	test("push 后 next 返回行数据", async () => {
		const buffer = new AsyncRowBuffer();
		buffer.push({ id: 1 });
		buffer.push({ id: 2 });
		buffer.end();

		const { value: row1 } = await buffer.next();
		assert.deepEqual(row1, { id: 1 });
		const { value: row2 } = await buffer.next();
		assert.deepEqual(row2, { id: 2 });
		const { done } = await buffer.next();
		assert.equal(done, true);
	});

	test("先 push 再 end 后 next 依次消费完", async () => {
		const buffer = new AsyncRowBuffer();
		buffer.push(1);
		buffer.push(2);
		buffer.end();

		const results = [];
		for await (const v of buffer) {
			results.push(v);
		}
		assert.deepEqual(results, [1, 2]);
	});

	test("end 后 next 立即返回 done", async () => {
		const buffer = new AsyncRowBuffer();
		buffer.end();
		const { done } = await buffer.next();
		assert.equal(done, true);
	});

	test("error 后 next 被拒绝", async () => {
		const buffer = new AsyncRowBuffer();
		buffer.error(new Error("oops"));

		await assert.rejects(buffer.next(), /oops/);
	});

	test("next 等待 push 后 resolve（异步生产）", async () => {
		const buffer = new AsyncRowBuffer();
		const nextPromise = buffer.next();

		buffer.push(42);
		const result = await nextPromise;
		assert.deepEqual(result, { value: 42, done: false });
	});

	test("push 后不再触发等待的 next", async () => {
		const buffer = new AsyncRowBuffer();
		const p1 = buffer.next();
		buffer.push(10);
		assert.deepEqual(await p1, { value: 10, done: false });

		const p2 = buffer.next();
		buffer.push(20);
		assert.deepEqual(await p2, { value: 20, done: false });
	});

	test("return 后迭代提前结束", async () => {
		const buffer = new AsyncRowBuffer();
		buffer.push(1);
		buffer.push(2);

		const results = [];
		for await (const v of buffer) {
			results.push(v);
			if (v === 1) break;
		}
		assert.deepEqual(results, [1]);
	});

	test("return 解决待处理的 next", async () => {
		const buffer = new AsyncRowBuffer();
		const p = buffer.next();
		buffer.return();
		const { done } = await p;
		assert.equal(done, true);
	});

	test("return 后 next 立即返回 done", async () => {
		const buffer = new AsyncRowBuffer();
		buffer.return();
		const { done } = await buffer.next();
		assert.equal(done, true);
	});

	test("error 拒绝待处理的 next", async () => {
		const buffer = new AsyncRowBuffer();
		const p = buffer.next();
		buffer.error(new Error("fail"));
		await assert.rejects(p, /fail/);
	});

	test("支持 Symbol.asyncIterator", () => {
		const buffer = new AsyncRowBuffer();
		assert.equal(buffer[Symbol.asyncIterator](), buffer);
	});

	test("空 buffer 的 for await 立即结束", async () => {
		const buffer = new AsyncRowBuffer();
		buffer.end();
		const results = [];
		for await (const v of buffer) {
			results.push(v);
		}
		assert.deepEqual(results, []);
	});

	test("end 后 push 不丢失已缓存的行", async () => {
		const buffer = new AsyncRowBuffer();
		buffer.push(1);
		buffer.push(2);
		buffer.end();
		buffer.push(3);

		const results = [];
		for await (const v of buffer) {
			results.push(v);
		}
		assert.deepEqual(results, [1, 2]);
	});

	test("error 后 push 不丢失已缓存的行", async () => {
		const buffer = new AsyncRowBuffer();
		buffer.push(1);
		buffer.error(new Error("fail"));

		const results = [];
		await assert.rejects(
			(async () => { for await (const v of buffer) results.push(v); })(),
			/fail/,
		);
		assert.deepEqual(results, [1]);
	});
});
