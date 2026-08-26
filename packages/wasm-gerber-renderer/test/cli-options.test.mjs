import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  MAX_ARCHIVE_ENTRY_COUNT,
  MAX_COMPOSITE_CONFIG_SIZE_BYTES,
  MAX_SOURCE_FILE_SIZE_BYTES,
} from "../shared.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const cliPath = fileURLToPath(new URL("../bin/wasm-gerber-renderer.js", import.meta.url));
const wasmBinaryPath = fileURLToPath(
  new URL("../../../wasm/pkg/wasm_gerber_processor_bg.wasm", import.meta.url),
);
const forceCompositeErrorPreload = new URL(
  "./fixtures/force-composite-render-error.mjs",
  import.meta.url,
).href;
const forceCompositeConstructionErrorPreload = new URL(
  "./fixtures/force-composite-construction-error.mjs",
  import.meta.url,
).href;
const shrinkStableReadPreload = new URL(
  "./fixtures/shrink-stable-read.mjs",
  import.meta.url,
).href;
let hasNodeGles = true;
try {
  require.resolve("node-gles-webgl2");
} catch (_error) {
  hasNodeGles = false;
}

test("CLI help lists Node PNG memory and strategy options", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "--help",
  ]);

  assert.match(stdout, /--max-band-bytes <size>/);
  assert.match(stdout, /--max-full-frame-bytes <size>/);
  assert.match(stdout, /--framebuffer-memory-safety-factor <n>/);
  assert.match(stdout, /--render-strategy <strategy>/);
  assert.match(stdout, /--composite-config <path>/);
  assert.match(stdout, /--invert-layer <selector>.*exact name, or basename/);
  assert.match(stdout, /--outline-layer <selector>.*exact name, or basename/);
  assert.match(stdout, /Gerber\/drill or compressed archive: 300 MiB per file/);
  assert.match(stdout, /Composite JSON: 16 MiB/);
});

test("CLI rejects malformed composite JSON before rendering", async () => {
  await withCompositeConfig("{", async (configPath) => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        "missing.gbr",
        "--composite-config",
        configPath,
      ]),
      /Failed to parse composite config/,
    );
  });
});

test("CLI rejects oversized config, source, and compressed archive files by stat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gerber-cli-input-limits-"));
  try {
    const configPath = join(directory, "oversized.json");
    await writeFile(configPath, "{}");
    await truncate(configPath, MAX_COMPOSITE_CONFIG_SIZE_BYTES + 1);
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        join(directory, "missing.gbr"),
        "--composite-config",
        configPath,
      ]),
      /Composite config .*limit is/,
    );

    const sourcePath = join(directory, "oversized.gbr");
    await writeFile(sourcePath, "");
    await truncate(sourcePath, MAX_SOURCE_FILE_SIZE_BYTES + 1);
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        sourcePath,
        "--output",
        join(directory, "source.png"),
      ]),
      /Layer source .*limit is/,
    );

    const archivePath = join(directory, "oversized.tgz");
    await writeFile(archivePath, "");
    await truncate(archivePath, MAX_SOURCE_FILE_SIZE_BYTES + 1);
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        archivePath,
        "--output",
        join(directory, "archive.png"),
      ]),
      /Compressed archive .*limit is/,
    );
    assert.equal(existsSync(join(directory, "source.png")), false);
    assert.equal(existsSync(join(directory, "archive.png")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects config files that shrink after the initial stat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gerber-cli-shrinking-config-"));
  try {
    const configPath = join(directory, "shrinking.json");
    const outputPath = join(directory, "output.png");
    await writeFile(configPath, '{"composites":[]}');
    const nodeOptions = [
      process.env.NODE_OPTIONS,
      `--import=${shrinkStableReadPreload}`,
    ].filter(Boolean).join(" ");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          cliPath,
          join(directory, "missing.gbr"),
          "--composite-config",
          configPath,
          "--output",
          outputPath,
        ],
        {
          env: {
            ...process.env,
            GERBER_TEST_SHRINK_PATH: configPath,
            NODE_OPTIONS: nodeOptions,
          },
        },
      ),
      /Composite config changed while it was being read/,
    );
    assert.equal(existsSync(outputPath), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI validates the 24-source ceiling before resolving selectors", async () => {
  await withCompositeConfig(
    JSON.stringify({
      composites: [{ sources: new Array(25).fill(1), preset: "union" }],
    }),
    async (configPath) => {
      await assert.rejects(
        execFileAsync(process.execPath, [
          cliPath,
          "first.gbr",
          "--composite-config",
          configPath,
        ]),
        /between 2 and 24 Gerber sources/,
      );
    },
  );
});

