import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { escapeValue } from "./escape.js";

describe("escapeValue", () => {
	test("转义含单引号的字符串", () => {
		assert.equal(escapeValue("O'Brien"), "'O''Brien'");
	});

	test("支持 null 和 undefined", () => {
		assert.equal(escapeValue(null), "NULL");
		assert.equal(escapeValue(undefined), "NULL");
	});

	test("支持数字和 bigint", () => {
		assert.equal(escapeValue(123), "123");
		assert.equal(escapeValue(123n), "123");
	});

	test("支持布尔值", () => {
		assert.equal(escapeValue(true), "TRUE");
		assert.equal(escapeValue(false), "FALSE");
	});

	test("支持 Date 值", () => {
		const date = new Date("2024-01-15T10:30:00.000Z");
		assert.equal(escapeValue(date), "'2024-01-15T10:30:00.000Z'");
	});

	test("不支持的类型时抛出错误", () => {
		assert.throws(() => escapeValue(Symbol("x")), /Unsupported parameter type/);
	});

	test("空字符串正确转义", () => {
		assert.equal(escapeValue(""), "''");
	});

	test("含换行和制表符的字符串", () => {
		assert.equal(escapeValue("line1\nline2\tend"), "'line1\nline2\tend'");
	});

	test("含反斜杠的字符串", () => {
		assert.equal(escapeValue("path\\to\\file"), "'path\\to\\file'");
	});

	test("unicode 字符串", () => {
		assert.equal(escapeValue("hello 世界"), "'hello 世界'");
	});
});
