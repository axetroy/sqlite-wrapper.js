import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "@rslib/core";

/** @param {string} dir */
function findAllDts(dir) {
	const results = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...findAllDts(fullPath));
		} else if (entry.name.endsWith(".d.ts")) {
			results.push(fullPath);
		}
	}
	return results;
}

class RspackDtsCopyPlugin {
	/**
	 *
	 * @param {import('@rspack/core').Compiler} compiler
	 */
	apply(compiler) {
		const projectDir = compiler.context;

		compiler.hooks.emit.tapPromise("RspackDtsCopyPlugin", async (compilation) => {
			const srcDir = path.join(projectDir, "src");
			const dtsFiles = findAllDts(srcDir);

			/** @param {string} filepath @param {boolean} isModule */
			const createSource = (filepath, isModule) => {
				let content = fs.readFileSync(filepath, "utf8");

				// 仅替换相对路径导入（./ 或 ../）中的 .js 后缀
				if (isModule) {
					content = content.replace(/(from\s+['"]\.\.?\/.+?)\.js(['"])/g, "$1.mts$2");
				} else {
					content = content.replace(/(from\s+['"]\.\.?\/.+?)\.js(['"])/g, "$1.cts$2");
				}

				return new compiler.webpack.sources.RawSource(content);
			};

			for (const absolutePath of dtsFiles) {
				const relativePath = path.relative(srcDir, absolutePath);
				const nameWithoutExt = relativePath.replace(/\.d\.ts$/, "");

				compilation.emitAsset("esm/" + nameWithoutExt + ".d.mts", createSource(absolutePath, true));
				compilation.emitAsset("cjs/" + nameWithoutExt + ".d.cts", createSource(absolutePath, false));
			}
		});
	}
}

export default defineConfig({
	source: {
		entry: {
			index: "src/index.js",
		},
	},
	lib: [
		{
			format: "esm",
			syntax: "es5",
			output: {
				sourceMap: true,
				filename: {
					js: "[name].mjs",
				},
				distPath: {
					js: "esm",
				},
			},
		},
		{
			format: "cjs",
			syntax: "es5",
			output: {
				sourceMap: true,
				filename: {
					js: "[name].cjs",
				},
				distPath: {
					js: "cjs",
				},
			},
		},
	],
	output: {
		target: "node",
	},
	tools: {
		rspack: {
			plugins: [new RspackDtsCopyPlugin()],
		},
	},
});
