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
	#writeBuffer = "";
	#draining = false;

	/**
	 * @param {{ binary?: string, database?: string, initMode?: "wal" | "none" }} options
	 */
	constructor({ binary, database, initMode = "wal" } = {}) {
		this.#binary = which(binary) ?? binary;
		this.#database = database;
		this.#initMode = initMode;
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
	 * 当底层管道的写缓冲区满时（Windows 上管道缓冲区仅 4KB），
	 * Node.js 的 write() 返回 false。此时将数据暂存在 #writeBuffer 中，
	 * 等待 drain 事件触发后继续写入，以避免管道死锁。
	 * @param {string} data
	 */
	write(data) {
		const stream = this.#proc?.stdin;
		if (!stream) return;

		if (this.#draining) {
			this.#writeBuffer += data;
			return;
		}

		const ok = stream.write(data);
		if (!ok) {
			this.#draining = true;
			this.#writeBuffer += data;
			stream.once("drain", () => {
				this.#draining = false;
				const buf = this.#writeBuffer;
				this.#writeBuffer = "";
				if (buf) this.write(buf);
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
			this.kill();
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
		this.#writeBuffer = "";
		this.#draining = false;
		proc.stdout?.removeAllListeners();
		proc.stderr?.removeAllListeners();
		proc.removeAllListeners();
		proc.stdin?.destroy();
		proc.kill();
		return proc;
	}
}
