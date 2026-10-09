import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "wasm_gerber_processor.js",
  "wasm_gerber_processor_bg.wasm",
];

for (const [source, destination] of [["pkg", "wasm"], ["pkg64", "wasm/pkg64"]]) {
  const sourceDir = resolve(packageDir, "../../wasm", source);
  const outputDir = resolve(packageDir, destination);
  mkdirSync(outputDir, { recursive: true });
  for (const file of files) {
    copyFileSync(resolve(sourceDir, file), resolve(outputDir, file));
  }
}
