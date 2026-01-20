import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { which } from "./which.js";

const isWindows = os.platform() === "win32";

describe("which", () => {
	test("returns null for empty command", () => {
		assert.equal(which(""), null);
	});

	test("finds executable by absolute path", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-path-"));
		const filename = isWindows ? "tool.cmd" : "tool";
		const filePath = path.join(tmpDir, filename);

		fs.writeFileSync(filePath, "echo test\n");
		if (!isWindows) fs.chmodSync(filePath, 0o755);

		try {
			const resolved = which(filePath);
			assert.equal(resolved, path.resolve(filePath));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("finds executable from PATH", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "which-path-"));
		const name = "my-tool";
		const filename = isWindows ? `${name}.cmd` : name;
		const filePath = path.join(tmpDir, filename);
		const originalPath = process.env.PATH;

		fs.writeFileSync(filePath, "echo from path\n");
		if (!isWindows) fs.chmodSync(filePath, 0o755);
		process.env.PATH = `${tmpDir}${path.delimiter}${originalPath || ""}`;

		try {
			const resolved = which(name);
			assert.equal(resolved, filePath);
		} finally {
			process.env.PATH = originalPath;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("returns null when command not found", () => {
		const originalPath = process.env.PATH;
		process.env.PATH = "";

		try {
			assert.equal(which("definitely-not-exist"), null);
		} finally {
			process.env.PATH = originalPath;
		}
	});
});
