import { spawn } from "node:child_process";
import { which } from "../which.js";

/**
 * 管理 sqlite3 子进程的生命周期。
 * 负责启动/stderr/stdin/stdout 管道配置，以及进程的终止与清理。
 */
export class ProcessManager {
	#binary;
	#database;
	#proc = null;

	/**
	 * @param {{ binary?: string, database?: string }} options
	 */
	constructor({ binary, database } = {}) {
		this.#binary = which(binary) ?? binary;
		this.#database = database;
	}

	get binary() {
		return this.#binary;
	}

	get process() {
		return this.#proc;
	}

	/**
	 * 启动 sqlite3 子进程。
	 * 使用 `-json` 模式启动，并为数据库文件启用 WAL 模式。
	 * @returns {import("node:child_process").ChildProcess}
	 */
	start() {
		const args = ["-json"];
		if (this.#database) args.push(this.#database);
		if (this.#database && this.#database !== ":memory:") {
			args.push("-cmd", "PRAGMA journal_mode=WAL;");
		}

		const proc = spawn(this.#binary, args, {
			stdio: "pipe",
			shell: false,
			windowsHide: true,
		});

		proc.stdin.setDefaultEncoding("utf-8");
		proc.stdout.setEncoding("utf-8");
		proc.stderr.setEncoding("utf-8");

		this.#proc = proc;
		return proc;
	}

	/**
	 * 向子进程的 stdin 写入数据。
	 * @param {string} data
	 */
	write(data) {
		this.#proc?.stdin.write(data);
	}

	/**
	 * 终止子进程并清理所有监听器与管道。
	 * @returns {import("node:child_process").ChildProcess | null} 被终止的进程引用（如果没有正在运行的进程则为 null）
	 */
	kill() {
		const proc = this.#proc;
		if (!proc) return null;
		this.#proc = null;
		proc.stdout.removeAllListeners();
		proc.stderr.removeAllListeners();
		proc.removeAllListeners();
		proc.stdin.destroy();
		proc.kill();
		return proc;
	}
}
