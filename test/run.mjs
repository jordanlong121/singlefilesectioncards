// Bundles main.ts with the obsidian API stubbed out, then runs the parser/sort cases.
import esbuild from "esbuild";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, ".tmp");
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}\n');

await esbuild.build({
	entryPoints: [path.join(here, "..", "main.ts")],
	bundle: true,
	format: "esm",
	outfile: path.join(tmp, "main.js"),
	logLevel: "error",
	alias: { obsidian: path.join(here, "obsidian-stub.mjs") },
});

await import(path.join(tmp, "..", "parse.cases.mjs"));
