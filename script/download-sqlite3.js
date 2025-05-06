import AdmZip from "adm-zip";
import axios from "axios";
import fs from "fs";
import path, { join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = join(__dirname, "..");

async function downloadFileWithProgress(url, outputPath) {
	const writer = fs.createWriteStream(outputPath);

	const { data, headers } = await axios({
		method: "get",
		url: url,
		responseType: "stream",
	});

	const totalLength = headers["content-length"];
	let downloadedLength = 0;
	let lastPercent = 0;

	data.on("data", (chunk) => {
		downloadedLength += chunk.length;
		const percent = Math.floor((downloadedLength / totalLength) * 100);

		// 避免频繁打印
		if (percent !== lastPercent && percent % 5 === 0) {
			process.stdout.write(`下载进度: ${percent}%\r`);
			lastPercent = percent;
		}
	});

	data.pipe(writer);

	return new Promise((resolve, reject) => {
		writer.on("finish", () => {
			process.stdout.write("\n");
			resolve();
		});
		writer.on("error", reject);
	});
}

function getSQLte3URL() {
	switch (process.platform) {
		case "win32": {
			return "https://www.sqlite.org/2025/sqlite-tools-win-x64-3490100.zip";
		}
		case "darwin": {
			return "https://www.sqlite.org/2025/sqlite-tools-osx-x64-3490100.zip";
		}
		case "linux": {
			return "https://www.sqlite.org/2025/sqlite-tools-linux-x64-3490100.zip";
		}
		default: {
			throw new Error("Unsupported platform: " + process.platform);
		}
	}
}

async function main() {
	const sqlite3ToolZip = join(ROOT, "bin", "sqlite3-tool.zip");
	const sqlite3Path = join(ROOT, "bin", "sqlite3" + (process.platform === "win32" ? ".exe" : ""));

	if (fs.existsSync(sqlite3Path)) {
		console.log("SQLite3 already exists, skipping download.");
		return;
	}

	console.log("Downloading SQLite3...");

	const url = getSQLte3URL();

	await downloadFileWithProgress(url, sqlite3ToolZip).catch((error) => {
		fs.rmSync(sqlite3ToolZip, { force: true });
		throw error;
	});

	console.log("SQLite3 downloaded successfully.");

	const zip = new AdmZip(sqlite3ToolZip);

	zip.extractAllTo(join(ROOT, "bin"), true);

	if (process.platform !== "win32") {
		// 赋予执行权限
		fs.chmodSync(sqlite3Path, 0o755);
	}

	console.log("Setting up SQLite3...");
}

main().catch((error) => {
	console.error(error);

	process.exit(1);
});
