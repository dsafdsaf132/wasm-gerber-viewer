// Local investigation only: no production code or GPU error policy changes.
// Modes deliberately alter WebGL calls to isolate costs, not propose a fix.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { featuresFile, matrixFile, writeTgz } from "../packages/wasm-gerber-renderer/test/helpers/odb-fixture.mjs";

const port = Number(process.env.UPLOAD_DIAGNOSTIC_PORT ?? 4195);
const modes = (process.env.UPLOAD_DIAGNOSTIC_MODES ?? "baseline,single-buffer-data,skip-error-query").split(",");
if (modes.some((mode) => !["baseline", "single-buffer-data", "skip-error-query"].includes(mode))) {
  throw new Error("Unknown UPLOAD_DIAGNOSTIC_MODES entry");
}
const baseURL = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["scripts/static-server.mjs"], {
  env: { ...process.env, GERBER_VIEWER_TEST_PORT: String(port) },
  stdio: ["ignore", "ignore", "inherit"],
});
let browser;
const results = [];
const fixtures = [{ name: "sample", input: "demo/odb-sample.tgz" }];
for (const alternating of [false, true]) {
  const name = alternating ? "alternating-64" : "uniform-64";
  const bytes = writeTgz({
    "diagnostic/matrix/matrix": matrixFile({ layers: [{ type: "SIGNAL", name: "top" }] }),
    "diagnostic/steps/pcb/layers/top/features": featuresFile({ units: "MM", symbols: ["r600"],
      records: Array.from({ length: 64 }, (_, i) =>
        `P ${2 + i % 8} ${2 + Math.floor(i / 8)} 0 ${alternating && i % 2 ? "N" : "P"} 0 0`),
    }),
  });
  fixtures.push({ name, input: { name: `${name}.tgz`, mimeType: "application/gzip", buffer: Buffer.from(bytes) } });
}
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(baseURL)).ok) break; } catch {}
    if (attempt === 50) throw new Error("Diagnostic server did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = process.env.UPLOAD_DIAGNOSTIC_CDP
    ? await chromium.connectOverCDP(process.env.UPLOAD_DIAGNOSTIC_CDP)
    : await chromium.launch({ headless: true });
  for (const variant of ["32", "64"]) {
    for (const mode of modes) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("dialog", (dialog) => dialog.accept());
      await page.addInitScript(({ mode }) => {
        window.uploadDiagnostic = { mode, imports: [], active: null };
        const proto = WebGL2RenderingContext.prototype;
        const originals = Object.fromEntries(
          ["bufferData", "bufferSubData", "getError", "finish"].map((name) => [name, proto[name]]),
        );
        window.uploadDiagnostic.complete = (stat) => {
          if (!stat.context) return;
          const start = performance.now();
          originals.finish.call(stat.context);
          stat.boundaryError = originals.getError.call(stat.context);
          stat.completionMs = performance.now() - start;
          stat.totalMs = stat.ms + stat.completionMs;
        };
        const pending = new WeakMap();
        for (const name of ["bufferData", "bufferSubData", "getError"]) {
          proto[name] = function (...args) {
            const active = window.uploadDiagnostic.active;
            if (!active) return originals[name].apply(this, args);
            if (!active.context) Object.defineProperty(active, "context", { value: this });
            const start = performance.now();
            try {
              if (mode === "skip-error-query" && name === "getError") return 0;
              if (mode === "single-buffer-data") {
                if (name === "bufferData" && typeof args[1] === "number") {
                  pending.set(this, { target: args[0], size: args[1], usage: args[2] });
                  return;
                }
                if (name === "bufferSubData" && pending.has(this)) {
                  const allocation = pending.get(this);
                  pending.delete(this);
                  if (args[0] !== allocation.target || args[1] !== 0 ||
                      args[2].byteLength !== allocation.size) {
                    throw new Error("Unexpected upload sequence in diagnostic");
                  }
                  return originals.bufferData.call(this, args[0], args[2], allocation.usage);
                }
              }
              return originals[name].apply(this, args);
            } finally {
              const stat = active.calls[name] ??= { count: 0, ms: 0 };
              stat.count++;
              stat.ms += performance.now() - start;
            }
          };
        }
      }, { mode });
      await page.goto(`${baseURL}/?wasm=${variant}`);
      await page.waitForFunction(() => document.querySelector("#file-input") &&
        document.querySelector("#loading-modal")?.hidden);
      await page.evaluate(async (variant) => {
        const { GerberViewer } = await import("/js/core/viewer.js");
        const wasm = await import(`/wasm/pkg${variant === "64" ? "64" : ""}/wasm_gerber_processor.js`);
        const names = new WeakMap();
        const create = GerberViewer.prototype.createParsedLayerRecord;
        GerberViewer.prototype.createParsedLayerRecord = function (name, payload, ...args) {
          names.set(payload, name);
          return create.call(this, name, payload, ...args);
        };
        const add = wasm.GerberProcessor.prototype.add_render_payload;
        wasm.GerberProcessor.prototype.add_render_payload = function (payload) {
          const stat = { name: names.get(payload), calls: {}, ms: 0 };
          window.uploadDiagnostic.active = stat;
          const start = performance.now();
          try { return add.call(this, payload); }
          finally {
            stat.ms = performance.now() - start;
            window.uploadDiagnostic.active = null;
            window.uploadDiagnostic.complete(stat);
            window.uploadDiagnostic.imports.push(stat);
          }
        };
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2");
        const extension = gl.getExtension("WEBGL_debug_renderer_info");
        window.uploadDiagnostic.gpu = extension
          ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }, variant);
      // Small ODB++ fixtures only, not a full-board stress load.
      for (const fixture of fixtures) for (let run = 0; run < 3; run++) {
        await page.evaluate(() => { window.uploadDiagnostic.imports = []; });
        await page.locator("#file-input").setInputFiles(fixture.input);
        await page.waitForFunction(() => window.uploadDiagnostic.imports.length > 0 &&
          document.querySelector("#loading-modal")?.hidden, { }, { timeout: 30_000 });
        const result = await page.evaluate(() => window.uploadDiagnostic);
        const pixels = await page.locator("#gerber-canvas").screenshot();
        const pixelHash = createHash("sha256").update(pixels).digest("hex");
        const record = { fixture: fixture.name, variant, mode, run, ...result, active: undefined, errors: [...errors], pixelHash };
        results.push(record);
        console.log(JSON.stringify({ fixture: fixture.name, variant, mode, run, gpu: result.gpu, pixelHash,
          top: result.imports.find((layer) => layer.name === "top.gtl"),
          totalMs: result.imports.reduce((sum, layer) => sum + layer.totalMs, 0), errors }));
        if (result.imports.some((layer) => layer.boundaryError !== 0) || errors.length) {
          throw new Error("Diagnostic returned WebGL or page errors");
        }
        await page.locator("#toolbar-clear-all-btn").click();
      }
      await context.close();
    }
  }
  for (const fixture of fixtures) {
    const hashes = new Set(results.filter((record) => record.fixture === fixture.name)
      .map((record) => record.pixelHash));
    if (hashes.size !== 1) throw new Error(`Canvas output differs for ${fixture.name}`);
  }
  if (process.env.UPLOAD_DIAGNOSTIC_COMPARE) {
    const before = JSON.parse(await readFile(process.env.UPLOAD_DIAGNOSTIC_COMPARE, "utf8"));
    for (const fixture of fixtures) for (const variant of ["32", "64"]) {
      const matches = (record) => record.fixture === fixture.name && record.variant === variant && record.mode === "baseline";
      const oldRuns = Array.isArray(before) ? before.filter(matches) : [];
      const summary = before.summaries?.find((record) => record.fixture === fixture.name && record.variant === variant);
      const newRuns = results.filter(matches);
      if ((!oldRuns.length && !summary) || !newRuns.length) throw new Error("Missing baseline comparison runs");
      if (new Set([...oldRuns.map((record) => record.pixelHash), ...newRuns.map((record) => record.pixelHash),
        ...(summary ? [summary.pixelHash] : [])]).size !== 1) {
        throw new Error(`Canvas changed from baseline: ${fixture.name}, wasm${variant}`);
      }
      const average = (runs, value) => runs.reduce((sum, record) => sum + value(record), 0) / runs.length;
      const total = (record) => record.imports.reduce((sum, layer) => sum + layer.totalMs, 0);
      const queries = (record) => record.imports.reduce((sum, layer) => sum + layer.calls.getError.count, 0);
      console.log(JSON.stringify({ comparison: true, fixture: fixture.name, variant,
        beforeMs: summary?.meanMs ?? average(oldRuns, total), afterMs: average(newRuns, total),
        beforeQueries: summary?.queries ?? average(oldRuns, queries), afterQueries: average(newRuns, queries),
        pixelsUnchanged: true }));
    }
  }
} finally {
  // Playwright removes test-results on startup; keep local measurements apart.
  try {
    await mkdir(".tmp/webgl-buffer-upload", { recursive: true });
    await writeFile(".tmp/webgl-buffer-upload/results.json.tmp", JSON.stringify(results, null, 2));
  } finally {
    try {
      await browser?.close();
    } finally {
      server.kill("SIGTERM");
    }
  }
}