test("CLI rejects malformed and resource-hostile TAR archives before rendering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gerber-cli-tar-limits-"));
  try {
    const cases = [];

    const truncatedPath = join(directory, "truncated.tar.gz");
    await writeFile(
      truncatedPath,
      gzipSync(Buffer.concat([createTarHeader("truncated.gbr", 1024), Buffer.from("x")])),
    );
    cases.push([truncatedPath, /TAR entry 1 is truncated/]);

    const oversizedEntryPath = join(directory, "oversized-entry.tgz");
    await writeFile(
      oversizedEntryPath,
      gzipSync(
        Buffer.concat([
          createTarHeader("oversized.gbr", MAX_SOURCE_FILE_SIZE_BYTES + 1),
          Buffer.alloc(1024),
        ]),
      ),
    );
    cases.push([oversizedEntryPath, /per-entry limit/]);

    const malformedPaxPath = join(directory, "malformed-pax.tgz");
    const malformedPax = Buffer.from("bad", "ascii");
    await writeFile(
      malformedPaxPath,
      gzipSync(
        Buffer.concat([
          createTarHeader("pax", malformedPax.length, "x"),
          malformedPax,
          Buffer.alloc(512 - malformedPax.length),
          Buffer.alloc(1024),
        ]),
      ),
    );
    cases.push([malformedPaxPath, /malformed PAX data/]);

    const checksumPath = join(directory, "bad-checksum.tgz");
    const badChecksumHeader = createTarHeader("checksum.gbr", 0);
    badChecksumHeader[0] ^= 1;
    await writeFile(
      checksumPath,
      gzipSync(Buffer.concat([badChecksumHeader, Buffer.alloc(1024)])),
    );
    cases.push([checksumPath, /failed its checksum/]);

    const danglingLongNamePath = join(directory, "dangling-long-name.tgz");
    const longName = Buffer.from("unused.gbr\0", "utf8");
    await writeFile(
      danglingLongNamePath,
      gzipSync(
        Buffer.concat([
          createTarHeader("././@LongLink", longName.length, "L"),
          longName,
          Buffer.alloc(512 - longName.length),
          Buffer.alloc(1024),
        ]),
      ),
    );
    cases.push([danglingLongNamePath, /metadata that has no following entry/]);

    const tooManyEntriesPath = join(directory, "too-many-entries.tgz");
    const headers = Array.from({ length: MAX_ARCHIVE_ENTRY_COUNT + 1 }, (_, index) =>
      createTarHeader(`directory-${index}`, 0, "5"),
    );
    await writeFile(
      tooManyEntriesPath,
      gzipSync(Buffer.concat([...headers, Buffer.alloc(1024)])),
    );
    cases.push([tooManyEntriesPath, /more than 1000 TAR entries/]);

    const ratioPath = join(directory, "compression-ratio.tgz");
    await writeFile(ratioPath, gzipSync(Buffer.alloc(2 * 1024 * 1024)));
    cases.push([ratioPath, /compression-ratio limit exceeded/]);

    for (const [archivePath, expected] of cases) {
      const outputPath = `${archivePath}.png`;
      await assert.rejects(
        execFileAsync(process.execPath, [cliPath, archivePath, "--output", outputPath]),
        expected,
      );
      assert.equal(existsSync(outputPath), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI validates duplicate sources and unsafe empty visible areas", async () => {
  await withCompositeConfig(
    JSON.stringify({
      composites: [{ sources: [1, 1], preset: "union" }],
    }),
    async (configPath) => {
      await assert.rejects(
        execFileAsync(process.execPath, [
          cliPath,
          "first.gbr",
          "second.gbr",
          "--output",
          `${configPath}.png`,
          "--composite-config",
          configPath,
        ]),
        /sources resolves to duplicate layers/,
      );
    },
  );

  await withCompositeConfig(
    JSON.stringify({
      composites: [{ sources: [1, 2], visibleAreas: [] }],
    }),
    async (configPath) => {
      await assert.rejects(
        execFileAsync(process.execPath, [
          cliPath,
          "first.gbr",
          "second.gbr",
          "--output",
          `${configPath}.png`,
          "--composite-config",
          configPath,
        ]),
        /visibleAreas cannot be empty/,
      );
    },
  );

  for (const [config, expected] of [
    [{ hiddenSources: null }, /hiddenSources must be an array/],
    [{ composites: null }, /composites must be an array/],
    [
      { composites: [{ sources: [1, 2], visibleAreas: null }] },
      /visibleAreas must be an array of binary strings/,
    ],
    [
      { composites: [{ sources: [1, 2], preset: null }] },
      /preset must be a string/,
    ],
  ]) {
    await withCompositeConfig(JSON.stringify(config), async (configPath) => {
      await assert.rejects(
        execFileAsync(process.execPath, [
          cliPath,
          "first.gbr",
          "second.gbr",
          "--output",
          `${configPath}.png`,
          "--composite-config",
          configPath,
        ]),
        expected,
      );
    });
  }
});

test("CLI rejects unknown and renderer-internal composite config fields", async () => {
  const cases = [
    {
      config: { unexpected: true },
      message: /Composite config contains unsupported field: unexpected/,
    },
    {
      config: {
        composites: [
          { sources: [1, 2], outline: "bounds", outlineLayerId: 3 },
        ],
      },
      message: /composites\[0\] contains unsupported field: outlineLayerId/,
    },
    {
      config: {
        composites: [
          {
            sources: [1, 2],
            outline: "auto",
            __allowOutlineBoundsFallback: true,
          },
        ],
      },
      message:
        /composites\[0\] contains unsupported field: __allowOutlineBoundsFallback/,
    },
  ];

  for (const { config, message } of cases) {
    await withCompositeConfig(JSON.stringify(config), async (configPath) => {
      await assert.rejects(
        execFileAsync(process.execPath, [
          cliPath,
          "first.gbr",
          "second.gbr",
          "third.gbr",
          "--output",
          `${configPath}.png`,
          "--composite-config",
          configPath,
        ]),
        message,
      );
    });
  }
});

test("CLI rejects out-of-range numeric JSON selectors without treating them as names", async () => {
  for (const selector of [0, -1, 999]) {
    await withCompositeConfig(
      JSON.stringify({ hiddenSources: [selector] }),
      async (configPath) => {
        await assert.rejects(
          execFileAsync(process.execPath, [
            cliPath,
            "first.gbr",
            "second.gbr",
            "--output",
            `${configPath}.png`,
            "--composite-config",
            configPath,
          ]),
          new RegExp(`hiddenSources numeric selector is out of range: ${selector}`),
        );
      },
    );
  }
});

test("CLI rejects numeric text that collides with a different layer name", async () => {
  const cases = [
    {
      config: { hiddenSources: ["1"] },
      args: [],
    },
    {
      config: { composites: [{ sources: ["1", 2] }] },
      args: [],
    },
    {
      config: { composites: [{ sources: [1, 2] }] },
      args: ["--outline-layer", "1"],
    },
  ];

  for (const { config, args } of cases) {
    await withCompositeConfig(JSON.stringify(config), async (configPath) => {
      await assert.rejects(
        execFileAsync(process.execPath, [
          cliPath,
          "first.gbr",
          "1",
          "--output",
          `${configPath}.png`,
          ...args,
          "--composite-config",
          configPath,
        ]),
        /selector is ambiguous between index and name: 1/,
      );
    });
  }
});

test("CLI rejects known drill sources and outlines in composite config", async () => {
  for (const definition of [
    { sources: [1, 2] },
    { sources: [1, 3], outline: 2 },
  ]) {
    await withCompositeConfig(
      JSON.stringify({ composites: [definition] }),
      async (configPath) => {
        await assert.rejects(
          execFileAsync(process.execPath, [
            cliPath,
            "first.gbr",
            "holes.drl",
            "second.gbr",
            "--output",
            `${configPath}.png`,
            "--composite-config",
            configPath,
          ]),
          /must reference (?:an )?ordinary Gerber layer/,
        );
      },
    );
  }

  await withCompositeConfig(
    JSON.stringify({ composites: [{ sources: [1, 3] }] }),
    async (configPath) => {
      await assert.rejects(
        execFileAsync(process.execPath, [
          cliPath,
          "first.gbr",
          "holes.drl",
          "second.gbr",
          "--output",
          `${configPath}.png`,
          "--outline-layer",
          "2",
          "--composite-config",
          configPath,
        ]),
        /outline must reference an ordinary Gerber layer/,
      );
    },
  );
});

test("CLI content-sniffs ambiguous DRD composite sources and outlines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gerber-cli-ambiguous-drd-"));
  const firstPath = join(directory, "first.gbr");
  const secondPath = join(directory, "second.gbr");
  const drillPath = join(directory, "board-outline.drd");
  const outputPath = join(directory, "output.png");
  const configPath = join(directory, "composites.json");
  const gerber = `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.000*%\nD10*\nX000000Y000000D03*\nM02*`;
  const drill = `M48\nMETRIC\nT01C0.800\n%\nT01\nX000000Y000000\nM30\n`;
  try {
    await writeFile(firstPath, gerber);
    await writeFile(secondPath, gerber);
    await writeFile(drillPath, drill);

    for (const definition of [
      { sources: ["board-outline.drd", "first.gbr"] },
      { sources: ["first.gbr", "second.gbr"], outline: "board-outline.drd" },
    ]) {
      await writeFile(configPath, JSON.stringify({ composites: [definition] }));
      await assert.rejects(
        execFileAsync(process.execPath, [
          cliPath,
          firstPath,
          drillPath,
          secondPath,
          "--output",
          outputPath,
          "--composite-config",
          configPath,
        ]),
        /must reference (?:an )?ordinary Gerber layer/,
      );
      assert.equal(existsSync(outputPath), false);
    }

    await writeFile(
      configPath,
      JSON.stringify({ composites: [{ sources: ["first.gbr", "second.gbr"] }] }),
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        firstPath,
        drillPath,
        secondPath,
        "--output",
        outputPath,
        "--outline-layer",
        "board-outline.drd",
        "--composite-config",
        configPath,
      ]),
      /outline must reference an ordinary Gerber layer/,
    );
    assert.equal(existsSync(outputPath), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "CLI Auto outline ignores a content-detected ambiguous DRD drill",
  { skip: !(hasNodeGles && existsSync(wasmBinaryPath)) },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "gerber-cli-auto-drd-"));
    const firstPath = join(directory, "first.gbr");
    const secondPath = join(directory, "second.gbr");
    const drillPath = join(directory, "board-outline.drd");
    const configPath = join(directory, "composites.json");
    const outputPath = join(directory, "output.png");
    const flash = (x) =>
      `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.000*%\nD10*\nX${String(x * 10_000).padStart(6, "0")}Y000000D03*\nM02*`;
    try {
      await writeFile(firstPath, flash(0));
      await writeFile(secondPath, flash(4));
      await writeFile(
        drillPath,
        "M48\nMETRIC\nT01C0.800\n%\nT01\nX000000Y000000\nM30\n",
      );
      await writeFile(
        configPath,
        JSON.stringify({
          hiddenSources: ["first.gbr", "second.gbr"],
          composites: [{
            name: "Auto Bounds Composite",
            sources: ["first.gbr", "second.gbr"],
            preset: "union",
            outline: "auto",
          }],
        }),
      );

      const { stdout, stderr } = await execFileAsync(process.execPath, [
        cliPath,
        firstPath,
        drillPath,
        secondPath,
        "--output",
        outputPath,
        "--composite-config",
        configPath,
      ]);
      assert.match(stdout, /Rendered 4\/4 layer\(s\)/);
      assert.doesNotMatch(stderr, /Skipped Auto Bounds Composite/);
      assert.equal(existsSync(outputPath), true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "CLI renders hidden sources through composite JSON configuration",
  { skip: !(hasNodeGles && existsSync(wasmBinaryPath)) },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "gerber-composite-cli-render-"));
    const firstPath = join(directory, "first.gbr");
    const secondPath = join(directory, "second.gbr");
    const configPath = join(directory, "composites.json");
    const outputPath = join(directory, "output.png");
    const flash = (x) =>
      `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.000*%\nD10*\nX${String(x * 10_000).padStart(6, "0")}Y000000D03*\nM02*`;
    try {
      await writeFile(firstPath, flash(0), "utf8");
      await writeFile(secondPath, flash(4), "utf8");
      await writeFile(
        configPath,
        JSON.stringify({
          hiddenSources: ["first.gbr", "second.gbr"],
          composites: [
            {
              name: "CLI Union",
              sources: ["first.gbr", "second.gbr"],
              preset: "union",
              color: "#00ff00",
              alpha: 1,
              outline: "bounds",
            },
          ],
        }),
        "utf8",
      );
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        cliPath,
        firstPath,
        secondPath,
        "--output",
        outputPath,
        "--width",
        "96",
        "--height",
        "64",
        "--composite-config",
        configPath,
      ]);
      assert.equal(stderr, "");
      assert.match(stdout, /Rendered 3\/3 layer\(s\)/);
      const png = await readFile(outputPath);
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(png.length > 100);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "CLI partial layer failures skip dependent composites and keep healthy output atomic",
  { skip: !(hasNodeGles && existsSync(wasmBinaryPath)) },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "gerber-cli-partial-layer-"));
    const invalidPath = join(directory, "invalid.gbr");
    const healthyPath = join(directory, "healthy.gbr");
    const configPath = join(directory, "composites.json");
    const partialOutputPath = join(directory, "partial.png");
    const failedOutputPath = join(directory, "failed.png");
    try {
      await writeFile(invalidPath, "not Gerber data", "utf8");
      await writeFile(
        healthyPath,
        "%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.000*%\nD10*\nX000000Y000000D03*\nM02*",
        "utf8",
      );
      await writeFile(
        configPath,
        JSON.stringify({
          composites: [{
            name: "Depends on invalid source",
            sources: ["invalid.gbr", "healthy.gbr"],
            outline: "bounds",
          }],
        }),
        "utf8",
      );

      const partial = await execFileAsync(process.execPath, [
        cliPath,
        invalidPath,
        healthyPath,
        "--output",
        partialOutputPath,
        "--composite-config",
        configPath,
      ]);
      assert.match(partial.stderr, /Skipped invalid\.gbr:/);
      assert.match(
        partial.stderr,
        /Skipped Depends on invalid source: a source layer failed to load/,
      );
      assert.match(partial.stdout, /Rendered 1\/3 layer\(s\)/);
      assert.deepEqual(
        [...(await readFile(partialOutputPath)).subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );

      const sentinel = Buffer.from("preserve existing output");
      await writeFile(failedOutputPath, sentinel);
      await assert.rejects(
        execFileAsync(process.execPath, [
          cliPath,
          invalidPath,
          "--output",
          failedOutputPath,
        ]),
        /invalid\.gbr|Gerber|boundary/i,
      );
      assert.deepEqual(await readFile(failedOutputPath), sentinel);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "CLI selector permutations render equivalent direct and root TAR composites",
  { skip: !(hasNodeGles && existsSync(wasmBinaryPath)) },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "gerber-composite-cli-tar-"));
    const archivePath = join(directory, "board.tgz");
    const configPath = join(directory, "composites.json");
    const archiveOutputPath = join(directory, "archive.png");
    const directOutputPath = join(directory, "direct.png");
    const firstPath = join(directory, "first.gbr");
    const secondPath = join(directory, "second.gbr");
    const outlinePath = join(directory, "board-outline.gko");
    const flash = (x) =>
      `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.000*%\nD10*\nX${String(x * 10_000).padStart(6, "0")}Y000000D03*\nM02*`;
    const outline = `%FSLAX24Y24*%
%MOMM*%
G36*
X-050000Y-050000D02*
X050000Y-050000D01*
X050000Y050000D01*
X-050000Y050000D01*
X-050000Y-050000D01*
G37*
M02*`;
    try {
      await writeFile(firstPath, flash(0));
      await writeFile(secondPath, flash(4));
      await writeFile(outlinePath, outline);
      await writeTarGz(archivePath, {
        "first.gbr": flash(0),
        "second.gbr": flash(4),
        "board-outline.gko": outline,
      });
      await writeFile(
        configPath,
        JSON.stringify({
          hiddenSources: [1, "second.gbr", 3],
          composites: [
            {
              name: "Archive basename composite",
              sources: ["first.gbr", 2],
              outline: "board-outline.gko",
              color: "#00ff00",
            },
          ],
        }),
        "utf8",
      );
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        cliPath,
        archivePath,
        "--output",
        archiveOutputPath,
        "--composite-config",
        configPath,
      ]);
      assert.equal(stderr, "");
      assert.match(stdout, /Rendered 4\/4 layer\(s\)/);
      const direct = await execFileAsync(process.execPath, [
        cliPath,
        firstPath,
        secondPath,
        outlinePath,
        "--output",
        directOutputPath,
        "--composite-config",
        configPath,
      ]);
      assert.equal(direct.stderr, "");
      assert.match(direct.stdout, /Rendered 4\/4 layer\(s\)/);
      const archivePng = await readFile(archiveOutputPath);
      const directPng = await readFile(directOutputPath);
      assert.deepEqual(
        archivePng,
        directPng,
        "archive entry expansion must preserve direct-input ordering and pixels",
      );
      assert.deepEqual(
        [...archivePng.subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "CLI resolves UTF-8 TAR paths through Windows-style composite selectors",
  { skip: !(hasNodeGles && existsSync(wasmBinaryPath)) },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "gerber-cli-portable-tar-"));
    const archivePath = join(directory, "설계-board.tgz");
    const configPath = join(directory, "composites.json");
    const outputPath = join(directory, "결과.png");
    const flash = (x) =>
      `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.000*%\nD10*\nX${String(x * 10_000).padStart(6, "0")}Y000000D03*\nM02*`;
    const outline = `%FSLAX24Y24*%
%MOMM*%
G36*
X-050000Y-050000D02*
X050000Y-050000D01*
X050000Y050000D01*
X-050000Y050000D01*
X-050000Y-050000D01*
G37*
M02*`;
    try {
      await writeTarGz(archivePath, {
        "설계/첫째.gbr": flash(0),
        "설계/둘째.gbr": flash(4),
        "설계/보드-outline.gko": outline,
      });
      await writeFile(
        configPath,
        JSON.stringify({
          hiddenSources: ["설계\\첫째.gbr", "설계\\둘째.gbr"],
          composites: [{
            name: "Portable selectors",
            sources: ["설계\\첫째.gbr", "설계\\둘째.gbr"],
            outline: "설계\\보드-outline.gko",
            color: "#00ff00",
            alpha: 1,
          }],
        }),
        "utf8",
      );

      const { stdout, stderr } = await execFileAsync(process.execPath, [
        cliPath,
        archivePath,
        "--output",
        outputPath,
        "--composite-config",
        configPath,
      ]);
      assert.equal(stderr, "");
      assert.match(stdout, /Rendered 4\/4 layer\(s\)/);
      assert.deepEqual(
        [...(await readFile(outputPath)).subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("CLI reports ambiguous root tar entry basenames across archives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gerber-composite-cli-tar-ambiguous-"));
  const firstArchive = join(directory, "first.tgz");
  const secondArchive = join(directory, "second.tgz");
  const configPath = join(directory, "composites.json");
  try {
    const content = "%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.000*%\nD10*\nX000000Y000000D03*\nM02*";
    await writeTarGz(firstArchive, { "top.gtp": content });
    await writeTarGz(secondArchive, { "top.gtp": content });
    await writeFile(
      configPath,
      JSON.stringify({ hiddenSources: ["top.gtp"] }),
      "utf8",
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        firstArchive,
        secondArchive,
        "--output",
        join(directory, "output.png"),
        "--composite-config",
        configPath,
      ]),
      /hiddenSources selector is ambiguous: top\.gtp/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "CLI automatic composite outline falls back to Bounds when the contour is open",
  { skip: !(hasNodeGles && existsSync(wasmBinaryPath)) },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "gerber-composite-cli-outline-"));
    const firstPath = join(directory, "first.gbr");
    const secondPath = join(directory, "second.gbr");
    const outlinePath = join(directory, "board-outline.gko");
    const configPath = join(directory, "composites.json");
    const outputPath = join(directory, "output.png");
    const flash = (x) =>
      `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.000*%\nD10*\nX${String(x * 10_000).padStart(6, "0")}Y000000D03*\nM02*`;
    const openOutline =
      "%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.200*%\nD10*\nX-050000Y-050000D02*\nX050000Y-050000D01*\nM02*";
    try {
      await writeFile(firstPath, flash(0), "utf8");
      await writeFile(secondPath, flash(4), "utf8");
      await writeFile(outlinePath, openOutline, "utf8");
      await writeFile(
        configPath,
        JSON.stringify({
          hiddenSources: ["first.gbr", "second.gbr", "board-outline.gko"],
          composites: [
            {
              name: "Auto fallback",
              sources: ["first.gbr", "second.gbr"],
              preset: "union",
              outline: "auto",
            },
          ],
        }),
        "utf8",
      );
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        cliPath,
        firstPath,
        secondPath,
        outlinePath,
        "--output",
        outputPath,
        "--width",
        "96",
        "--height",
        "64",
        "--composite-config",
        configPath,
      ]);
      assert.match(stdout, /Rendered 4\/4 layer\(s\)/);
      assert.match(stderr, /automatic outline fill failed; used Bounds fallback/);
      const png = await readFile(outputPath);
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "CLI skips a lazy composite render failure and still writes the PNG",
  { skip: !(hasNodeGles && existsSync(wasmBinaryPath)) },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "gerber-composite-cli-failure-"));
    const firstPath = join(directory, "first.gbr");
    const secondPath = join(directory, "second.gbr");
    const configPath = join(directory, "composites.json");
    const outputPath = join(directory, "output.png");
    const flash = (x) =>
      `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.000*%\nD10*\nX${String(x * 10_000).padStart(6, "0")}Y000000D03*\nM02*`;
    try {
      await writeFile(firstPath, flash(0), "utf8");
      await writeFile(secondPath, flash(4), "utf8");
      await writeFile(
        configPath,
        JSON.stringify({
          composites: [
            {
              name: "Duplicate failure",
              sources: ["first.gbr", "second.gbr"],
              preset: "union",
              outline: "bounds",
            },
            {
              name: "Duplicate failure",
              sources: ["first.gbr", "second.gbr"],
              preset: "intersection",
              outline: "bounds",
            },
          ],
        }),
        "utf8",
      );
      const nodeOptions = [
        process.env.NODE_OPTIONS,
        `--import=${forceCompositeErrorPreload}`,
      ].filter(Boolean).join(" ");
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          cliPath,
          firstPath,
          secondPath,
          "--output",
          outputPath,
          "--width",
          "96",
          "--height",
          "64",
          "--render-strategy",
          "full-frame",
          "--composite-config",
          configPath,
        ],
        { env: { ...process.env, NODE_OPTIONS: nodeOptions } },
      );
      assert.equal(
        stderr.match(/Skipped Duplicate failure: forced CLI composite allocation failure/g)?.length,
        2,
      );
      assert.match(stdout, /Rendered 2\/4 layer\(s\)/);
      const png = await readFile(outputPath);
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "CLI skips one composite construction failure and renders later composites",
  { skip: !(hasNodeGles && existsSync(wasmBinaryPath)) },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "gerber-composite-cli-construction-"));
    const firstPath = join(directory, "first.gbr");
    const secondPath = join(directory, "second.gbr");
    const configPath = join(directory, "composites.json");
    const outputPath = join(directory, "output.png");
    const flash = (x) =>
      `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.000*%\nD10*\nX${String(x * 10_000).padStart(6, "0")}Y000000D03*\nM02*`;
    try {
      await writeFile(firstPath, flash(0), "utf8");
      await writeFile(secondPath, flash(4), "utf8");
      await writeFile(
        configPath,
        JSON.stringify({
          composites: [
            {
              name: "Construction failure",
              sources: ["first.gbr", "second.gbr"],
              outline: "bounds",
            },
            {
              name: "Healthy composite",
              sources: ["first.gbr", "second.gbr"],
              outline: "bounds",
            },
          ],
        }),
        "utf8",
      );
      const nodeOptions = [
        process.env.NODE_OPTIONS,
        `--import=${forceCompositeConstructionErrorPreload}`,
      ].filter(Boolean).join(" ");
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          cliPath,
          firstPath,
          secondPath,
          "--output",
          outputPath,
          "--width",
          "96",
          "--height",
          "64",
          "--render-strategy",
          "stream",
          "--composite-config",
          configPath,
        ],
        { env: { ...process.env, NODE_OPTIONS: nodeOptions } },
      );
      assert.match(
        stderr,
        /Skipped Construction failure: forced CLI composite construction failure/,
      );
      assert.match(stdout, /Rendered 3\/4 layer\(s\)/);
      const png = await readFile(outputPath);
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function withCompositeConfig(content, callback) {
  const directory = await mkdtemp(join(tmpdir(), "gerber-composite-cli-"));
  const configPath = join(directory, "composites.json");
  try {
    await writeFile(configPath, content, "utf8");
    await callback(configPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeTarGz(path, entries) {
  const blocks = [];
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, "utf8");
    const header = createTarHeader(name, data.length);
    blocks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  await writeFile(path, gzipSync(Buffer.concat(blocks)));
}

function createTarHeader(name, size, typeFlag = "0") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = typeFlag.charCodeAt(0);
  header.write("ustar\0", 257, 6, "binary");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeTarOctal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  header.write(text, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

test("CLI validates render strategy before rendering", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      "--render-strategy",
      "invalid",
      "board.gbr",
    ]),
    /--render-strategy must be auto, full-frame, or stream\./,
  );
});
