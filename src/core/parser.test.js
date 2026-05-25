import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { toError, createJsonValueParser, createRowStreamParser } from "./parser.js";

describe("toError", () => {
	test("原样返回 Error 实例", () => {
		const err = new Error("test");
		assert.equal(toError(err), err);
	});

	test("将非 Error 值包装为 Error", () => {
		const err = toError("something went wrong");
		assert.ok(err instanceof Error);
		assert.ok(err.message.includes("something went wrong"));
	});
});

describe("createJsonValueParser", () => {
	test("解析单行 JSON 对象", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"id":1,"name":"Alice"}\n{"id":2}');
		assert.equal(values.length, 2);
		assert.equal(values[0], '{"id":1,"name":"Alice"}');
		assert.equal(values[1], '{"id":2}');
	});

	test("解析 JSON 数组", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('[1,2,3]');
		assert.equal(values.length, 1);
		assert.equal(values[0], '[1,2,3]');
	});

	test("嵌套对象正确处理", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"nested":{"a":1,"b":[2,3]}}');
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"nested":{"a":1,"b":[2,3]}}');
	});

	test("字符串内的大括号不会被当成嵌套", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"msg":"hello {world}"}');
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"msg":"hello {world}"}');
	});

	test("字符串内的转义引号正确处理", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"msg":"he said \\"hi\\""}');
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"msg":"he said \\"hi\\""}');
	});

	test("分块输入累积解析", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"a"');
		assert.equal(values.length, 0, "首次分块不应产生完整值");
		parser.feed(':1}');
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"a":1}');
	});

	test("多次分块累积解析", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"a"');
		parser.feed(':1,"b"');
		parser.feed(':2}');
		assert.equal(values.length, 1);
		assert.equal(values[0], '{"a":1,"b":2}');
	});

	test("reset 重置状态", () => {
		const values = [];
		const parser = createJsonValueParser((raw) => values.push(raw));
		parser.feed('{"id":1}');
		assert.equal(values.length, 1);
		parser.reset();
		parser.feed('{"id":2}');
		assert.equal(values.length, 2);
		assert.equal(values[1], '{"id":2}');
	});
});

describe("createRowStreamParser", () => {
	test("流式解析数组元素", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"id":1},{"id":2}]');
		assert.equal(rows.length, 2);
		assert.equal(rows[0], '{"id":1}');
		assert.equal(rows[1], '{"id":2}');
	});

	test("解析后返回剩余数据", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		const leftover = parser.feed('[{"id":1}] extra');
		assert.equal(rows.length, 1);
		assert.equal(leftover, " extra");
	});

	test("分块输入逐步解析", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"id"');
		assert.equal(rows.length, 0);
		parser.feed(':1},{"id"');
		assert.equal(rows.length, 1, "第二个分块完成后第一个元素应被解析");
		assert.equal(rows[0], '{"id":1}');
		parser.feed(':2}]');
		assert.equal(rows.length, 2);
		assert.equal(rows[1], '{"id":2}');
	});

	test("空数组触发 finished", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		const leftover = parser.feed('[]');
		assert.equal(rows.length, 0);
		assert.equal(parser.finished, true);
	});

	test("finished 后 feed 直接返回输入数据", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"id":1}]');
		assert.equal(parser.finished, true);
		const result = parser.feed('trailing');
		assert.equal(result, 'trailing');
	});

	test("嵌套数组作为元素", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[[1,2],[3,4]]');
		assert.equal(rows.length, 2);
		assert.equal(rows[0], '[1,2]');
		assert.equal(rows[1], '[3,4]');
	});

	test("reset 重置所有状态", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"id":1}]');
		assert.equal(parser.finished, true);
		parser.reset();
		assert.equal(parser.finished, false);
		assert.equal(parser.started, false);
		parser.feed('[{"id":2}]');
		assert.equal(rows.length, 2);
		assert.equal(rows[1], '{"id":2}');
	});

	test("对象元素内的字符串转义不影响嵌套计数", () => {
		const rows = [];
		const parser = createRowStreamParser((raw) => rows.push(raw));
		parser.feed('[{"msg":"hello \\"world\\""},{"msg":"ok"}]');
		assert.equal(rows.length, 2);
		assert.equal(rows[0], '{"msg":"hello \\"world\\""}');
		assert.equal(rows[1], '{"msg":"ok"}');
	});
});
