import { spawn } from "node:child_process";
import { EOL } from "node:os";
import readline from "node:readline";

export class SQLiteWrapper {
	/**
	 *
	 * @param {string} sqlite3ExePath
	 * @param {import('./index').SQLiteWrapperOptions} param1
	 */
	constructor(sqlite3ExePath, { dbPath, logger } = {}) {
		this.queue = [];
		this.current = null;
		this.closed = false;
		this.buffer = "";
		this.stderrBuffer = "";
		this.logger = logger;

		this.proc = spawn(sqlite3ExePath, dbPath ? [dbPath] : [], { stdio: "pipe" });

		this.rl = readline.createInterface({
			input: this.proc.stdout,
			terminal: false,
		});

		this.proc.stderr.on("data", (data) => {
			this.stderrBuffer += data.toString();
		});

		this.rl.on("line", (line) => {
			const trimmed = line.trim();

			if (trimmed === `[{"'__END__'":"__END__"}]` || trimmed === "__END__") {
				const result = this.buffer.trim();
				const error = this.stderrBuffer.trim();
				this.buffer = "";
				this.stderrBuffer = "";
				if (this.current) {
					if (error) {
						this.current.reject(new Error(error));
					} else {
						this.current.resolve(result);
					}
					this.current = null;
					this.#processQueue();
				}
			} else {
				this.buffer += line + EOL;
			}
		});

		this.proc.on("error", (error) => {
			this.closed = true;
			if (this.current) {
				this.current.reject(new Error("sqlite3 process error: " + error.message));
				this.current = null;
			}
		});

		this.proc.on("close", () => {
			this.closed = true;
			if (this.current) {
				this.current.reject(new Error("sqlite3 process closed unexpectedly"));
				this.current = null;
			}
		});
	}

	async #execSQL(sql, params = []) {
		if (!Array.isArray(params)) {
			throw new Error("Query parameters must be an array");
		}

		let index = 0;
		const finalSQL = sql.replace(/\?/g, () => {
			if (index >= params.length) throw new Error("Too few parameters provided");
			return SQLiteWrapper.#escape(params[index++]);
		});

		return new Promise((resolve, reject) => {
			this.queue.push({ sql: finalSQL, resolve, reject, raw: false });
			if (!this.current) this.#processQueue();
		});
	}

	async #execCommand(command) {
		return new Promise((resolve, reject) => {
			this.queue.push({
				sql: command,
				resolve,
				reject,
				raw: true,
			});

			if (!this.current) this.#processQueue();
		});
	}

	#processQueue() {
		if (this.closed || this.current || this.queue.length === 0) return;
		this.current = this.queue.shift();

		const trimmedSQL = this.current.sql.trim();

		this.logger?.debug("Executing SQL:", trimmedSQL);

		const isNeedsSemicolon = !trimmedSQL.endsWith(";");

		const endSignal = "SELECT '__END__';" + EOL;

		if (this.current.raw) {
			this.proc.stdin.write(trimmedSQL + EOL);
			this.proc.stdin.write(endSignal);
		} else {
			const toSend = trimmedSQL + (isNeedsSemicolon ? ";" : "");
			this.proc.stdin.write(toSend + EOL);
			this.proc.stdin.write(endSignal);
		}
	}

	/**
	 *
	 * @param {string} value
	 * @returns {string}
	 */
	static #escape(value) {
		if (typeof value === "string") {
			return `'${value.replace(/'/g, "''")}'`; // Escape single quotes
		}

		if (value === null || value === undefined) return "NULL";

		if (typeof value === "number" || typeof value === "bigint") return value.toString();

		throw new Error("Unsupported parameter type: " + typeof value);
	}

	async exec(sql, params = []) {
		return this.#execSQL(sql, params);
	}

	async query(sql, params = []) {
		await this.#execCommand(".mode json");

		const result = await this.#execSQL(sql, params);
		try {
			return JSON.parse(result);
		} catch (error) {
			throw new Error("Invalid JSON from sqlite3: " + error.message);
		}
	}

	async queryOne(sql, params = []) {
		const rows = await this.query(sql, params);

		if (rows.length === 0) return null;

		if (rows.length > 1) throw new Error("Query returned more than one row");

		return rows[0];
	}

	async close() {
		this.proc.stdin.end();
		this.closed = true;
	}
}
