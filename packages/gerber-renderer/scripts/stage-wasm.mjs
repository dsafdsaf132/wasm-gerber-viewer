import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(packageDir, "../../wasm/pkg");
const outputDir = resolve(packageDir, "wasm");
const files = [
  "wasm_gerber_processor.js",
  "wasm_gerber_processor_bg.wasm",
];

mkdirSync(outputDir, { recursive: true });

for (const file of files) {
  copyFileSync(resolve(sourceDir, file), resolve(outputDir, file));
}
