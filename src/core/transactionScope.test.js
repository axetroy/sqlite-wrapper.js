import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { Queue } from "./queue.js";
import { TransactionScope } from "./transactionScope.js";

describe("TransactionScope", () => {
	test("初始状态 scopeId 为 null，active 为 false，pendingStatements 为 0", () => {
		const scope = new TransactionScope();
		assert.equal(scope.scopeId, null);
		assert.equal(scope.active, false);
		assert.equal(scope.pendingStatements, 0);
	});

	test("enter 返回 scopeId 和 release，激活作用域", async () => {
		const scope = new TransactionScope();
		const result = await scope.enter();

		assert.ok(typeof result.scopeId === "symbol");
		assert.ok(typeof result.release === "function");
		assert.equal(scope.active, true);
		assert.equal(scope.scopeId, result.scopeId);
	});

	test("exit 清除作用域", async () => {
		const scope = new TransactionScope();
		await scope.enter();
		scope.exit();

		assert.equal(scope.scopeId, null);
		assert.equal(scope.active, false);
	});

	test("isDeferred 在无事务时始终返回 false", () => {
		const scope = new TransactionScope();
		assert.equal(scope.isDeferred(null), false);
		assert.equal(scope.isDeferred(Symbol("x")), false);
	});

	test("isDeferred 在事务内对外部 scopeId 返回 true，对当前 scopeId 返回 false", async () => {
		const scope = new TransactionScope();
		const { scopeId } = await scope.enter();

		assert.equal(scope.isDeferred(scopeId), false);
		assert.equal(scope.isDeferred(null), true);
		assert.equal(scope.isDeferred(Symbol("other")), true);
	});

	test("defer 增加 pendingStatements", async () => {
		const scope = new TransactionScope();
		await scope.enter();

		scope.defer({ id: 1 });
		assert.equal(scope.pendingStatements, 1);

		scope.defer({ id: 2 });
		assert.equal(scope.pendingStatements, 2);
	});

	test("restoreDeferred 将任务恢复到目标队列头部", async () => {
		const scope = new TransactionScope();
		await scope.enter();

		scope.defer({ id: "a" });
		scope.defer({ id: "b" });
		scope.exit();

		const target = new Queue();
		target.enqueue({ id: "existing" });
		scope.restoreDeferred(target);

		const items = [...target];
		assert.equal(items.length, 3);
		assert.equal(items[0].id, "a");
		assert.equal(items[1].id, "b");
		assert.equal(items[2].id, "existing");
	});

	test("restoreDeferred 在无延迟任务时不清空目标队列", () => {
		const scope = new TransactionScope();
		const target = new Queue();
		target.enqueue({ id: "x" });
		scope.restoreDeferred(target);
		assert.equal(target.size, 1);
	});

	test("rejectAll 拒绝所有延迟任务", async () => {
		const scope = new TransactionScope();
		await scope.enter();

		const rejected = [];
		scope.defer({ id: 1, reject: (err) => rejected.push(err) });
		scope.defer({ id: 2, reject: (err) => rejected.push(err) });

		const err = new Error("tx failed");
		scope.rejectAll(err);

		assert.equal(rejected.length, 2);
		assert.equal(rejected[0], err);
		assert.equal(rejected[1], err);
		assert.equal(scope.pendingStatements, 0);
	});

	test("rejectAll 在空队列时不报错", () => {
		const scope = new TransactionScope();
		scope.rejectAll(new Error("noop"));
	});

	test("第二次 enter 等待第一次 release 后才激活", async () => {
		const scope = new TransactionScope();
		const order = [];

		const p1 = scope.enter().then(async ({ release }) => {
			order.push("enter1");
			await new Promise((r) => setTimeout(r, 10));
			order.push("release1");
			release();
		});

		const p2 = scope.enter().then(({ release }) => {
			order.push("enter2");
			release();
		});

		await Promise.all([p1, p2]);
		assert.deepEqual(order, ["enter1", "release1", "enter2"]);
	});

	test("enter/exit 可重复使用", async () => {
		const scope = new TransactionScope();

		const r1 = await scope.enter().then(({ scopeId, release }) => {
			assert.ok(typeof scopeId === "symbol");
			assert.equal(scope.active, true);
			scope.exit();
			assert.equal(scope.active, false);
			return release;
		});
		r1();

		const r2 = await scope.enter().then(({ scopeId, release }) => {
			assert.ok(typeof scopeId === "symbol");
			assert.equal(scope.active, true);
			scope.exit();
			assert.equal(scope.active, false);
			return release;
		});
		r2();
	});
});
