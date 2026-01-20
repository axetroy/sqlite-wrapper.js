import fs from "fs";
import path from "path";
import os from "os";

const isWindows = os.platform() === "win32";

/**
 * 判断文件是否可执行
 */
function isExecutable(filePath) {
	try {
		if (isWindows) {
			// Windows：只要文件存在即可（是否可执行由扩展名判断）
			return fs.statSync(filePath).isFile();
		} else {
			fs.accessSync(filePath, fs.constants.X_OK);
			return true;
		}
	} catch {
		return false;
	}
}

/**
 * 获取 Windows 下的可执行扩展名
 */
function getPathExts() {
	if (!isWindows) return [""];
	const ext = process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM;.PS1";
	return ext.split(";").map((e) => e.toLowerCase());
}

/**
 * which 实现
 * @param {string} command
 * @returns {string|null}
 */
export function which(command) {
	if (!command) return null;

	const pathExts = getPathExts();

	// 如果 command 本身包含路径
	if (command.includes(path.sep)) {
		const fullPath = path.resolve(command);

		if (isWindows) {
			// Windows：需要尝试补全扩展名
			if (path.extname(fullPath)) {
				return isExecutable(fullPath) ? fullPath : null;
			}

			for (const ext of pathExts) {
				const file = fullPath + ext;
				if (isExecutable(file)) return file;
			}
		} else {
			return isExecutable(fullPath) ? fullPath : null;
		}

		return null;
	}

	// 从 PATH 中查找
	const envPath = process.env.PATH || "";
	const pathDirs = envPath.split(path.delimiter);

	for (const dir of pathDirs) {
		if (!dir) continue;

		if (isWindows) {
			for (const ext of pathExts) {
				const file = path.join(dir, command + ext);
				if (isExecutable(file)) return file;
			}
		} else {
			const file = path.join(dir, command);
			if (isExecutable(file)) return file;
		}
	}

	return null;
}
