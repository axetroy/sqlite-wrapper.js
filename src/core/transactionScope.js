import { Queue } from "./queue.js";
import { settleTask } from "./settleUtils.js";

/**
 * 事务作用域管理器。
 *
 * 事务内的所有操作绑定到同一个 scopeId，保证不被外部任务交错。
 * 事务外的任务自动暂存到延迟队列，在事务结束后恢复执行。
 */
export class TransactionScope {
	#deferredQueue = new Queue();
	#activeScopeId = null;
	#scopeChain = Promise.resolve();

	/** 当前事务的作用域 ID，无事务时为 null。 */
	get scopeId() {
		return this.#activeScopeId;
	}

	/** 是否有事务正在执行。 */
	get active() {
		return this.#activeScopeId !== null;
	}

	/** 延迟队列中的待处理任务数。 */
	get pendingStatements() {
		return this.#deferredQueue.size;
	}

	/**
	 * 判断给定 scopeId 的任务是否应当延迟执行。
	 * @param {symbol | null} scopeId
	 * @returns {boolean}
	 */
	isDeferred(scopeId) {
		return this.#activeScopeId !== null && this.#activeScopeId !== scopeId;
	}

	/** 将任务放入延迟队列。 */
	defer(task) {
		this.#deferredQueue.enqueue(task);
	}

	/**
	 * 进入事务作用域。
	 * 返回 scopeId 和 release 函数，调用 release 后下一个等待的事务可以执行。
	 * @returns {Promise<{ scopeId: symbol, release: () => void }>}
	 */
	async enter() {
		const scopeId = Symbol("transaction");
		let release = null;
		const gate = new Promise((resolve) => { release = resolve; });

		const previous = this.#scopeChain;
		this.#scopeChain = previous.catch(() => {}).then(() => gate);
		await previous.catch(() => {});

		this.#activeScopeId = scopeId;
		return { scopeId, release };
	}

	/** 退出事务作用域。 */
	exit() {
		this.#activeScopeId = null;
	}

	/**
	 * 将延迟队列恢复到目标 Queue 的头部。
	 * @param {import("./queue.js").Queue} targetQueue
	 */
	restoreDeferred(targetQueue) {
		targetQueue.prependAll(this.#deferredQueue);
	}

	/**
	 * 拒绝所有延迟队列中的任务。
	 * @param {Error} error
	 */
	rejectAll(error) {
		let task = this.#deferredQueue.dequeue();
		while (task) {
			settleTask(task, error, undefined, null);
			task = this.#deferredQueue.dequeue();
		}
	}
}
