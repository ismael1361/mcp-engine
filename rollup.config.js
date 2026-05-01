const resolve = require("@rollup/plugin-node-resolve");
const commonjs = require("@rollup/plugin-commonjs");
const typescript = require("@rollup/plugin-typescript");
const terser = require("@rollup/plugin-terser");
const json = require("@rollup/plugin-json");
const current_package = require("./package.json");

const dependencies = Object.keys(current_package?.dependencies || {});

module.exports = {
	input: "src/index.ts",
	output: [
		{
			format: "cjs",
			sourcemap: true,
			dir: "dist", // gera múltiplos arquivos em dist/cjs
			preserveModules: true, // <-- gera 1 arquivo por módulo
			preserveModulesRoot: "src", // <-- remove o prefixo 'src' nos caminhos
			entryFileNames: "[name].js", // mantém nome do arquivo (ex: foo/bar.js)
		},
		{
			dir: "dist", // gera múltiplos arquivos em dist/esm
			format: "esm",
			preserveModules: true,
			preserveModulesRoot: "src",
			entryFileNames: "[name].esm.js",
			sourcemap: true,
		},
	],
	plugins: [
		resolve({
			preferBuiltins: false,
		}),
		commonjs(),
		json(),
		typescript({
			tsconfig: "./tsconfig.json",
			sourceMap: true,
		}),
		// terser(),
	],
	external: dependencies,
};
