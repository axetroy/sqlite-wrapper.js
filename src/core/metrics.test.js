import assert from "node:assert/strict";
import test from "node:test";

import { Metrics } from "./metrics.js";

test("初始值全部为零", () => {
	const m = new Metrics();
	const s = m.snapshot();
	assert.equal(s.tasksTotal, 0);
	assert.equal(s.tasksSuccess, 0);
	assert.equal(s.tasksFailed, 0);
	assert.equal(s.tasksTimeout, 0);
	assert.equal(s.processRestarts, 0);
	assert.equal(s.executeCount, 0);
	assert.equal(s.queryCount, 0);
	assert.equal(s.streamCount, 0);
	assert.equal(s.avgTaskDuration, 0);
});

test("初始 throughput 和 uptime 非负", () => {
	const m = new Metrics();
	const s = m.snapshot();
	assert.ok(s.throughput >= 0);
	assert.ok(s.uptime >= 0);
});

test("incrementTasksTotal 增加总数和分类计数", () => {
	const m = new Metrics();
	m.incrementTasksTotal("execute");
	m.incrementTasksTotal("query");
	m.incrementTasksTotal("query");
	m.incrementTasksTotal("stream");
	assert.equal(m.snapshot().tasksTotal, 4);
	assert.equal(m.executeCount, 1);
	assert.equal(m.queryCount, 2);
	assert.equal(m.streamCount, 1);
});

test("incrementTasksSuccess 记录成功数和累积耗时", () => {
	const m = new Metrics();
	m.incrementTasksSuccess(100);
	m.incrementTasksSuccess(200);
	assert.equal(m.snapshot().tasksSuccess, 2);
	assert.equal(m.totalDuration, 300);
	assert.equal(m.snapshot().avgTaskDuration, 150);
});

test("incrementTasksFailed 增加失败数", () => {
	const m = new Metrics();
	m.incrementTasksFailed();
	m.incrementTasksFailed();
	assert.equal(m.snapshot().tasksFailed, 2);
});

test("incrementTasksTimeout 增加超时数", () => {
	const m = new Metrics();
	m.incrementTasksTimeout();
	assert.equal(m.snapshot().tasksTimeout, 1);
});

test("incrementProcessRestarts 增加重启数", () => {
	const m = new Metrics();
	m.incrementProcessRestarts();
	m.incrementProcessRestarts();
	assert.equal(m.snapshot().processRestarts, 2);
});

test("snapshot 返回不可变快照（每次新对象）", () => {
	const m = new Metrics();
	const s1 = m.snapshot();
	m.incrementTasksTotal("query");
	const s2 = m.snapshot();
	assert.equal(s1.tasksTotal, 0);
	assert.equal(s2.tasksTotal, 1);
	assert.notStrictEqual(s1, s2);
});

test("多个 Metrics 实例互不干扰", () => {
	const a = new Metrics();
	const b = new Metrics();
	a.incrementTasksTotal("query");
	b.incrementTasksTotal("execute");
	b.incrementTasksTotal("execute");
	assert.equal(a.snapshot().tasksTotal, 1);
	assert.equal(b.snapshot().tasksTotal, 2);
	assert.equal(a.queryCount, 1);
	assert.equal(b.executeCount, 2);
});

test("avgTaskDuration 在无成功任务时返回 0", () => {
	const m = new Metrics();
	m.incrementTasksFailed();
	assert.equal(m.snapshot().avgTaskDuration, 0);
});

test("throughput 不严格验证计算", () => {
	const m = new Metrics();
	m.incrementTasksTotal("query");
	m.incrementTasksTotal("query");
	const s = m.snapshot();
	assert.ok(s.throughput >= 0);
	assert.ok(s.throughput === 0 || s.throughput > 0);
});

test("getter 与 snapshot 值一致", () => {
	const m = new Metrics();
	m.incrementTasksTotal("execute");
	m.incrementTasksSuccess(50);
	m.incrementTasksFailed();
	m.incrementTasksTimeout();
	m.incrementProcessRestarts();
	const s = m.snapshot();
	assert.equal(m.tasksTotal, s.tasksTotal);
	assert.equal(m.tasksSuccess, s.tasksSuccess);
	assert.equal(m.tasksFailed, s.tasksFailed);
	assert.equal(m.tasksTimeout, s.tasksTimeout);
	assert.equal(m.processRestarts, s.processRestarts);
	assert.equal(m.executeCount, s.executeCount);
	assert.equal(m.queryCount, s.queryCount);
	assert.equal(m.streamCount, s.streamCount);
});
