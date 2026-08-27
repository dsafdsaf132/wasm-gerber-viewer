import { readFile } from "node:fs/promises";

const repositoryRoot = new URL("../", import.meta.url);
const readmeNames = [
  "README.md",
  "README.kr.md",
  "README.zh-Hans.md",
  "README.zh-Hant.md",
];
const rendererPackageRoot = new URL(
  "packages/wasm-gerber-renderer/",
  repositoryRoot,
);
const rendererReadmeNames = [...readmeNames];
const requiredCompositeConcepts = [
  "Union",
  "Intersection",
  "Difference",
  "composite-layers.js",
  "composite-layer-dialog.js",
  "composite.rs",
  "shaders/composite_*.frag.glsl",
  "[wasm/README.md](wasm/README.md)",
];
const requiredRendererConcepts = [
  "renderCompositeLayer",
  "CompositeLayerOptions",
  "visibleAreas",
  "outlineLayerId",
  "--composite-config",
  "hiddenSources",
  "2–24",
  '"union"',
  '"intersection"',
  '"difference"',
  '"000"',
  "blend",
  "stack",
];
const requiredSkillConcepts = [
  "renderCompositeLayer",
  "--composite-config",
  "visibleAreas",
  "leftmost",
  "hiddenSources",
  "Outline precedence",
  "drill or composite",
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

for (const readmeName of rendererReadmeNames) {
  const contents = await readFile(
    new URL(readmeName, rendererPackageRoot),
    "utf8",
  );
  const missing = requiredRendererConcepts.filter(
    (concept) => !contents.includes(concept),
  );
  if (missing.length > 0) {
    failures.push(
      `packages/wasm-gerber-renderer/${readmeName}: missing ${missing.join(", ")}`,
    );
  }
}

const skillContents = await readFile(
  new URL("SKILL.md", rendererPackageRoot),
  "utf8",
);
const missingSkillConcepts = requiredSkillConcepts.filter(
  (concept) => !skillContents.includes(concept),
);
if (missingSkillConcepts.length > 0) {
  failures.push(
    `packages/wasm-gerber-renderer/SKILL.md: missing ${missingSkillConcepts.join(", ")}`,
  );
}

const packageJson = JSON.parse(
  await readFile(new URL("package.json", rendererPackageRoot), "utf8"),
);
const publishedFiles = new Set(packageJson.files ?? []);
const missingPublishedReadmes = rendererReadmeNames.filter(
  (readmeName) => !publishedFiles.has(readmeName),
);
if (missingPublishedReadmes.length > 0) {
  failures.push(
    `packages/wasm-gerber-renderer/package.json: unpublished ${missingPublishedReadmes.join(", ")}`,
  );
}

if (failures.length > 0) {
  console.error("Composite README parity check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Composite README parity check passed (${readmeNames.length} root and ${rendererReadmeNames.length} renderer files).`,
  );
}
