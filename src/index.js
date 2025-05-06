import { spawn } from "node:child_process";
import { EOL } from "node:os";
import readline from "node:readline";

export class SQLiteWrapper {
	constructor(exePath = "sqlite3.exe", dbPath) {
		this.exePath = exePath;
		this.dbPath = dbPath;
		this.queue = [];
		this.current = null;
		this.closed = false;
		this.buffer = "";
		this.stderrBuffer = "";

		this.proc = spawn(this.exePath, this.dbPath ? [this.dbPath] : [], { stdio: "pipe" });

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

		this.proc.on("close", () => {
			this.closed = true;
			if (this.current) {
				this.current.reject(new Error("sqlite3 process closed unexpectedly"));
				this.current = null;
			}
		});
	}

	async #execSQL(sql) {
		return new Promise((resolve, reject) => {
			this.queue.push({ sql, resolve, reject, raw: false });
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

		const trimmed = this.current.sql.trim();
		const isNeedsSemicolon = !trimmed.endsWith(";");

		if (this.current.raw) {
			// Shell command: don't append SELECT
			this.proc.stdin.write(trimmed + EOL);
			this.proc.stdin.write("SELECT '__END__';" + EOL);
		} else {
			const toSend = trimmed + (isNeedsSemicolon ? ";" : "") + EOL + "SELECT '__END__';" + EOL;
			this.proc.stdin.write(toSend);
		}
	}

	async exec(sql) {
		return this.#execSQL(sql);
	}

	async query(sql) {
		await this.#execCommand(".mode json");

		const result = await this.#execSQL(sql);
		try {
			return JSON.parse(result);
		} catch (error) {
			throw new Error("Invalid JSON from sqlite3: " + error.message);
		}
	}

	async close() {
		this.proc.stdin.end();
		this.closed = true;
	}
}
