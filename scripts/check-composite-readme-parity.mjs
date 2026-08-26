import { readFile } from "node:fs/promises";

const repositoryRoot = new URL("../", import.meta.url);
const readmeNames = [
  "README.md",
  "README.kr.md",
  "README.zh-Hans.md",
  "README.zh-Hant.md",
];
const requiredCompositeConcepts = [
  "2–24",
  "Union",
  "Intersection",
  "Difference",
  "Select Visible Area",
  "source-coverage pattern",
  "composite-layers.js",
  "composite-layer-dialog.js",
  "composite.rs",
  "shaders/composite_*.frag.glsl",
  "[wasm/README.md](wasm/README.md)",
  "npm run validate:composite",
  "npm run benchmark:composite:4k:chrome",
  "500 ms",
  "100 ms",
];

const failures = [];
for (const readmeName of readmeNames) {
  const contents = await readFile(
    new URL(readmeName, repositoryRoot),
    "utf8",
  );
  const missing = requiredCompositeConcepts.filter(
    (concept) => !contents.includes(concept),
  );
  if (missing.length > 0) {
    failures.push(`${readmeName}: missing ${missing.join(", ")}`);
  }
}

if (failures.length > 0) {
  console.error("Composite README parity check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Composite README parity check passed (${readmeNames.length} files).`);
}
