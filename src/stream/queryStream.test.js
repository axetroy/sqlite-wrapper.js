import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { setupStreamParser, createRowStreamParser } from "./queryStream.js";

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
});

describe("createRowStreamParser 重新导出", () => {
	test("与 core/parser 中的导出一致", async () => {
		const { createRowStreamParser: original } = await import("../core/parser.js");
		assert.equal(createRowStreamParser, original);
	});
});
