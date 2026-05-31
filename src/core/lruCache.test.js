import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { LRUCache } from "./lruCache.js";

describe("LRUCache", () => {
	test("get 未命中返回 undefined", () => {
		const c = new LRUCache({ maxSize: 3 });
		assert.equal(c.get("a"), undefined);
	});

	test("set/get 基本功能", () => {
		const c = new LRUCache({ maxSize: 3 });
		c.set("a", "1");
		assert.equal(c.get("a"), "1");
	});

	test("get 命中后推进 LRU 顺序", () => {
		const c = new LRUCache({ maxSize: 2 });
		c.set("a", "1");
		c.set("b", "2");
		c.get("a"); // 提升 a
		c.set("c", "3"); // 应淘汰 b
		assert.equal(c.get("a"), "1");
		assert.equal(c.get("b"), undefined);
		assert.equal(c.get("c"), "3");
	});

	test("淘汰最久未访问条目", () => {
		const c = new LRUCache({ maxSize: 2 });
		c.set("a", "1");
		c.set("b", "2");
		c.set("c", "3"); // 淘汰 a
		assert.equal(c.get("a"), undefined);
		assert.equal(c.get("b"), "2");
		assert.equal(c.get("c"), "3");
	});

	test("超长 key 不缓存", () => {
		const c = new LRUCache({ maxKeyLength: 5 });
		c.set("abcdef", "v");
		assert.equal(c.get("abcdef"), undefined);

		c.set("abcde", "v");
		assert.equal(c.get("abcde"), "v");
	});

	test("超长的 value 不缓存", () => {
		const c = new LRUCache({ maxValueLength: 5 });
		c.set("k", "abcdef");
		assert.equal(c.get("k"), undefined);

		c.set("k", "abcde");
		assert.equal(c.get("k"), "abcde");
	});

	test("非字符串 key 不缓存", () => {
		const c = new LRUCache({ maxSize: 3 });
		c.set(123, "v");
		assert.equal(c.get(123), undefined);
	});

	test("更新已存在的 key", () => {
		const c = new LRUCache({ maxSize: 3 });
		c.set("a", "1");
		c.set("a", "2");
		assert.equal(c.get("a"), "2");
	});

	test("size 返回正确条目数", () => {
		const c = new LRUCache({ maxSize: 3 });
		assert.equal(c.size, 0);
		c.set("a", "1");
		assert.equal(c.size, 1);
		c.set("b", "2");
		assert.equal(c.size, 2);
		c.set("c", "3");
		assert.equal(c.size, 3);
		c.set("d", "4"); // 淘汰 a
		assert.equal(c.size, 3);
	});

	test("clear 清空所有条目", () => {
		const c = new LRUCache({ maxSize: 3 });
		c.set("a", "1");
		c.set("b", "2");
		c.clear();
		assert.equal(c.size, 0);
		assert.equal(c.get("a"), undefined);
	});

	test("maxSize <= 0 自动提升为 1", () => {
		const c = new LRUCache({ maxSize: 0 });
		c.set("a", "1");
		assert.equal(c.get("a"), "1");
		c.set("b", "2");
		assert.equal(c.get("a"), undefined);
		assert.equal(c.get("b"), "2");
	});

	test("maxSize 1 的边界", () => {
		const c = new LRUCache({ maxSize: 1 });
		c.set("a", "1");
		assert.equal(c.get("a"), "1");
		c.set("b", "2");
		assert.equal(c.get("a"), undefined);
		assert.equal(c.get("b"), "2");
	});

	test("超长的数组 value 不缓存", () => {
		const c = new LRUCache({ maxValueLength: 3 });
		c.set("arr", [1, 2, 3, 4]); // 长度为 4 > 3
		assert.equal(c.get("arr"), undefined);

		c.set("arr2", [1, 2, 3]); // 长度为 3 == 3，应缓存
		assert.deepEqual(c.get("arr2"), [1, 2, 3]);
	});

	test("非数组对象的 value 即使超过 maxValueLength 也缓存", () => {
		const c = new LRUCache({ maxValueLength: 5 });
		const obj = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
		c.set("obj", obj);
		assert.equal(c.get("obj"), obj);
	});
});
