import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { which } from "../which.js";

/** @type {number} */
const GRACEFUL_SHUTDOWN_TIMEOUT = 5_000;

/**
 * 管理 sqlite3 子进程的生命周期。
 * 负责启动/stderr/stdin/stdout 管道配置，以及进程的终止与清理。
 */
export class ProcessManager {
	#binary;
	#database;
	#proc = null;
	#initMode;
	#draining = false;
	#onDrain;

	/**
	 * @param {{ binary?: string, database?: string, initMode?: "wal" | "none", onDrain?: () => void }} options
	 */
	constructor({ binary, database, initMode = "wal", onDrain } = {}) {
		this.#binary = which(binary) ?? binary;
		this.#database = database;
		this.#initMode = initMode;
		this.#onDrain = onDrain ?? (() => {});
	}

	/** drain 状态为 true 时表示 OS pipe 已满，应暂停写入 stdin。 */
	get draining() {
		return this.#draining;
	}

	/** 注册 drain 回调，当 pipe 重新可写时被调用。 */
	setOnDrainCallback(fn) {
		this.#onDrain = fn;
	}

	get binary() {
		return this.#binary;
	}

	get process() {
		return this.#proc;
	}

	/**
	 * 启动 sqlite3 子进程。
	 * 使用 `-json` 模式启动。
	 * 对于文件数据库，initMode="wal" 时自动启用 WAL 模式 + busy_timeout。
	 * @returns {import("node:child_process").ChildProcess}
	 */
	start() {
		if (!this.#binary) {
			throw new Error("sqlite3 binary path is empty. Provide a valid --binary / binary option.");
		}
		if (!fs.existsSync(this.#binary)) {
			throw new Error(`sqlite3 binary not found: ${this.#binary}. Make sure sqlite3 is installed or provide a valid --binary / binary option.`);
		}

		const args = ["-json"];
		if (this.#database) args.push(this.#database);
		if (this.#database && this.#database !== ":memory:" && this.#initMode === "wal") {
			args.push("-cmd", "PRAGMA journal_mode=WAL;");
			args.push("-cmd", "PRAGMA busy_timeout=5000;");
		}

		const proc = spawn(this.#binary, args, {
			stdio: "pipe",
			shell: false,
			windowsHide: true,
		});

		proc.stdin?.setDefaultEncoding("utf-8");
		proc.stdout?.setEncoding("utf-8");
		proc.stderr?.setEncoding("utf-8");

		this.#proc = proc;
		return proc;
	}

	/**
	 * 向子进程的 stdin 写入数据。
	 *
	 * 当 OS pipe 满时 `stream.write()` 返回 false，此刻：
	 * - 设置 `#draining = true`，阻止后续写入（#pumpQueue 会在顶部检查 draining）
	 * - 任务保留在队列中（不进入 inflight、不计时器），等 drain 事件后通过回调恢复发送
	 * - OS pipe 一有空余，drain 事件触发 → 清 draining → 调用 #onDrain → #pumpQueue 重新发送
	 *
	 * 这样就彻底避免了 OS pipe 满导致 sqlite3 写 stdout 阻塞 → 无法读 stdin → 所有 inflight 饿死。
	 * 管道的实际容量（Windows 4KB / Unix 64KB）不再重要 —— 写入自动节流。
	 *
	 * @param {string} data
	 */
	write(data) {
		const stream = this.#proc?.stdin;
		if (!stream) return;
		if (this.#draining) return;

		if (!stream.write(data)) {
			this.#draining = true;
			stream.once("drain", () => {
				this.#draining = false;
				this.#onDrain();
			});
		}
	}

	/**
	 * 优雅关闭：向子进程发送 ".quit" 命令并等待其自行退出。
	 * 如果在超时时间内未退出，则强制 kill。
	 * @returns {Promise<void>}
	 */
	async gracefulShutdown() {
		const proc = this.#proc;
		if (!proc) return;

		const timer = setTimeout(() => {
			proc.kill();
		}, GRACEFUL_SHUTDOWN_TIMEOUT);

		try {
			proc.stdin?.write(".quit\n");
			await once(proc, "close");
		} catch {
			// 进程可能已被清理，忽略
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * 终止子进程并清理所有监听器与管道。
	 * @returns {import("node:child_process").ChildProcess | null} 被终止的进程引用（如果没有正在运行的进程则为 null）
	 */
	kill() {
		const proc = this.#proc;
		if (!proc) return null;
		this.#proc = null;
		this.#draining = false;
		proc.stdout?.removeAllListeners();
		proc.stderr?.removeAllListeners();
		proc.removeAllListeners();
		proc.stdin?.destroy();
		proc.kill();
		return proc;
	}
}
