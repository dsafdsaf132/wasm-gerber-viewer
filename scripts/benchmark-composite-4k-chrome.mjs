import { spawn } from "node:child_process";

import { chromium } from "playwright";

import {
  evaluateCompositeBenchmark,
  getCompositeBenchmarkFailures,
  isCompositeBenchmarkAcceptanceMode,
} from "./composite-benchmark-contract.mjs";
import { classifyWebGlRenderer } from "./webgl-renderer-classification.mjs";

const port = Number(process.env.COMPOSITE_BENCHMARK_PORT ?? 4184);
const baseUrl = `http://127.0.0.1:${port}`;
const headless = process.env.COMPOSITE_BENCHMARK_HEADLESS === "1";
const channel = process.env.COMPOSITE_BENCHMARK_CHANNEL ?? "chrome";
const allowSoftware = process.env.COMPOSITE_BENCHMARK_ALLOW_SOFTWARE === "1";
const server = spawn(process.execPath, ["scripts/static-server.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, GERBER_VIEWER_TEST_PORT: String(port) },
  stdio: ["ignore", "ignore", "inherit"],
});

let browser;
try {
  await waitForServer(baseUrl);
  browser = await chromium.launch({
    headless,
    ...(channel === "chromium" ? {} : { channel }),
  });
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/tests/fixtures/benchmark.html`, {
    waitUntil: "domcontentloaded",
  });
  const result = await page.evaluate(async () => {
    const width = 3840;
    const height = 2160;
    const sourceCount = 24;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("Chrome WebGL2 is unavailable");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    await wasm.default({
      module_or_path: "/wasm/pkg/wasm_gerber_processor_bg.wasm",
    });
    const processor = new wasm.GerberProcessor();
    processor.init_with_size(gl, width, height);
    const source = `%FSLAX24Y24*%
%MOMM*%
%ADD10C,8.000*%
D10*
X000000Y000000D03*
M02*`;
    try {
      const sourceIds = new Uint32Array(sourceCount);
      for (let index = 0; index < sourceCount; index += 1) {
        sourceIds[index] = processor.add_layer(source);
      }
      const sourceColors = new Float32Array(sourceCount * 4);
      for (let index = 0; index < sourceCount; index += 1) {
        sourceColors.set([1, 1, 1, 1], index * 4);
      }
      const zoomX = 0.08;
      const zoomY = 0.08;
      processor.render(sourceIds, sourceColors, zoomX, zoomY, 0, 0, 1);
      gl.finish();

      const visibleBits = new Uint8Array(2 * 1024 * 1024);
      visibleBits.fill(0xff);
      visibleBits[0] &= 0xfe;
      const compositeId = processor.add_composite_layer_with_bounds(
        sourceIds,
        visibleBits,
        false,
        -5,
        5,
        -5,
        5,
      );
      const selectionStart = performance.now();
      processor.render_composite_selection(compositeId, zoomX, zoomY, 0, 0);
      gl.finish();
      const selectionMs = performance.now() - selectionStart;
      const selectionDiagnostics =
        processor.get_composite_diagnostics(compositeId);
      const lastByte = visibleBits.length - 1;
      const toggleStart = performance.now();
      processor.set_composite_visible_byte(compositeId, lastByte, 0x7f);
      processor.render_composite_selection(compositeId, zoomX, zoomY, 0, 0);
      gl.finish();
      const toggleMs = performance.now() - toggleStart;
      const diagnostics = processor.get_composite_diagnostics(compositeId);
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        viewport: `${width}x${height}`,
        sourceCount,
        encodePassCount: diagnostics.encodePassCount,
        selectionMs,
        toggleMs,
        outputFormat: diagnostics.outputFormat,
        outlineFormat: diagnostics.outlineFormat,
        cpuBitsetBytes: diagnostics.cpuBitsetBytes,
        gpuLookupBytes: diagnostics.gpuLookupBytes,
        outputMaskBytes: diagnostics.outputMaskBytes,
        sharedMembershipBytes: diagnostics.sharedMembershipBytes,
        sharedOutlineBytes: diagnostics.sharedOutlineBytes,
        selectionDiagnostics: {
          membershipEncodeCount:
            selectionDiagnostics.membershipEncodeCount,
          membershipEncodePassCount:
            selectionDiagnostics.membershipEncodePassCount,
          lookupRenderCount: selectionDiagnostics.lookupRenderCount,
          renderScratchGrowthCount:
            selectionDiagnostics.renderScratchGrowthCount,
        },
        toggleDiagnostics: {
          membershipEncodeCount: diagnostics.membershipEncodeCount,
          membershipEncodePassCount:
            diagnostics.membershipEncodePassCount,
          lookupRenderCount: diagnostics.lookupRenderCount,
          renderScratchGrowthCount: diagnostics.renderScratchGrowthCount,
        },
        r8Fallback:
          diagnostics.outputFormat !== "R8" || diagnostics.outlineFormat !== "R8",
        outputR8Fallback: diagnostics.outputFormat !== "R8",
        outlineR8Fallback: diagnostics.outlineFormat !== "R8",
        webglVersion: gl.getParameter(gl.VERSION),
        gpuVendor: debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
          : gl.getParameter(gl.VENDOR),
        gpuRenderer: debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
      };
    } finally {
      processor.clear();
      processor.free();
    }
  });

  const { softwareRenderer, hardwareRendererVerified } = classifyWebGlRenderer(
    result.gpuVendor,
    result.gpuRenderer,
  );
  const contract = evaluateCompositeBenchmark({
    selectionMs: result.selectionMs,
    toggleMs: result.toggleMs,
    encodePassCount: result.encodePassCount,
    selectionDiagnostics: result.selectionDiagnostics,
    toggleDiagnostics: result.toggleDiagnostics,
  });
  delete result.selectionDiagnostics;
  delete result.toggleDiagnostics;
  const acceptanceMode = isCompositeBenchmarkAcceptanceMode({
    allowSoftware,
    headless,
    channel,
  });
  const failures = getCompositeBenchmarkFailures(contract.targets, {
    enforceTiming: acceptanceMode,
  });
  const report = {
    browserChannel: channel,
    headless,
    acceptanceMode,
    softwareRenderer,
    hardwareRendererVerified,
    ...result,
    ...contract,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!hardwareRendererVerified && acceptanceMode) {
    throw new Error(
      softwareRenderer
        ? "The 4K acceptance benchmark requires hardware acceleration; a software renderer was detected."
        : "The 4K acceptance benchmark requires a recognized hardware renderer; GPU identity could not be verified.",
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `4K composite benchmark targets failed: ${failures.join(", ")}.`,
    );
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Benchmark server did not start: ${lastError ?? "timeout"}`);
}
