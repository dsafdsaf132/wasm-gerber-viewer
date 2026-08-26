import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { inflateSync } from "node:zlib";

import { GerberRenderer } from "../index.js";
import { createNodeGerberRenderer, NodeGerberRenderer } from "../node.js";

const require = createRequire(import.meta.url);
const wasmModuleUrl = new URL("../../../wasm/pkg/wasm_gerber_processor.js", import.meta.url);
const wasmBinaryUrl = new URL("../../../wasm/pkg/wasm_gerber_processor_bg.wasm", import.meta.url);
let hasNodeGles = true;
try {
  require.resolve("node-gles-webgl2");
} catch (_error) {
  hasNodeGles = false;
}
const canRender = hasNodeGles && existsSync(wasmModuleUrl) && existsSync(wasmBinaryUrl);

test(
  "repeated prepared composite exports free processors, listeners, and temp resources",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const gl = createWebGLRenderingContext({
      width: 64,
      height: 64,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    let processorCreates = 0;
    let processorFrees = 0;
    class CountingProcessor extends wasm.GerberProcessor {
      constructor() {
        super();
        processorCreates += 1;
        this.__resourceStressFreed = false;
      }

      free() {
        if (!this.__resourceStressFreed) {
          this.__resourceStressFreed = true;
          processorFrees += 1;
        }
        return super.free();
      }
    }
    const renderer = new NodeGerberRenderer(
      { gl, releaseContext: false },
      { ...wasm, GerberProcessor: CountingProcessor },
    );
    const directory = await mkdtemp(join(tmpdir(), "gerber-resource-stress-"));
    try {
      const prepared = [
        await renderer.loadLayer(flashGerber(0)),
        await renderer.loadLayer(flashGerber(4)),
      ];
      for (let iteration = 0; iteration < 6; iteration += 1) {
        const strategy = iteration % 2 === 0 ? "full-frame" : "stream";
        await renderer.withFrame(
          { width: 64, height: 64, strategy, background: null },
          async () => {
            const sourceIds = [];
            for (const layer of prepared) {
              sourceIds.push(await renderer.renderLayer(layer, { visible: false }));
            }
            await renderer.renderCompositeLayer(sourceIds, {
              preset: iteration % 3 === 0 ? "intersection" : "union",
              color: "#00ff00",
              alpha: 1,
            });
          },
        );

        if (iteration % 3 === 0) {
          assert.ok((await renderer.exportPng()).length > 8);
        } else if (iteration % 3 === 1) {
          const writable = new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          });
          const initialErrorListeners = writable.listenerCount("error");
          await renderer.exportPngStream(writable);
          assert.equal(writable.listenerCount("error"), initialErrorListeners);
          writable.destroy();
        } else {
          await renderer.exportPngFile(join(directory, `결과-${iteration}.png`));
          assert.equal(
            (await readdir(directory)).some((name) => name.endsWith(".tmp")),
            false,
          );
        }
        assert.equal(processorFrees, processorCreates, `iteration ${iteration}`);
      }
    } finally {
      renderer.dispose();
      gl.destroy();
      await rm(directory, { recursive: true, force: true });
    }
    assert.equal(processorFrees, processorCreates);
  },
);

test(
  "repeated internal Node exports release every owned WebGL context on dispose",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const renderer = await createNodeGerberRenderer();
    const createdContexts = new Set();
    const releasedContexts = new Set();
    const createExportContext = renderer.createExportContext.bind(renderer);
    const releaseContext = renderer.releaseContext.bind(renderer);
    renderer.createExportContext = (...args) => {
      const gl = createExportContext(...args);
      createdContexts.add(gl);
      return gl;
    };
    renderer.releaseContext = () => {
      if (renderer.gl) releasedContexts.add(renderer.gl);
      return releaseContext();
    };
    try {
      await renderer.withFrame(
        { width: 48, height: 32, background: null },
        async () => {
          await renderer.renderLayer(flashGerber(0), {
            color: "#ff0000",
            alpha: 1,
          });
        },
      );
      for (const strategy of ["full-frame", "stream", "full-frame", "stream"]) {
        assert.ok((await renderer.exportPng({ strategy })).length > 8);
        assert.ok(renderer.gl, `${strategy} keeps at most the current cached context`);
      }
    } finally {
      renderer.dispose();
    }
    assert.equal(renderer.gl, null);
    assert.deepEqual(releasedContexts, createdContexts);
  },
);

test(
  "24-source Node export rebuilds only active dependencies without a redundant LUT copy",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const gl = createWebGLRenderingContext({
      width: 64,
      height: 64,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    let parsedLayerAdds = 0;
    class CountingProcessor extends wasm.GerberProcessor {
      add_parsed_layer(layer) {
        parsedLayerAdds += 1;
        return super.add_parsed_layer(layer);
      }
    }
    const renderer = new NodeGerberRenderer(
      { gl, releaseContext: false },
      { ...wasm, GerberProcessor: CountingProcessor },
    );
    const NativeUint8Array = globalThis.Uint8Array;
    try {
      const prepared = await renderer.loadLayer(flashGerber(0));
      await renderer.withFrame(
        { width: 64, height: 64, strategy: "full-frame", background: null },
        async () => {
          const sourceIds = [];
          for (let index = 0; index < 24; index += 1) {
            sourceIds.push(
              await renderer.renderLayer(prepared, { visible: false }),
            );
          }
          await renderer.renderLayer(prepared, {
            name: "hidden-unrelated.gbr",
            visible: false,
          });
          await renderer.renderCompositeLayer(sourceIds, { preset: "union" });
        },
      );

      const visibleBits = renderer.lastRenderPlan.layers.at(-1).visibleBits;
      assert.equal(visibleBits.byteLength, 2 * 1024 * 1024);
      let redundantVisibleBitsetCopies = 0;
      globalThis.Uint8Array = new Proxy(NativeUint8Array, {
        construct(target, argumentsList) {
          if (argumentsList[0] === visibleBits) {
            redundantVisibleBitsetCopies += 1;
          }
          return Reflect.construct(target, argumentsList);
        },
      });

      for (const strategy of ["full-frame", "stream"]) {
        parsedLayerAdds = 0;
        redundantVisibleBitsetCopies = 0;
        const png = await renderer.exportPng({
          strategy,
          maxBandBytes: 64 * 1024,
        });
        assert.deepEqual(
          [...png.subarray(0, 8)],
          [137, 80, 78, 71, 13, 10, 26, 10],
        );
        assert.equal(
          parsedLayerAdds,
          24,
          `${strategy} must not rebuild the unrelated hidden layer`,
        );
        assert.equal(
          redundantVisibleBitsetCopies,
          0,
          `${strategy} must forward the owned LUT without another JS copy`,
        );
      }
    } finally {
      globalThis.Uint8Array = NativeUint8Array;
      renderer.dispose();
      gl.destroy();
    }
  },
);

test(
  "fixed-seed composite pixels are invariant across Node strategy and source display state",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const cases = [
      { sourceCount: 2, preset: "difference", compositeMode: "stack" },
      { sourceCount: 7, visibleAreas: ["1010101"], compositeMode: "blend" },
      { sourceCount: 8, preset: "union", compositeMode: "blend" },
      { sourceCount: 24, preset: "intersection", compositeMode: "stack" },
    ];
    for (const definition of cases) {
      const baseline = await renderMetamorphicComposite(
        definition,
        "full-frame",
        false,
      );
      const changedDisplayState = await renderMetamorphicComposite(
        definition,
        "stream",
        true,
      );
      assert.deepEqual(
        changedDisplayState,
        baseline,
        `${definition.sourceCount}-source ${definition.preset ?? "explicit"} ${definition.compositeMode}`,
      );
      assert.ok(
        baseline.some((channel, index) => index % 4 === 3 && channel > 0),
        "the reference selection must render non-empty coverage",
      );
    }
  },
);

test(
  "hidden Gerber sources feed the same composite pixels in full-frame and stream exports",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const fullFrame = await renderComposite("full-frame");
    const stream = await renderComposite("stream");
    assert.deepEqual(stream, fullFrame);

    let greenPixels = 0;
    for (let offset = 0; offset < fullFrame.length; offset += 4) {
      if (
        fullFrame[offset] < 20 &&
        fullFrame[offset + 1] > 200 &&
        fullFrame[offset + 2] < 20 &&
        fullFrame[offset + 3] > 0
      ) {
        greenPixels += 1;
      }
    }
    assert.ok(greenPixels > 0, "the union composite should render hidden source coverage");
  },
);

test(
  "fixed-seed composite camera flips are invariant across full-frame and tiled stream exports",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const cases = [
      { view: { zoomX: 0.12, zoomY: 0.14, offsetX: 0, offsetY: 0 } },
      {
        view: { zoomX: 0.1, zoomY: 0.16, offsetX: 0.08, offsetY: -0.06 },
        flipX: true,
      },
      {
        view: { zoomX: 0.13, zoomY: 0.11, offsetX: -0.05, offsetY: 0.09 },
        flipY: true,
      },
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const fullFrame = await renderFixedSeedTileCase("full-frame", cases[index]);
      const stream = await renderFixedSeedTileCase("stream", cases[index]);
      assert.deepEqual(stream, fullFrame, `camera case ${index}`);
      assert.ok(
        fullFrame.some((_value, offset) => offset % 4 === 3 && fullFrame[offset] > 0),
        `camera case ${index} must render selected coverage`,
      );
    }
  },
);

test(
  "Node composite uses inverted source coverage but the base Gerber as its outline",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const fullFrame = await renderInvertedSourceComposite("full-frame");
    const stream = await renderInvertedSourceComposite("stream");
    assert.deepEqual(stream, fullFrame);

    const center = (64 * 128 + 64) * 4;
    assert.equal(
      fullFrame[center + 3],
      0,
      "the original flash must be excluded from its inverted source coverage",
    );
    let greenPixels = 0;
    for (let offset = 0; offset < fullFrame.length; offset += 4) {
      if (
        fullFrame[offset] < 20 &&
        fullFrame[offset + 1] > 200 &&
        fullFrame[offset + 2] < 20 &&
        fullFrame[offset + 3] > 0
      ) {
        greenPixels += 1;
      }
    }
    assert.ok(greenPixels > 1_000, "the inverted source should cover the outline interior");
  },
);

test(
  "Node full-frame and stream exports preserve exact explicit region-outline holes",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const fullFrame = await renderRegionOutlineComposite("full-frame");
    const stream = await renderRegionOutlineComposite("stream");
    assert.deepEqual(stream, fullFrame);

    assertGreenPixel(fullFrame, 4, 0, "region interior");
    assertTransparentPixel(fullFrame, 0, 0, "region hole");
    assertTransparentPixel(fullFrame, 6, 0, "region exterior");
  },
);

test(
  "prepared inverted arc regions keep load-time parse options in full-frame and stream exports",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const [loadMatched, conflictingFullFrame, conflictingStream] =
      await renderPreparedInvertedArcRegionVariants();
    assert.deepEqual(conflictingFullFrame, loadMatched);
    assert.deepEqual(conflictingStream, loadMatched);
  },
);

test(
  "prepared composite arc-region outlines keep load-time parse options in full-frame and stream exports",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const [loadMatched, conflictingFullFrame, conflictingStream] =
      await renderPreparedArcOutlineVariants();
    assert.deepEqual(conflictingFullFrame, loadMatched);
    assert.deepEqual(conflictingStream, loadMatched);
  },
);

test(
  "Node stream band budget caps RGBA readback and encoded PNG rows",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const width = 37;
    for (const background of [null, "#ffffff"]) {
      const pngChannels = background == null ? 4 : 3;
      const oneRowBudget =
        width * 4 + width * 4 + (1 + width * pngChannels);
      const narrowedOneRowBudget =
        width * 4 + 18 * 4 + (1 + width * pngChannels);
      const minimumOneRowBudget =
        width * 4 + 1 * 4 + (1 + width * pngChannels);
      const fullFrame = await renderBandBudgetCase(
        "full-frame",
        background,
        oneRowBudget,
      );
      const stream = await renderBandBudgetCase(
        "stream",
        background,
        oneRowBudget,
      );
      assert.deepEqual(stream, fullFrame);
      const narrowedStream = await renderBandBudgetCase(
        "stream",
        background,
        narrowedOneRowBudget,
      );
      assert.deepEqual(narrowedStream, fullFrame);
      await assert.rejects(
        renderBandBudgetCase("stream", background, minimumOneRowBudget - 1),
        /stream band limit at 37px wide/,
      );
    }
  },
);

test(
  "Node deterministic row budgets fail before writing PNG bytes",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const width = 37;
    for (const background of [null, "#ffffff"]) {
      const pngChannels = background == null ? 4 : 3;
      const encodedRowBytes = 1 + width * pngChannels;
      const streamMinimumBytes = width * 4 + 4 + encodedRowBytes;
      for (const [strategy, maxBandBytes] of [
        ["full-frame", encodedRowBytes - 1],
        ["stream", streamMinimumBytes - 1],
        ["auto", encodedRowBytes - 1],
      ]) {
        const result = await exportBandBudgetFailure(
          strategy,
          background,
          maxBandBytes,
        );
        assert.match(result.message, /stream band limit at 37px wide/);
        assert.equal(result.writes, 0, `${strategy} must not emit a partial PNG`);
        assert.equal(result.activeExport, false);
      }
    }
  },
);

test(
  "browser renderCompositeLayer renders hidden dependencies with CSS color",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const gl = createWebGLRenderingContext({
      width: 96,
      height: 64,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const canvas = {
      width: 96,
      height: 64,
      getContext: () => gl,
    };
    const renderer = new GerberRenderer(
      canvas,
      { releaseContext: false },
      wasm,
    );
    try {
      await renderer.withFrame(
        { width: 96, height: 64, background: null },
        async () => {
          const first = await renderer.renderLayer(
            { source: flashGerber(0), name: "first.gbr" },
            { visible: false },
          );
          const second = await renderer.renderLayer(
            { source: flashGerber(8), name: "second.gbr" },
            { visible: false },
          );
          await renderer.renderCompositeLayer([first, second], {
            preset: "union",
            color: "#00ff00",
            alpha: 1,
          });
        },
      );
      const pixels = new Uint8Array(96 * 64 * 4);
      gl.readPixels(0, 0, 96, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let greenPixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (
          pixels[offset] < 20 &&
          pixels[offset + 1] > 200 &&
          pixels[offset + 2] < 20 &&
          pixels[offset + 3] > 0
        ) {
          greenPixels += 1;
        }
      }
      assert.ok(greenPixels > 0);
    } finally {
      renderer.dispose();
      gl.destroy();
    }
  },
);

test(
  "Browser and Node composite APIs reject IDs returned by an earlier frame",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const gl = createWebGLRenderingContext({
      width: 64,
      height: 64,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const browser = new GerberRenderer(
      { width: 64, height: 64, getContext: () => gl },
      { releaseContext: false },
      wasm,
    );
    try {
      let staleBrowserIds;
      await browser.withFrame({ width: 64, height: 64 }, async () => {
        staleBrowserIds = [
          await browser.renderLayer(flashGerber(0)),
          await browser.renderLayer(flashGerber(2)),
        ];
      });
      await browser.withFrame({ width: 64, height: 64 }, async () => {
        const currentIds = [
          await browser.renderLayer(flashGerber(0)),
          await browser.renderLayer(flashGerber(2)),
        ];
        await assert.rejects(
          browser.renderCompositeLayer(staleBrowserIds),
          /Invalid or stale/,
        );
        await browser.renderCompositeLayer(currentIds);
      });
    } finally {
      browser.dispose();
      gl.destroy();
    }

    const node = await createNodeGerberRenderer();
    try {
      let staleNodeIds;
      await node.withFrame({}, async () => {
        staleNodeIds = [
          await node.renderLayer(flashGerber(0)),
          await node.renderLayer(flashGerber(2)),
        ];
      });
      await node.withFrame({}, async () => {
        const currentIds = [
          await node.renderLayer(flashGerber(0)),
          await node.renderLayer(flashGerber(2)),
        ];
        await assert.rejects(
          node.renderCompositeLayer(staleNodeIds),
          /Invalid or stale/,
        );
        await node.renderCompositeLayer(currentIds);
      });
    } finally {
      node.dispose();
    }
  },
);

test(
  "strict composite failures reject at the documented Browser and Node boundaries",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const { createWebGLRenderingContext } = require("node-gles-webgl2");

    for (const [failureKind, createModule] of [
      ["construction", createForcedCompositeConstructionFailureModule],
      ["lazy", createForcedCompositeFailureModule],
    ]) {
      const wasmModule = await createModule();
      const gl = createWebGLRenderingContext({
        width: 64,
        height: 64,
        majorVersion: 3,
        minorVersion: 0,
        webGLCompatibility: true,
      });
      const browser = new GerberRenderer(
        { width: 64, height: 64, getContext: () => gl },
        { releaseContext: false },
        wasmModule,
      );
      let browserCompositeResolved = false;
      try {
        await assert.rejects(
          browser.withFrame(
            {
              width: 64,
              height: 64,
              fit: false,
              view: { zoomX: 0.08, zoomY: 0.08, offsetX: 0, offsetY: 0 },
            },
            async () => {
              const first = await browser.renderLayer(flashGerber(0));
              const second = await browser.renderLayer(flashGerber(4));
              await browser.renderCompositeLayer([first, second], {
                name: `Browser ${failureKind}`,
              });
              browserCompositeResolved = true;
            },
          ),
          failureKind === "construction"
            ? /forced composite construction failure/
            : /forced composite allocation failure/,
        );
        assert.equal(
          browserCompositeResolved,
          failureKind === "lazy",
          "Browser construction rejects renderCompositeLayer; lazy GPU failure rejects withFrame",
        );
        assert.equal(browser.lastFrame, null);
        await browser.withFrame(
          { width: 64, height: 64, background: null },
          async () => {
            await browser.renderLayer(flashGerber(0), {
              color: "#ff0000",
              alpha: 1,
            });
          },
        );
        assert.ok(browser.lastFrame, "the Browser renderer remains reusable");
      } finally {
        browser.dispose();
        gl.destroy();
      }

      const node = await createNodeGerberRenderer({ wasmModule });
      try {
        await node.withFrame(
          { width: 64, height: 64, fit: false },
          async () => {
            const first = await node.renderLayer(flashGerber(0));
            const second = await node.renderLayer(flashGerber(4));
            await node.renderCompositeLayer([first, second], {
              name: `Node ${failureKind}`,
            });
          },
        );
        await assert.rejects(
          node.exportPng(),
          failureKind === "construction"
            ? /forced composite construction failure/
            : /forced composite allocation failure/,
        );
        assert.equal(node.activeExport, false);
        await node.withFrame(
          { width: 64, height: 64, strategy: "full-frame", background: null },
          async () => {
            await node.renderLayer(flashGerber(0), {
              color: "#ff0000",
              alpha: 1,
            });
          },
        );
        assert.ok((await node.exportPng()).length > 8);
      } finally {
        node.dispose();
      }
    }
  },
);

test(
  "Browser and Node code-zero composites use final frame fallback bounds",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const browserPixels = await renderBrowserLateFallbackComposite();
    const nodeFullFrame = await renderNodeLateFallbackComposite("full-frame");
    const nodeStream = await renderNodeLateFallbackComposite("stream");
    assert.deepEqual(nodeStream, nodeFullFrame);

    const pixelX = Math.round((5 * 0.08 + 1) * 64);
    const pixelOffset = (64 * 128 + pixelX) * 4;
    for (const [label, pixels] of [
      ["Browser", browserPixels],
      ["Node", nodeFullFrame],
    ]) {
      assert.ok(pixels[pixelOffset] < 20, `${label} fallback pixel red channel`);
      assert.ok(pixels[pixelOffset + 1] > 200, `${label} fallback pixel green channel`);
      assert.ok(pixels[pixelOffset + 2] < 20, `${label} fallback pixel blue channel`);
      assert.ok(pixels[pixelOffset + 3] > 200, `${label} fallback pixel alpha`);
    }
  },
);

test(
  "Node composite participates in blend and ordered stack rendering",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const blended = await renderCompositeMode("blend");
    const stacked = await renderCompositeMode("stack");
    assert.deepEqual(await renderCompositeMode("blend", "stream"), blended);
    assert.deepEqual(await renderCompositeMode("stack", "stream"), stacked);
    const offset = compositePngPixelOffset(0, 0);

    assert.ok(blended[offset] > 200, "blend should retain the red source");
    assert.ok(blended[offset + 2] > 200, "blend should add the blue composite");
    assert.ok(stacked[offset] < 20, "top composite should cover red in stack mode");
    assert.ok(stacked[offset + 2] > 200, "top composite should remain blue");
  },
);

test(
  "Browser and Node stack preserve call-position order after a composite",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const browser = await renderBrowserLayerAfterComposite();
    const nodeFullFrame = await renderNodeLayerAfterComposite("full-frame");
    const nodeStream = await renderNodeLayerAfterComposite("stream");
    assert.deepEqual(nodeStream, nodeFullFrame);
    const offset = compositePngPixelOffset(0, 0);
    for (const [label, pixels] of [
      ["Browser", browser],
      ["Node full-frame", nodeFullFrame],
      ["Node stream", nodeStream],
    ]) {
      const rgba = [...pixels.subarray(offset, offset + 4)];
      assert.ok(pixels[offset] < 20, `${label}: later green Gerber covers red: ${rgba}`);
      assert.ok(pixels[offset + 1] > 200, `${label}: later Gerber is topmost: ${rgba}`);
      assert.ok(pixels[offset + 2] < 20, `${label}: earlier blue composite is covered: ${rgba}`);
    }
  },
);

test(
  "Node full-frame and stream exports isolate a failed composite in best-effort mode",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    for (const strategy of ["full-frame", "stream"]) {
      const failures = [];
      const renderer = await createNodeGerberRenderer({
        wasmModule: await createForcedCompositeFailureModule(),
        __continueOnCompositeError: true,
        __onCompositeError: (failure) => failures.push(failure),
      });
      try {
        await addForcedFailureFrame(renderer, strategy);
        const png = await renderer.exportPng();
        assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        assert.equal(failures.length, 1, `${strategy} reports the failure once`);
        assert.match(failures[0].error, /forced composite allocation failure/);
        assert.equal(renderer.__lastCompositeErrors.length, 1);
      } finally {
        renderer.dispose();
      }
    }
  },
);

test(
  "best-effort composite diagnostics contain async callback rejection",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    let callbackCalls = 0;
    const renderer = await createNodeGerberRenderer({
      wasmModule: await createForcedCompositeFailureModule(),
      __continueOnCompositeError: true,
      __onCompositeError: async () => {
        callbackCalls += 1;
        throw new Error("forced diagnostic callback rejection");
      },
    });
    try {
      await addForcedFailureFrame(renderer, "full-frame");
      const png = await renderer.exportPng();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        png.subarray(0, 8),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      assert.equal(callbackCalls, 1);
      assert.equal(renderer.__lastCompositeErrors.length, 1);
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "best-effort auto-fit matches a healthy baseline after lazy or construction failure",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    for (const strategy of ["full-frame", "stream"]) {
      const baseline = await renderAutoFitFailureCase({ strategy });
      for (const failureKind of ["lazy", "construction"]) {
        const pixels = await renderAutoFitFailureCase({ strategy, failureKind });
        assert.deepEqual(
          pixels,
          baseline,
          `${strategy} ${failureKind} failure must not retain failed composite bounds`,
        );
      }
    }
  },
);

test(
  "stream preflight prevents rows from mixing before a late composite failure",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const baseline = await renderLateBandFailureCase(null);
    const failures = [];
    const failed = await renderLateBandFailureCase(
      await createLateBandCompositeFailureModule(),
      failures,
    );
    assert.deepEqual(failed, baseline);
    assert.equal(failures.length, 1);
    assert.match(failures[0].error, /forced late-band composite failure/);
  },
);

test(
  "best-effort diagnostics stay single across full-frame fallback and stream context retry",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    for (const retryMode of ["full-frame", "stream"]) {
      const failures = [];
      const renderer = await createNodeGerberRenderer({
        wasmModule: await createForcedCompositeRetryModule(retryMode),
        __continueOnCompositeError: true,
        __onCompositeError: (failure) => failures.push(failure),
      });
      try {
        await addForcedFailureFrame(
          renderer,
          retryMode === "full-frame" ? "auto" : "stream",
        );
        const png = await renderer.exportPng();
        assert.deepEqual(
          png.subarray(0, 8),
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        assert.equal(failures.length, 1, `${retryMode} callback count`);
        assert.equal(renderer.__lastCompositeErrors.length, 1);
      } finally {
        renderer.dispose();
      }
    }
  },
);

test(
  "retry contexts do not rebuild dependencies used only by an excluded composite",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const baselineRenderer = await createNodeGerberRenderer();
    let baseline;
    try {
      await addExcludedDependencyFrame(baselineRenderer, false);
      baseline = decodeRgbaPng(await baselineRenderer.exportPng());
    } finally {
      baselineRenderer.dispose();
    }

    const wasmModule = await createExcludedDependencyRetryModule();
    const failures = [];
    const renderer = await createNodeGerberRenderer({
      wasmModule,
      __continueOnCompositeError: true,
      __onCompositeError: (failure) => failures.push(failure),
    });
    try {
      await addExcludedDependencyFrame(renderer, true);
      const pixels = decodeRgbaPng(await renderer.exportPng());
      assert.deepEqual(pixels, baseline);
      assert.equal(wasmModule.__getInvertedRebuildCount(), 1);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].name, "Excluded remote composite");
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "best-effort survivors rebuild without failed composite dependencies in manual views",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    for (const strategy of ["full-frame", "stream"]) {
      const baselineRenderer = await createNodeGerberRenderer();
      let baseline;
      try {
        await addExcludedDependencyFrame(baselineRenderer, false, strategy);
        baseline = decodeRgbaPng(await baselineRenderer.exportPng());
      } finally {
        baselineRenderer.dispose();
      }

      for (const failureKind of ["construction", "lazy"]) {
        const wasmModule = failureKind === "construction"
          ? await createForcedCompositeConstructionFailureModule()
          : await createOneCompositeFailureModule();
        const renderer = await createNodeGerberRenderer({
          wasmModule,
          __continueOnCompositeError: true,
        });
        try {
          await addExcludedDependencyFrame(renderer, true, strategy);
          assert.deepEqual(
            decodeRgbaPng(await renderer.exportPng()),
            baseline,
            `${strategy} ${failureKind} failure must rebuild survivor masks`,
          );
        } finally {
          renderer.dispose();
        }
      }
    }
  },
);

test(
  "Node strict composite export rejects without damaging the next healthy frame",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const renderer = await createNodeGerberRenderer({
      wasmModule: await createForcedCompositeFailureModule(),
    });
    try {
      await addForcedFailureFrame(renderer, "full-frame");
      await assert.rejects(
        renderer.exportPng(),
        /Composite Forced failure failed: forced composite allocation failure/,
      );

      await renderer.withFrame(
        { width: 64, height: 64, strategy: "full-frame", background: null },
        async () => {
          await renderer.renderLayer(
            { source: flashGerber(0), name: "healthy.gbr" },
            { color: "#ff0000", alpha: 1 },
          );
        },
      );
      const png = await renderer.exportPng();
      assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    } finally {
      renderer.dispose();
    }
  },
);

test(
  "Node full-frame and stream skip one composite construction failure",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    for (const strategy of ["full-frame", "stream"]) {
      const failures = [];
      const renderer = await createNodeGerberRenderer({
        wasmModule: await createForcedCompositeConstructionFailureModule(),
        __continueOnCompositeError: true,
        __onCompositeError: (failure) => failures.push(failure),
      });
      try {
        await addTwoCompositeFrame(renderer, strategy);
        const png = await renderer.exportPng();
        assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        assert.equal(failures.length, 1, `${strategy} reports only the failed definition`);
        assert.equal(failures[0].name, "First composite");
        assert.match(failures[0].error, /forced composite construction failure/);
        assert.equal(renderer.__lastCompositeErrors.length, 1);
      } finally {
        renderer.dispose();
      }
    }
  },
);

test(
  "membership picking preserves all red, green, and blue bit slots through 0xFFFFFF",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const gl = createWebGLRenderingContext({
      width: 256,
      height: 256,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const processor = new wasm.GerberProcessor();
    try {
      processor.init_with_size(gl, 256, 256);
      const sourceLayerIds = [];
      for (let slot = 0; slot < 24; slot += 1) {
        sourceLayerIds.push(processor.add_layer(membershipGerber(-11.5 + slot)));
      }
      const visibleBits = new Uint8Array(2 * 1024 * 1024);
      visibleBits.fill(0xff);
      visibleBits[0] &= 0xfe;
      const compositeId = processor.add_composite_layer_with_bounds(
        new Uint32Array(sourceLayerIds),
        visibleBits,
        false,
        -13,
        13,
        -1,
        6,
      );
      gl.enable(0xdeadbeef);
      processor.render_composite_selection(compositeId, 0.08, 0.15, 0, 0);

      const diagnostics = processor.get_composite_diagnostics(compositeId);
      assert.equal(diagnostics.sourceCount, 24);
      assert.equal(diagnostics.encodePassCount, 3);
      assert.equal(diagnostics.membershipEncodePassCount, 3);
      assert.equal(diagnostics.cpuBitsetBytes, 2 * 1024 * 1024);
      assert.equal(diagnostics.gpuLookupBytes, 2 * 1024 * 1024);
      assert.equal(diagnostics.outputFormat, "R8");
      assert.equal(diagnostics.outputMaskBytes, 256 * 256);
      assert.equal(diagnostics.sharedMembershipBytes, 256 * 256 * 4);
      assert.equal(diagnostics.sharedOutlineBytes, 256 * 256);
      assert.equal(diagnostics.outlineFormat, "R8");

      for (let slot = 0; slot < 24; slot += 1) {
        const worldX = -11.5 + slot;
        const pixelX = Math.round((worldX * 0.08 + 1) * 128);
        for (const deltaX of [-1, 0, 1]) {
          assert.equal(
            processor.pick_composite_code(compositeId, pixelX + deltaX, 128),
            2 ** slot,
            `slot ${slot} should survive RGB membership encoding at x offset ${deltaX}`,
          );
        }
      }
      assert.equal(processor.pick_composite_code(compositeId, 128, 224), 0xffffff);
      assert.equal(processor.pick_composite_code(compositeId, 128, 118), 0);
      assert.equal(processor.pick_composite_code(compositeId, 128, 0), -1);

      const visiblePreview = new Uint8Array(4);
      gl.readPixels(128, 224, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, visiblePreview);

      // Seed an unrelated GL error. The one-byte LUT update must drain it
      // before the upload and must not discard an otherwise valid texture.
      gl.enable(0xdeadbeef);
      processor.set_composite_visible_byte(
        compositeId,
        visibleBits.length - 1,
        0x7f,
      );
      processor.render_composite_selection(compositeId, 0.08, 0.15, 0, 0);
      const toggledDiagnostics = processor.get_composite_diagnostics(compositeId);
      assert.equal(
        toggledDiagnostics.membershipEncodePassCount,
        diagnostics.membershipEncodePassCount,
        "a LUT-only area toggle must not issue membership draw passes",
      );
      const hiddenPreview = new Uint8Array(4);
      gl.readPixels(128, 224, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, hiddenPreview);

      assert.deepEqual(
        [...visiblePreview],
        [219, 219, 219, 255],
        "active coverage uses the normal selection highlight's white checker cell",
      );
      assert.deepEqual(
        [...hiddenPreview],
        [0, 0, 0, 255],
        "inactive coverage uses the opaque dark stipple without violating premultiplication",
      );
      assert.equal(
        processor.get_composite_diagnostics(compositeId).gpuLookupBytes,
        visibleBits.length,
        "a stale GL error must not release the valid lookup texture",
      );
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        gl.destroy();
      }
    }
  },
);

test(
  "processor reinitialization clears drill and interaction layer generations",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const gl = createWebGLRenderingContext({
      width: 64,
      height: 64,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const processor = new wasm.GerberProcessor();
    try {
      processor.set_interactions_enabled(true);
      processor.init_with_size(gl, 64, 64);
      processor.add_drill_layer([
        "M48",
        "METRIC,TZ",
        "T01C1.0",
        "%",
        "T01",
        "X000000Y000000",
        "M30",
      ].join("\n"));
      assert.equal(processor.has_interaction_layer(0), true);

      processor.init_with_size(gl, 64, 64);
      assert.equal(processor.has_interaction_layer(0), false);
      const first = processor.add_layer(flashGerber(0));
      const second = processor.add_layer(flashGerber(4));
      assert.deepEqual([first, second], [0, 1]);
      assert.doesNotThrow(() =>
        processor.add_composite_preset_with_bounds(
          new Uint32Array([first, second]),
          "union",
          false,
          -5,
          9,
          -5,
          5,
        ));
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        gl.destroy();
      }
    }
  },
);

test(
  "fixed-seed 24-bit membership codes remain exact under camera transforms",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const gl = createWebGLRenderingContext({
      width: 256,
      height: 256,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const processor = new wasm.GerberProcessor();
    const codes = [
      0x000001,
      0x000080,
      0x000100,
      0x008000,
      0x010000,
      0x800000,
      0xffffff,
    ];
    let seed = 0x6d2b79f5;
    while (codes.length < 15) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      const code = seed & 0xffffff;
      if (code !== 0 && !codes.includes(code)) codes.push(code);
    }
    const worldXs = codes.map((_code, index) => -9.8 + index * 1.4);
    const cameras = [
      { zoomX: 0.05, zoomY: 0.2, offsetX: 0, offsetY: 0 },
      { zoomX: 0.04, zoomY: 0.15, offsetX: 0.12, offsetY: -0.08 },
      { zoomX: -0.045, zoomY: 0.18, offsetX: -0.05, offsetY: 0.06 },
    ];
    try {
      processor.init_with_size(gl, 256, 256);
      const sourceIds = [];
      for (let slot = 0; slot < 24; slot += 1) {
        const flashes = [];
        for (let index = 0; index < codes.length; index += 1) {
          if (((codes[index] >>> slot) & 1) !== 0) flashes.push(worldXs[index]);
        }
        if (flashes.length === 0) flashes.push(40);
        sourceIds.push(processor.add_layer(multiFlashGerber(flashes, 0.75)));
      }
      const visibleBits = new Uint8Array(2 * 1024 * 1024);
      visibleBits.fill(0xff);
      visibleBits[0] &= 0xfe;
      const compositeId = processor.add_composite_layer_with_bounds(
        new Uint32Array(sourceIds),
        visibleBits,
        false,
        -11,
        11,
        -2,
        2,
      );

      for (let cameraIndex = 0; cameraIndex < cameras.length; cameraIndex += 1) {
        const camera = cameras[cameraIndex];
        processor.render_composite_selection(
          compositeId,
          camera.zoomX,
          camera.zoomY,
          camera.offsetX,
          camera.offsetY,
        );
        for (let index = 0; index < codes.length; index += 1) {
          const pixelX = Math.round(
            (worldXs[index] * camera.zoomX + camera.offsetX + 1) * 128,
          );
          const pixelY = Math.round((camera.offsetY + 1) * 128);
          assert.equal(
            processor.pick_composite_code(compositeId, pixelX, pixelY),
            codes[index],
            `camera ${cameraIndex}, code 0x${codes[index].toString(16).padStart(6, "0")}`,
          );
        }
      }
      const diagnostics = processor.get_composite_diagnostics(compositeId);
      assert.equal(diagnostics.membershipEncodeCount, cameras.length);
      assert.equal(diagnostics.membershipEncodePassCount, cameras.length * 3);
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        gl.destroy();
      }
    }
  },
);

test(
  "selection preview dims inactive pseudo-colors and highlights active areas like normal selection",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const gl = createWebGLRenderingContext({
      width: 128,
      height: 128,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const processor = new wasm.GerberProcessor();
    const codes = [912, 1818];
    try {
      processor.init_with_size(gl, 128, 128);
      const sourceIds = [];
      for (let slot = 0; slot < 24; slot += 1) {
        const flashes = [];
        if ((codes[0] & (2 ** slot)) !== 0) flashes.push(-2);
        if ((codes[1] & (2 ** slot)) !== 0) flashes.push(2);
        if (flashes.length === 0) flashes.push(30);
        sourceIds.push(processor.add_layer(twoFlashGerber(flashes)));
      }
      const visibleBits = new Uint8Array(2 * 1024 * 1024);
      const compositeId = processor.add_composite_layer_with_bounds(
        new Uint32Array(sourceIds),
        visibleBits,
        false,
        -5,
        5,
        -5,
        5,
      );
      const pixelX = (worldX) => Math.round((worldX * 0.15 + 1) * 64);
      const readPreview = (worldX) => {
        const pixel = new Uint8Array(4);
        gl.readPixels(pixelX(worldX), 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return pixel;
      };
      const readInactiveColorSample = (worldX) => {
        const pixel = new Uint8Array(4);
        const centerX = pixelX(worldX);
        const sampleX = centerX + ((2 - (centerX & 3) + 4) & 3);
        gl.readPixels(sampleX, 66, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return pixel;
      };
      const expectedHashRgb = (coverageCode) => {
        const mask = 0xffffff;
        let value = (coverageCode + 1) & mask;
        value = (value ^ (value >>> 12)) & mask;
        value = Math.imul(value, 0x45d9f3) & mask;
        value = (value ^ (value >>> 11)) & mask;
        value = Math.imul(value, 0x119de1) & mask;
        value = (value ^ (value >>> 13)) & mask;
        return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
      };

      processor.render_composite_selection(compositeId, 0.15, 0.15, 0, 0);
      assert.equal(processor.pick_composite_code(compositeId, pixelX(-2), 64), codes[0]);
      assert.equal(processor.pick_composite_code(compositeId, pixelX(2), 64), codes[1]);
      const hidden = [readPreview(-2), readPreview(2)];
      const hiddenColorSamples = [
        readInactiveColorSample(-2),
        readInactiveColorSample(2),
      ];
      assert.deepEqual(
        [...hiddenColorSamples[0]],
        [...expectedHashRgb(codes[0]), 255],
      );
      assert.deepEqual(
        [...hiddenColorSamples[1]],
        [...expectedHashRgb(codes[1]), 255],
      );
      assert.notDeepEqual(
        [...hiddenColorSamples[0]],
        [...hiddenColorSamples[1]],
        "distinct coverage codes must never collapse after hidden-state dimming",
      );
      assert.deepEqual(hidden.map((pixel) => pixel[3]), [255, 255]);
      for (let index = 0; index < hidden.length; index += 1) {
        const dimSum = hidden[index][0] + hidden[index][1] + hidden[index][2];
        const baseSum = expectedHashRgb(codes[index]).reduce(
          (sum, channel) => sum + channel,
          0,
        );
        assert.ok(dimSum < baseSum * 0.1, "inactive stipple cells stay dark");
      }

      for (const code of codes) {
        processor.set_composite_visible_byte(
          compositeId,
          code >>> 3,
          1 << (code & 7),
        );
      }
      processor.render_composite_selection(compositeId, 0.15, 0.15, 0, 0);
      const visible = [readPreview(-2), readPreview(2)];
      for (let index = 0; index < codes.length; index += 1) {
        assert.equal(visible[index][3], 255);
      }

      const firstBase = expectedHashRgb(codes[0]);
      const firstCenterX = pixelX(-2);
      const gapPixel = new Uint8Array(4);
      const blackCellPixel = new Uint8Array(4);
      const whiteCellPixel = new Uint8Array(4);
      gl.readPixels(firstCenterX + 1, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, gapPixel);
      gl.readPixels(firstCenterX, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, blackCellPixel);
      gl.readPixels(firstCenterX + 3, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, whiteCellPixel);
      assert.deepEqual(
        [...gapPixel],
        [...firstBase, 255],
        "checker gaps retain the coverage pseudo-color",
      );
      assert.ok(
        blackCellPixel[0] + blackCellPixel[1] + blackCellPixel[2]
          < firstBase[0] + firstBase[1] + firstBase[2],
        `black checker cell must darken the active area: ${blackCellPixel}`,
      );
      assert.ok(
        whiteCellPixel[0] + whiteCellPixel[1] + whiteCellPixel[2]
          > firstBase[0] + firstBase[1] + firstBase[2],
        `white checker cell must brighten the active area: ${whiteCellPixel}`,
      );
      assert.equal(blackCellPixel[3], 255);
      assert.equal(whiteCellPixel[3], 255);
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        gl.destroy();
      }
    }
  },
);

test(
  "normal composite area picking accepts only final visible codes including outlined code zero",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const gl = createWebGLRenderingContext({
      width: 128,
      height: 128,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const processor = new wasm.GerberProcessor();
    const zoom = 0.15;
    const pixelX = (worldX) => Math.round((worldX * zoom + 1) * 64);
    const renderComposite = (compositeId) => processor.render(
      new Uint32Array([compositeId]),
      new Float32Array([0, 0, 1, 1]),
      zoom,
      zoom,
      0,
      0,
      1,
    );
    const pick = (compositeId, worldX) => processor.pick_composite_area(
      compositeId,
      pixelX(worldX),
      64,
      zoom,
      zoom,
      0,
      0,
    );
    const readNeighborhood = (worldX) => {
      const pixels = [];
      const centerX = pixelX(worldX);
      for (let y = 61; y <= 67; y += 1) {
        for (let x = centerX - 3; x <= centerX + 3; x += 1) {
          pixels.push(...readCanvasPixel(gl, x, y));
        }
      }
      return pixels;
    };
    const changed = (before, after) => before.some(
      (channel, index) => channel !== after[index],
    );

    try {
      processor.init_with_size(gl, 128, 128);
      const disconnected = processor.add_layer(twoFlashGerber([-2, 2]));
      const inactiveCenter = processor.add_layer(flashGerber(0));
      const visibleBits = new Uint8Array([0b00000011]);
      const compositeId = processor.add_composite_layer_with_bounds(
        new Uint32Array([disconnected, inactiveCenter]),
        visibleBits,
        false,
        -5,
        5,
        -5,
        5,
      );

      processor.render_composite_selection(compositeId, zoom, zoom, 0, 0);
      processor.begin_composite_area_scan(compositeId);
      processor.release_composite_cache(compositeId);
      assert.throws(
        () => processor.finish_composite_area_scan(compositeId),
        /scan is not active/,
        "cache release drops transient area-scan CPU buffers",
      );
      processor.render_composite_selection(compositeId, zoom, zoom, 0, 0);
      processor.begin_composite_area_scan(compositeId);
      processor.resize_to(128, 128);
      assert.throws(
        () => processor.finish_composite_area_scan(compositeId),
        /scan is not active/,
        "resize drops scan buffers tied to the previous FBO generation",
      );
      processor.render_composite_selection(compositeId, zoom, zoom, 0, 0);
      assert.deepEqual(
        [...processor.get_composite_area_codes(compositeId)],
        [0, 1, 2],
        "area enumeration returns active and inactive coverage plus outlined code zero",
      );
      const bandCodes = new Set([
        ...processor.get_composite_area_codes_band(compositeId, 0, 64),
        ...processor.get_composite_area_codes_band(compositeId, 64, 64),
      ]);
      assert.deepEqual(
        [...bandCodes].sort((left, right) => left - right),
        [0, 1, 2],
        "incremental area bands preserve the complete coverage set",
      );
      processor.begin_composite_area_scan(compositeId);
      processor.scan_composite_area_band(compositeId, 0, 64);
      processor.scan_composite_area_band(compositeId, 64, 64);
      assert.deepEqual(
        [...processor.finish_composite_area_scan(compositeId)],
        [0, 1, 2],
        "one scan session accumulates every band and enumerates codes once",
      );
      processor.begin_composite_area_scan(compositeId);
      assert.throws(
        () => processor.scan_composite_area_band(compositeId, 64, 64),
        /contiguous and ordered/,
      );
      processor.begin_composite_area_scan(compositeId);
      processor.scan_composite_area_band(compositeId, 0, 64);
      assert.throws(
        () => processor.finish_composite_area_scan(compositeId),
        /scan is incomplete/,
      );
      processor.begin_composite_area_scan(compositeId);
      processor.cancel_composite_area_scan(compositeId);
      assert.throws(
        () => processor.finish_composite_area_scan(compositeId),
        /scan is not active/,
      );
      processor.begin_composite_area_scan(compositeId);
      processor.update_composite_sources(
        compositeId,
        new Uint32Array([disconnected, inactiveCenter]),
        visibleBits,
      );
      assert.throws(
        () => processor.finish_composite_area_scan(compositeId),
        /scan is not active/,
        "source changes invalidate an in-flight scan instead of mixing coverage revisions",
      );
      processor.end_composite_selection();

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      assert.equal(
        processor.render_composite_area_highlight(
          compositeId,
          1,
          zoom,
          zoom,
          0,
          0,
        ),
        "highlight_done",
      );
      assert.deepEqual(
        readCanvasPixel(gl, 48, 64),
        [219, 219, 219, 219],
        "straight-alpha highlight blending must leave a premultiplied transparent canvas",
      );

      renderComposite(compositeId);
      assert.equal(pick(compositeId, -2), 1);
      assert.equal(pick(compositeId, 2), 1);
      assert.equal(pick(compositeId, 0), -1, "inactive code 10 must not pick");
      assert.equal(pick(compositeId, 4), 0, "visible code zero inside bounds must pick");
      assert.equal(pick(compositeId, 6), -1, "code zero outside bounds must not pick");

      const leftBefore = readNeighborhood(-2);
      const rightBefore = readNeighborhood(2);
      const centerBefore = readNeighborhood(0);
      assert.equal(
        processor.render_composite_area_highlight(
          compositeId,
          1,
          zoom,
          zoom,
          0,
          0,
        ),
        "highlight_done",
      );
      assert.equal(changed(leftBefore, readNeighborhood(-2)), true);
      assert.equal(
        changed(rightBefore, readNeighborhood(2)),
        true,
        "one coverage selection must highlight every disconnected area",
      );
      assert.equal(changed(centerBefore, readNeighborhood(0)), false);
      assert.equal(
        processor.render_composite_area_highlight(
          compositeId,
          2,
          zoom,
          zoom,
          0,
          0,
        ),
        "highlight_skipped",
        "inactive coverage cannot be highlighted",
      );

      renderComposite(compositeId);
      const zeroBefore = readNeighborhood(4);
      const outsideBefore = readNeighborhood(6);
      assert.equal(
        processor.render_composite_area_highlight(
          compositeId,
          0,
          zoom,
          zoom,
          0,
          0,
        ),
        "highlight_done",
      );
      assert.equal(changed(zeroBefore, readNeighborhood(4)), true);
      assert.equal(
        changed(outsideBefore, readNeighborhood(6)),
        false,
        "code zero highlight must remain clipped to the resolved outline",
      );

      processor.set_composite_inverted(compositeId, true);
      renderComposite(compositeId);
      assert.equal(pick(compositeId, -2), -1, "inversion hides a selected LUT code");
      assert.equal(pick(compositeId, 0), 2, "inversion activates an unselected LUT code");
      assert.equal(pick(compositeId, 4), -1, "inversion hides selected code zero");
      assert.equal(pick(compositeId, 6), -1, "inversion never activates outside bounds");
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        gl.destroy();
      }
    }
  },
);

test(
  "membership diagnostics count actual passes at a constrained texture-unit limit",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const rawGl = createWebGLRenderingContext({
      width: 128,
      height: 128,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const gl = new Proxy(rawGl, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "getParameter") {
          return (parameter) => parameter === target.MAX_TEXTURE_IMAGE_UNITS
            ? 4
            : value.call(target, parameter);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const processor = new wasm.GerberProcessor();
    try {
      processor.init_with_size(gl, 128, 128);
      const sourceIds = [];
      for (let slot = 0; slot < 24; slot += 1) {
        sourceIds.push(processor.add_layer(flashGerber(0)));
      }
      const compositeId = processor.add_composite_preset_with_bounds(
        new Uint32Array(sourceIds),
        "intersection",
        false,
        -5,
        5,
        -5,
        5,
      );
      processor.render_composite_selection(compositeId, 0.08, 0.08, 0, 0);
      const encoded = processor.get_composite_diagnostics(compositeId);
      assert.equal(encoded.encodePassCount, 6);
      assert.equal(encoded.membershipEncodeCount, 1);
      assert.equal(encoded.membershipEncodePassCount, 6);
      assert.equal(processor.pick_composite_code(compositeId, 64, 64), 0xffffff);

      processor.set_composite_visible_byte(compositeId, 2 * 1024 * 1024 - 1, 0x00);
      processor.render_composite_selection(compositeId, 0.08, 0.08, 0, 0);
      const toggled = processor.get_composite_diagnostics(compositeId);
      assert.equal(toggled.membershipEncodeCount, encoded.membershipEncodeCount);
      assert.equal(
        toggled.membershipEncodePassCount,
        encoded.membershipEncodePassCount,
      );
      assert.equal(toggled.lookupRenderCount, encoded.lookupRenderCount + 1);
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        rawGl.destroy();
      }
    }
  },
);

test(
  "composite LUT uses a zero-copy canonical width under non-power-of-two texture limits",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const rawGl = createWebGLRenderingContext({
      width: 128,
      height: 128,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const gl = new Proxy(rawGl, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "getParameter") {
          return (parameter) => parameter === target.MAX_TEXTURE_SIZE
            ? 3000
            : value.call(target, parameter);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const processor = new wasm.GerberProcessor();
    try {
      processor.init_with_size(gl, 128, 128);
      const sourceIds = [];
      for (let slot = 0; slot < 15; slot += 1) {
        sourceIds.push(processor.add_layer(flashGerber(0)));
      }
      const compositeId = processor.add_composite_preset_with_bounds(
        new Uint32Array(sourceIds),
        "intersection",
        false,
        -5,
        5,
        -5,
        5,
      );

      processor.render_composite_selection(compositeId, 0.08, 0.08, 0, 0);
      const diagnostics = processor.get_composite_diagnostics(compositeId);
      assert.equal(diagnostics.gpuLookupBytes, 4096);
      assert.equal(diagnostics.encodePassCount, 2);
      assert.equal(processor.pick_composite_code(compositeId, 64, 64), 0x7fff);
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        rawGl.destroy();
      }
    }
  },
);

test(
  "membership encoding disables dithering for exact bytes and restores caller state",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({
      processor,
      gl,
      dummyId,
      resetDitherObservations,
      getDitherObservations,
    }) => {
      const sourceId = processor.add_layer(filledRegionGerber());

      gl.enable(gl.DITHER);
      resetDitherObservations();
      const compositeId = createSelectionComposite(processor, sourceId, dummyId);
      let observations = getDitherObservations();
      assert.ok(observations.disableCount >= 1);
      assert.ok(observations.drawsWhileDisabled >= 1);
      assert.equal(gl.isEnabled(gl.DITHER), true);

      gl.disable(gl.DITHER);
      resetDitherObservations();
      processor.render_composite_selection(compositeId, 0.051, 0.05, 0, 0);
      observations = getDitherObservations();
      assert.ok(observations.disableCount >= 1);
      assert.ok(observations.drawsWhileDisabled >= 1);
      assert.equal(gl.isEnabled(gl.DITHER), false);
    }, { monitorDither: true });
  },
);

test(
  "composite rendering isolates hostile raster rejection state and restores it",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({
      processor,
      gl,
      dummyId,
      pick,
      getStencilZeroClearCount,
    }) => {
      const sourceId = processor.add_layer(filledRegionGerber());
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(3, 5, 7, 11);
      gl.colorMask(false, true, false, true);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.FRONT_AND_BACK);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.NEVER);
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.NEVER, 7, 0x3f);
      gl.stencilMask(0x5a);
      gl.stencilOp(gl.REPLACE, gl.INCR, gl.DECR);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.enable(gl.SAMPLE_COVERAGE);
      gl.sampleCoverage(0, false);
      setHostileViewportAndBlendState(gl);

      const compositeId = createSelectionComposite(processor, sourceId, dummyId);
      assert.equal(pick(compositeId, 0, 0), 1);
      processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0);
      assert.equal(pick(compositeId, 0, 0), 1, "the cached render must remain valid");
      assert.ok(getStencilZeroClearCount() >= 1);
      assertHostileViewportAndBlendState(gl);

      processor.end_composite_selection();
      processor.render_with_clear(
        new Uint32Array([compositeId]),
        new Float32Array([0, 1, 0, 1]),
        0.05,
        0.05,
        0,
        0,
        1,
        true,
      );
      assertHostileViewportAndBlendState(gl);
      assert.equal(gl.isEnabled(gl.SCISSOR_TEST), true);
      assert.deepEqual([...gl.getParameter(gl.SCISSOR_BOX)], [3, 5, 7, 11]);
      assert.deepEqual(
        [...gl.getParameter(gl.COLOR_WRITEMASK)],
        [false, true, false, true],
      );
      assert.equal(gl.isEnabled(gl.CULL_FACE), true);
      assert.equal(gl.getParameter(gl.CULL_FACE_MODE), gl.FRONT_AND_BACK);
      assert.equal(gl.isEnabled(gl.DEPTH_TEST), true);
      assert.equal(gl.getParameter(gl.DEPTH_FUNC), gl.NEVER);
      assert.equal(gl.isEnabled(gl.STENCIL_TEST), true);
      assert.equal(gl.getParameter(gl.STENCIL_FUNC), gl.NEVER);
      assert.equal(gl.getParameter(gl.STENCIL_REF), 7);
      assert.equal(gl.getParameter(gl.STENCIL_VALUE_MASK), 0x3f);
      assert.equal(gl.getParameter(gl.STENCIL_WRITEMASK), 0x5a);
      assert.equal(gl.getParameter(gl.STENCIL_FAIL), gl.REPLACE);
      assert.equal(gl.getParameter(gl.STENCIL_PASS_DEPTH_FAIL), gl.INCR);
      assert.equal(gl.getParameter(gl.STENCIL_PASS_DEPTH_PASS), gl.DECR);
      assert.equal(gl.isEnabled(gl.RASTERIZER_DISCARD), true);
      assert.equal(gl.isEnabled(gl.SAMPLE_ALPHA_TO_COVERAGE), true);
      assert.equal(gl.isEnabled(gl.SAMPLE_COVERAGE), true);
      assert.equal(gl.getParameter(gl.SAMPLE_COVERAGE_VALUE), 0);
      assert.equal(gl.getParameter(gl.SAMPLE_COVERAGE_INVERT), false);
    }, { monitorStencilClear: true });
  },
);

test(
  "composite selection errors restore caller viewport and blend state",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({
      processor,
      gl,
      dummyId,
      forceNextR8Failure,
      getStencilZeroClearCount,
    }) => {
      const sourceId = processor.add_layer(filledRegionGerber());
      const compositeId = processor.add_composite_layer_with_bounds(
        new Uint32Array([sourceId, dummyId]),
        new Uint8Array([0b00001110]),
        false,
        -5,
        5,
        -5,
        5,
      );
      setHostileViewportAndBlendState(gl);
      forceNextR8Failure();
      assert.throws(
        () => processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0),
        /WebGL error 0x505/,
      );
      assert.ok(getStencilZeroClearCount() >= 1);
      assertHostileViewportAndBlendState(gl);
    }, { r8FailureMode: "fatal", monitorStencilClear: true });
  },
);

test(
  "internal outline masks fall back to RGBA8 when the first R8 allocation is unsupported",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({
      processor,
      dummyId,
      forceNextR8Failure,
      wasR8FailureForced,
      rgbaAllocationsAfterR8Failure,
    }) => {
      const sourceId = processor.add_layer(flashGerber(0));
      forceNextR8Failure();
      const compositeId = processor.add_composite_layer_with_bounds(
        new Uint32Array([sourceId, dummyId]),
        new Uint8Array([0b00001110]),
        false,
        -5,
        5,
        -5,
        5,
      );
      assert.equal(wasR8FailureForced(), true);
      assert.ok(
        rgbaAllocationsAfterR8Failure() >= 1,
        "the internal outline must retry with a red-channel RGBA8 mask",
      );
      let diagnostics = processor.get_composite_diagnostics(compositeId);
      assert.equal(diagnostics.outlineFormat, "RGBA8");
      assert.equal(diagnostics.sharedOutlineBytes, 256 * 256 * 4);
      processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0);
      assert.equal(processor.pick_composite_code(compositeId, 128, 128), 1);

      processor.end_composite_selection();
      processor.resize_to(192, 128);
      diagnostics = processor.get_composite_diagnostics(compositeId);
      assert.equal(diagnostics.outlineFormat, "R8");
      assert.equal(diagnostics.sharedOutlineBytes, 192 * 128);

      forceNextR8Failure();
      processor.resize_to(160, 96);
      diagnostics = processor.get_composite_diagnostics(compositeId);
      assert.equal(wasR8FailureForced(), true);
      assert.equal(diagnostics.outlineFormat, "RGBA8");
      assert.equal(diagnostics.sharedOutlineBytes, 160 * 96 * 4);
      processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0);
      assert.equal(processor.pick_composite_code(compositeId, 80, 48), 1);
    }, { r8FailureMode: "unsupported" });
  },
);

test(
  "composite output uses RGBA8 only when the R8 format is unsupported",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({
      processor,
      dummyId,
      forceNextR8Failure,
      wasR8FailureForced,
      rgbaAllocationsAfterR8Failure,
      gl,
    }) => {
      const sourceId = processor.add_layer(flashGerber(0));
      const compositeId = processor.add_composite_layer_with_bounds(
        new Uint32Array([sourceId, dummyId]),
        new Uint8Array([0b00001110]),
        false,
        -5,
        5,
        -5,
        5,
      );
      forceNextR8Failure();
      processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0);
      assert.equal(wasR8FailureForced(), true);
      const diagnostics = processor.get_composite_diagnostics(compositeId);
      assert.equal(diagnostics.outputFormat, "RGBA8");
      assert.equal(diagnostics.outlineFormat, "R8");
      assert.equal(diagnostics.gpuLookupBytes, 1);
      assert.equal(processor.pick_composite_code(compositeId, 128, 128), 1);
      assert.ok(
        rgbaAllocationsAfterR8Failure() >= 1,
        "unsupported R8 output must allocate an RGBA8 mask fallback",
      );

      processor.end_composite_selection();
      const ids = new Uint32Array([compositeId]);
      const green = new Float32Array([0, 1, 0, 1]);
      processor.render_with_clear(ids, green, 0.05, 0.05, 0, 0, 1, true);
      assert.deepEqual(readCanvasPixel(gl, 128, 128), [0, 255, 0, 255]);
      assert.deepEqual(readCanvasPixel(gl, 0, 0), [0, 0, 0, 0]);
      assert.equal(
        processor.pick_composite_area(compositeId, 128, 128, 0.05, 0.05, 0, 0),
        1,
        "RGBA8 fallback output remains selectable",
      );
      assert.equal(
        processor.pick_composite_area(compositeId, 0, 0, 0.05, 0.05, 0, 0),
        -1,
        "RGBA8 fallback rejects inactive output pixels",
      );

      processor.render_with_clear_and_blend_modes(
        ids,
        green,
        new Uint8Array([1]),
        0.05,
        0.05,
        0,
        0,
        1,
        true,
      );
      assert.deepEqual(readCanvasPixel(gl, 128, 128), [0, 255, 0, 255]);
      assert.deepEqual(readCanvasPixel(gl, 0, 0), [0, 0, 0, 0]);
    }, { r8FailureMode: "unsupported" });
  },
);

test(
  "fresh offscreen exports clear poisoned RGBA storage even when legacy clear is false",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({ processor, dummyId }) => {
      const sourceId = processor.add_layer(flashGerber(0));
      const compositeId = processor.add_composite_preset_with_bounds(
        new Uint32Array([sourceId, dummyId]),
        "union",
        false,
        -5,
        5,
        -5,
        5,
      );
      const ids = new Uint32Array([compositeId]);
      const colors = new Float32Array([0.25, 0.75, 1, 0.8]);
      const render = (clearCanvas) => processor.render_pixels_with_clear(
        ids,
        colors,
        -0.05,
        0.05,
        0.1,
        -0.08,
        1,
        clearCanvas,
      );
      const first = render(false);
      const repeated = render(false);
      const explicitClear = render(true);
      assert.deepEqual(repeated, first);
      assert.deepEqual(explicitClear, first);
      assert.deepEqual([...first.subarray(0, 4)], [0, 0, 0, 0]);

      const stacked = processor.render_pixels_with_clear_and_blend_modes(
        ids,
        colors,
        new Uint8Array([1]),
        -0.05,
        0.05,
        0.1,
        -0.08,
        1,
        false,
      );
      const stackedClear = processor.render_pixels_with_clear_and_blend_modes(
        ids,
        colors,
        new Uint8Array([1]),
        -0.05,
        0.05,
        0.1,
        -0.08,
        1,
        true,
      );
      assert.deepEqual(stacked, stackedClear);
      assert.deepEqual([...stacked.subarray(0, 4)], [0, 0, 0, 0]);
    }, { poisonRgbaAllocations: true });
  },
);

test(
  "R8 and RGBA8 fallback masks produce identical signed-camera export pixels",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const render = async (r8FailureMode) => {
      let pixels;
      let outputFormat;
      await withCompositeProcessor(async ({
        processor,
        dummyId,
        forceNextR8Failure,
      }) => {
        const sourceId = processor.add_layer(multiPointFlashGerber([
          [-3, -2],
          [1, 3],
          [4, -1],
        ], 1.1));
        const compositeId = processor.add_composite_preset_with_bounds(
          new Uint32Array([sourceId, dummyId]),
          "union",
          false,
          -6,
          6,
          -5,
          5,
        );
        if (r8FailureMode) forceNextR8Failure();
        pixels = processor.render_pixels_with_clear_and_blend_modes(
          new Uint32Array([compositeId]),
          new Float32Array([0.2, 0.7, 1, 0.65]),
          new Uint8Array([1]),
          -0.065,
          0.075,
          0.11,
          -0.09,
          1,
          true,
        );
        outputFormat = processor.get_composite_diagnostics(compositeId).outputFormat;
      }, r8FailureMode ? { r8FailureMode } : undefined);
      return { pixels, outputFormat };
    };

    const native = await render(null);
    const fallback = await render("unsupported");
    assert.equal(native.outputFormat, "R8");
    assert.equal(fallback.outputFormat, "RGBA8");
    assert.deepEqual(fallback.pixels, native.pixels);
  },
);

test(
  "odd-width offscreen readback normalizes and restores hostile PACK_ALIGNMENT",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const rawGl = createWebGLRenderingContext({
      width: 97,
      height: 11,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const failure = compositeStageFailureProxy(rawGl);
    const processor = new wasm.GerberProcessor();
    try {
      processor.init_with_size(failure.gl, 97, 11);
      const first = processor.add_layer(flashGerber(0));
      const second = processor.add_layer(flashGerber(3));
      const compositeId = processor.add_composite_preset_with_bounds(
        new Uint32Array([first, second]),
        "union",
        false,
        -5,
        5,
        -5,
        5,
      );
      const ids = new Uint32Array([compositeId]);
      const colors = new Float32Array([0, 1, 0, 1]);
      rawGl.pixelStorei(rawGl.PACK_ALIGNMENT, 8);
      const expected = processor.render_pixels_with_clear(
        ids, colors, 0.08, 0.08, 0, 0, 1, true,
      );
      assert.equal(expected.length, 97 * 11 * 4);
      assert.equal(rawGl.getParameter(rawGl.PACK_ALIGNMENT), 8);

      failure.armReadFailure();
      assert.throws(
        () => processor.render_pixels_with_clear(
          ids, colors, 0.08, 0.08, 0, 0, 1, true,
        ),
        /Rendered output readback failed/,
      );
      assert.equal(rawGl.getParameter(rawGl.PACK_ALIGNMENT), 8);
      assert.deepEqual(
        processor.render_pixels_with_clear_and_blend_modes(
          ids,
          colors,
          new Uint8Array([1]),
          0.08,
          0.08,
          0,
          0,
          1,
          true,
        ),
        expected,
      );
      assert.equal(rawGl.getParameter(rawGl.PACK_ALIGNMENT), 8);
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        rawGl.destroy();
      }
    }
  },
);

test(
  "composite uploads and readbacks normalize and restore caller pixel-store layout",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({
      processor,
      gl,
      dummyId,
      forceNextLutUploadFailure,
    }) => {
      const sourceId = processor.add_layer(flashGerber(0));
      const unpackState = [
        [gl.UNPACK_ALIGNMENT, 8],
        [gl.UNPACK_ROW_LENGTH, 7],
        [gl.UNPACK_IMAGE_HEIGHT, 5],
        [gl.UNPACK_SKIP_PIXELS, 1],
        [gl.UNPACK_SKIP_ROWS, 1],
        [gl.UNPACK_SKIP_IMAGES, 1],
      ];
      const packState = [
        [gl.PACK_ALIGNMENT, 8],
        [gl.PACK_ROW_LENGTH, 7],
        [gl.PACK_SKIP_PIXELS, 1],
        [gl.PACK_SKIP_ROWS, 1],
      ];
      const setPixelStoreState = (states) => {
        for (const [parameter, value] of states) gl.pixelStorei(parameter, value);
      };
      const assertPixelStoreState = (states) => {
        for (const [parameter, value] of states) {
          assert.equal(gl.getParameter(parameter), value);
        }
      };

      setPixelStoreState(unpackState);
      const compositeId = createSelectionComposite(processor, sourceId, dummyId);
      assertPixelStoreState(unpackState);

      processor.set_composite_visible_byte(compositeId, 0, 0b00000110);
      assertPixelStoreState(unpackState);

      forceNextLutUploadFailure();
      assert.throws(
        () => processor.set_composite_visible_byte(compositeId, 0, 0b00001110),
        /WebGL error 0x505/,
      );
      assertPixelStoreState(unpackState);

      setPixelStoreState(packState);
      assert.equal(processor.pick_composite_code(compositeId, 128, 128), 1);
      assert.ok(
        processor.get_composite_area_codes_band(compositeId, 0, 64).length > 0,
      );
      assertPixelStoreState(packState);
      assertPixelStoreState(unpackState);
    }, { monitorLutUpload: true });
  },
);

test(
  "composite GPU paths preserve hostile caller object bindings and use an owned fullscreen VAO",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({
      processor,
      gl,
      dummyId,
      pick,
      forceNextR8Failure,
      forceNextLutUploadFailure,
    }) => {
      const sourceId = processor.add_layer(flashGerber(0));
      const compositeId = createSelectionComposite(processor, sourceId, dummyId);
      processor.end_composite_selection();
      const state = createHostileObjectBindingState(gl);
      try {
        processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0);
        assertHostileObjectBindingState(gl, state);
        assert.ok(processor.get_composite_area_codes(compositeId).length > 0);
        assertHostileObjectBindingState(gl, state);
        const previewPixel = readDefaultFramebufferPixel(gl, state, 128, 128);
        assert.ok(
          previewPixel[3] > 0,
          `the owned fullscreen VAO must render despite caller divisor state: ${previewPixel}`,
        );

        assert.equal(pick(compositeId, 0, 0), 1);
        assertHostileObjectBindingState(gl, state);

        processor.end_composite_selection();
        const pixels = processor.render_pixels_with_clear(
          new Uint32Array([compositeId]),
          new Float32Array([0, 1, 0, 1]),
          0.05,
          0.05,
          0,
          0,
          1,
          true,
        );
        const center = (128 * 256 + 128) * 4;
        assert.deepEqual([...pixels.slice(center, center + 4)], [0, 255, 0, 255]);
        assertHostileObjectBindingState(gl, state);

        processor.set_composite_visible_byte(compositeId, 0, 0b00000110);
        assertHostileObjectBindingState(gl, state);
        forceNextLutUploadFailure();
        assert.throws(
          () => processor.set_composite_visible_byte(compositeId, 0, 0b00001110),
          /WebGL error 0x505/,
        );
        assertHostileObjectBindingState(gl, state);

        const failingComposite = processor.add_composite_layer_with_bounds(
          new Uint32Array([sourceId, dummyId]),
          new Uint8Array([0b00001110]),
          false,
          -6,
          6,
          -6,
          6,
        );
        assertHostileObjectBindingState(gl, state);
        forceNextR8Failure();
        assert.throws(
          () => processor.render_composite_selection(failingComposite, 0.05, 0.05, 0, 0),
          /WebGL error 0x505/,
        );
        assertHostileObjectBindingState(gl, state);
      } finally {
        disposeHostileObjectBindingState(gl, state);
      }
    }, { r8FailureMode: "fatal", monitorLutUpload: true });
  },
);

test(
  "composite canvas rendering overrides and restores a default NONE draw buffer",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({ processor, gl, dummyId }) => {
      const sourceId = processor.add_layer(flashGerber(0));
      const compositeId = createSelectionComposite(processor, sourceId, dummyId);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.drawBuffers([gl.NONE]);

      processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0);
      const drawFramebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      assert.ok(drawFramebuffer == null || drawFramebuffer === 0);
      assert.equal(gl.getParameter(gl.DRAW_BUFFER0), gl.NONE);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      const pixel = readCanvasPixel(gl, 128, 128);
      assert.ok(pixel[3] > 0, `default framebuffer draw must not be suppressed: ${pixel}`);

      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.drawBuffers([gl.BACK]);
    });
  },
);

test(
  "failed membership encoding invalidates the shared scratch owner",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({
      processor,
      dummyId,
      forceNextTextureUnitQueryFailure,
    }) => {
      const first = processor.add_layer(flashGerber(0));
      const second = processor.add_layer(flashGerber(4));
      const sources = new Uint32Array([first, second]);
      const owner = processor.add_composite_layer_with_bounds(
        sources,
        new Uint8Array([0b00001110]),
        false,
        -6,
        6,
        -6,
        6,
      );
      processor.render_composite_selection(owner, 0.05, 0.05, 0, 0);
      processor.end_composite_selection();
      const before = processor.get_composite_diagnostics(owner);
      assert.equal(before.membershipEncodeCount, 1);

      const failing = processor.add_composite_layer_with_bounds(
        new Uint32Array([first, dummyId]),
        new Uint8Array([0b00001110]),
        false,
        -7,
        7,
        -7,
        7,
      );
      forceNextTextureUnitQueryFailure();
      assert.throws(
        () => processor.render_composite_selection(failing, 0.05, 0.05, 0, 0),
        /forced membership texture-unit query failure/,
      );

      processor.set_composite_visible_byte(owner, 0, 0b00000110);
      processor.render_composite_selection(owner, 0.05, 0.05, 0, 0);
      const after = processor.get_composite_diagnostics(owner);
      assert.equal(
        after.membershipEncodeCount,
        before.membershipEncodeCount + 1,
        "lookup-only dirtiness must not reuse scratch modified by the failed composite",
      );
    }, { monitorTextureUnitQuery: true });
  },
);

test(
  "selection picking requires exclusive, successfully refreshed scratch ownership",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({
      processor,
      dummyId,
      forceNextTextureUnitQueryFailure,
    }) => {
      const sourceId = processor.add_layer(flashGerber(0));
      const compositeId = createSelectionComposite(processor, sourceId, dummyId);
      assert.equal(processor.pick_composite_code(compositeId, 128, 128), 1);

      assert.throws(
        () => processor.render(
          new Uint32Array([compositeId]),
          new Float32Array([0, 1, 0, 1]),
          0.05,
          0.05,
          0,
          0,
          1,
        ),
        /Cannot render layers while a composite selection preview is active/,
      );
      assert.equal(
        processor.pick_composite_code(compositeId, 128, 128),
        1,
        "a rejected ordinary render must leave the selected membership intact",
      );

      processor.set_minimum_feature_pixels(2);
      assert.throws(
        () => processor.pick_composite_code(compositeId, 128, 128),
        /selection membership is stale/,
      );
      forceNextTextureUnitQueryFailure();
      assert.throws(
        () => processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0),
        /forced membership texture-unit query failure/,
      );
      assert.throws(
        () => processor.pick_composite_code(compositeId, 128, 128),
        /selection preview is not active/,
        "a failed refresh must not reactivate the previous preview",
      );

      processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0);
      assert.equal(processor.pick_composite_code(compositeId, 128, 128), 1);
      processor.resize();
      assert.throws(
        () => processor.pick_composite_code(compositeId, 128, 128),
        /selection membership is stale/,
        "resizing must not expose the released membership scratch",
      );
      processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0);
      assert.equal(processor.pick_composite_code(compositeId, 128, 128), 1);
    }, { monitorTextureUnitQuery: true });
  },
);

test(
  "selection camera validation preserves the previous valid preview",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({ processor, dummyId }) => {
      const sourceId = processor.add_layer(flashGerber(0));
      const compositeId = createSelectionComposite(processor, sourceId, dummyId);
      const before = processor.get_composite_diagnostics(compositeId);
      assert.equal(processor.pick_composite_code(compositeId, 128, 128), 1);

      for (const [camera, expectedError] of [
        [[0, 0.05, 0, 0], /Camera zoom must be non-zero/],
        [[Number.NaN, 0.05, 0, 0], /zoom_x is not finite/],
        [[0.05, Number.POSITIVE_INFINITY, 0, 0], /zoom_y is not finite/],
        [[0.05, 0.05, Number.NaN, 0], /offset_x is not finite/],
        [[0.05, 0.05, 0, Number.NEGATIVE_INFINITY], /offset_y is not finite/],
      ]) {
        assert.throws(
          () => processor.render_composite_selection(compositeId, ...camera),
          expectedError,
        );
        assert.equal(
          processor.pick_composite_code(compositeId, 128, 128),
          1,
          "invalid camera input must not invalidate the previous preview",
        );
      }

      const after = processor.get_composite_diagnostics(compositeId);
      assert.equal(after.membershipEncodeCount, before.membershipEncodeCount);
      assert.equal(after.lookupRenderCount, before.lookupRenderCount);
    });
  },
);

test(
  "selection picking rejects source-style and bounds mutations until refresh",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({ processor, dummyId, pick }) => {
      const thinFlash = `%FSLAX24Y24*%
%MOMM*%
%ADD10C,0.100*%
D10*
X000000Y000000D03*
M02*`;
      const sourceId = processor.add_layer(thinFlash);
      const sourceComposite = createSelectionComposite(processor, sourceId, dummyId);
      assert.equal(pick(sourceComposite, 0.5, 0), 0);

      processor.set_layer_feature_extra_pixels(sourceId, 8);
      assert.throws(
        () => pick(sourceComposite, 0.5, 0),
        /selection membership is stale/,
      );
      processor.render_composite_selection(sourceComposite, 0.05, 0.05, 0, 0);
      assert.equal(pick(sourceComposite, 0.5, 0), 1);
      processor.end_composite_selection();

      const distantSource = processor.add_layer(flashGerber(10));
      const boundsComposite = processor.add_composite_layer_with_bounds(
        new Uint32Array([distantSource, dummyId]),
        new Uint8Array([0b00000001]),
        false,
        -5,
        15,
        -5,
        5,
      );
      processor.render_composite_selection(boundsComposite, 0.05, 0.05, 0, 0);
      assert.equal(pick(boundsComposite, 0, 0), 0);

      processor.set_composite_bounds(boundsComposite, -1, 1, -1, 1);
      assert.throws(
        () => pick(boundsComposite, 0, 0),
        /selection membership is stale/,
      );
      processor.render_composite_selection(boundsComposite, 0.05, 0.05, 0, 0);
      assert.equal(pick(boundsComposite, 0, 0), 0);
    });
  },
);

test(
  "renderer initialization preserves hostile caller object bindings",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const rawGl = createWebGLRenderingContext({
      width: 128,
      height: 128,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const bufferFailure = bufferUploadFailureProxy(rawGl);
    const gl = bufferFailure.gl;
    const state = createHostileObjectBindingState(gl);
    const processor = new wasm.GerberProcessor();
    let freed = false;
    try {
      bufferFailure.force("bufferData");
      assert.throws(
        () => processor.init_with_size(gl, 128, 128),
        /WebGL bufferData failed/,
      );
      assertHostileObjectBindingState(gl, state);

      processor.init_with_size(gl, 128, 128);
      assertHostileObjectBindingState(gl, state);
      processor.free();
      freed = true;
      assertHostileObjectBindingState(gl, state);
    } finally {
      if (!freed) processor.free();
      disposeHostileObjectBindingState(gl, state);
      rawGl.destroy();
    }
  },
);

test(
  "layer addition and resize preserve hostile caller object bindings",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({
      processor,
      gl,
      forceNextTextureAllocationFailure,
    }) => {
      const state = createHostileObjectBindingState(gl);
      try {
        processor.add_layer(flashGerber(0));
        assertHostileObjectBindingState(gl, state);

        forceNextTextureAllocationFailure();
        assert.throws(
          () => processor.add_layer(flashGerber(4)),
          /WebGL error 0x505/,
        );
        assertHostileObjectBindingState(gl, state);

        processor.resize_to(128, 128);
        assertHostileObjectBindingState(gl, state);

        forceNextTextureAllocationFailure();
        assert.throws(() => processor.resize_to(64, 64), /WebGL error 0x505/);
        assertHostileObjectBindingState(gl, state);
      } finally {
        disposeHostileObjectBindingState(gl, state);
      }
    }, { monitorTextureAllocation: true });
  },
);

test(
  "restore_context_with_size commits dimensions only after complete GPU recovery",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const createContext = (size) => createWebGLRenderingContext({
      width: size,
      height: size,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });

    for (const failureMode of [
      "released-geometry",
      "late-texture-allocation",
      "quad-bufferData",
      "quad-bufferSubData",
    ]) {
      const oldGl = createContext(64);
      const replacementRawGl = createContext(128);
      const replacementBufferFailure = bufferUploadFailureProxy(replacementRawGl);
      const replacementBaseGl = failureMode.startsWith("quad-")
        ? replacementBufferFailure.gl
        : replacementRawGl;
      let forceTextureFailure = failureMode === "late-texture-allocation";
      const replacementGl = new Proxy(replacementBaseGl, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "createTexture") {
            return () => {
              if (forceTextureFailure) {
                forceTextureFailure = false;
                return null;
              }
              return value.call(target);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const processor = new wasm.GerberProcessor();
      try {
        processor.init_with_size(oldGl, 64, 64);
        const first = processor.add_layer(flashGerber(0));
        const second = processor.add_layer(flashGerber(4));
        const compositeId = processor.add_composite_layer_with_bounds(
          new Uint32Array([first, second]),
          new Uint8Array([0b00001110]),
          false,
          -6,
          6,
          -6,
          6,
        );
        if (failureMode === "released-geometry") {
          processor.render_composite_selection(compositeId, 0.1, 0.1, 0, 0);
          assert.equal(processor.pick_composite_code(compositeId, 32, 32), 1);
        }
        assert.equal(processor.get_composite_diagnostics(compositeId).viewportWidth, 64);
        if (failureMode.startsWith("quad-")) {
          replacementBufferFailure.force(failureMode.slice("quad-".length));
        }

        assert.throws(
          () => processor.restore_context_with_size(replacementGl, 128, 128),
          failureMode === "released-geometry"
            ? /Layer geometry has been released/
            : failureMode === "late-texture-allocation"
              ? /Failed to create texture/
              : new RegExp(`WebGL ${failureMode.slice("quad-".length)} failed with error 0x505`),
        );
        if (failureMode.startsWith("quad-")) {
          assert.equal(
            replacementBufferFailure.wasFailedBufferDeleted(),
            true,
            "failed replacement quad buffer must be deleted",
          );
        }
        assert.equal(
          processor.get_composite_diagnostics(compositeId).viewportWidth,
          64,
          `${failureMode} must preserve the committed framebuffer dimensions`,
        );
        if (failureMode === "released-geometry") {
          assert.equal(
            processor.pick_composite_code(compositeId, 32, 32),
            1,
            "an early failure must preserve the old selection and GPU resources",
          );
        } else {
          processor.render_composite_selection(compositeId, 0.1, 0.1, 0, 0);
          assert.equal(
            processor.pick_composite_code(compositeId, 32, 32),
            1,
            "a late allocation failure must leave the old renderer usable",
          );
        }
      } finally {
        try {
          processor.clear();
        } finally {
          processor.free();
          oldGl.destroy();
          replacementRawGl.destroy();
        }
      }
    }
  },
);

test(
  "context recovery preserves replacement-context object bindings on failure and success",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const createContext = () => createWebGLRenderingContext({
      width: 64,
      height: 64,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const oldGl = createContext();
    const replacementRawGl = createContext();
    const replacementFailure = bufferUploadFailureProxy(replacementRawGl);
    const processor = new wasm.GerberProcessor();
    let hostileState;
    try {
      processor.init_with_size(oldGl, 64, 64);
      processor.add_layer(flashGerber(0));
      hostileState = createHostileObjectBindingState(replacementFailure.gl);

      replacementFailure.force("bufferData");
      assert.throws(
        () => processor.restore_context_with_size(replacementFailure.gl, 64, 64),
        /WebGL bufferData failed with error 0x505/,
      );
      assertHostileObjectBindingState(replacementFailure.gl, hostileState);
      assert.equal(replacementFailure.wasFailedBufferDeleted(), true);

      processor.restore_context_with_size(replacementFailure.gl, 64, 64);
      assertHostileObjectBindingState(replacementFailure.gl, hostileState);
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        if (hostileState) {
          disposeHostileObjectBindingState(replacementFailure.gl, hostileState);
        }
        oldGl.destroy();
        replacementRawGl.destroy();
      }
    }
  },
);

test(
  "buffer upload failures abort initialization, clean the buffer, and allow retry",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");

    for (const operation of ["bufferData", "bufferSubData"]) {
      const rawGl = createWebGLRenderingContext({
        width: 64,
        height: 64,
        majorVersion: 3,
        minorVersion: 0,
        webGLCompatibility: true,
      });
      const failure = bufferUploadFailureProxy(rawGl);
      const processor = new wasm.GerberProcessor();
      try {
        failure.force(operation);
        assert.throws(
          () => processor.init_with_size(failure.gl, 64, 64),
          new RegExp(`WebGL ${operation} failed with error 0x505`),
        );
        assert.equal(
          failure.wasFailedBufferDeleted(),
          true,
          `${operation} failure must delete the partial quad buffer`,
        );

        processor.init_with_size(failure.gl, 64, 64);
        const layerId = processor.add_layer(flashGerber(0));
        processor.render(
          new Uint32Array([layerId]),
          new Float32Array([1, 0, 0, 1]),
          0.1,
          0.1,
          0,
          0,
          1,
        );
      } finally {
        try {
          processor.clear();
        } finally {
          processor.free();
          rawGl.destroy();
        }
      }
    }
  },
);

test(
  "lazy Gerber buffer upload failures keep CPU geometry for a clean retry",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    for (const operation of ["bufferData", "bufferSubData"]) {
      for (const occurrence of [1, 2]) {
        await withCompositeProcessor(async ({
          processor,
          dummyId,
          forceNextBufferUploadFailure,
          wasFailedBufferDeleted,
          wereCreatedBuffersDeleted,
        }) => {
          const sourceId = processor.add_layer(flashGerber(0));
          const compositeId = processor.add_composite_layer_with_bounds(
            new Uint32Array([sourceId, dummyId]),
            new Uint8Array([0b00001110]),
            false,
            -5,
            5,
            -5,
            5,
          );

          forceNextBufferUploadFailure(operation, occurrence);
          assert.throws(
            () => processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0),
            new RegExp(`WebGL ${operation} failed with error 0x505`),
          );
          assert.equal(wasFailedBufferDeleted(), true);
          assert.equal(
            wereCreatedBuffersDeleted(),
            true,
            "all buffers from a partially built lazy cache must be deleted",
          );

          processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0);
          assert.equal(
            processor.pick_composite_code(compositeId, 128, 128),
            1,
            `${operation} failure must leave source geometry available for retry`,
          );
        }, { monitorBufferUpload: true });
      }
    }
  },
);

test(
  "offscreen rendering rejects MAX_TEXTURE_SIZE before allocating RGBA output",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const rawGl = createWebGLRenderingContext({
      width: 64,
      height: 64,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const gl = new Proxy(rawGl, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "getParameter") {
          return (parameter) => parameter === target.MAX_TEXTURE_SIZE
            ? 64
            : value.call(target, parameter);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const processor = new wasm.GerberProcessor();
    try {
      processor.init_with_size(gl, 32_768, 32_768);
      for (const render of [
        () => processor.render_pixels_with_clear(
          new Uint32Array(),
          new Float32Array(),
          1,
          1,
          0,
          0,
          1,
          true,
        ),
        () => processor.render_pixels_with_clear_and_blend_modes(
          new Uint32Array(),
          new Float32Array(),
          new Uint8Array(),
          1,
          1,
          0,
          0,
          1,
          true,
        ),
      ]) {
        assert.throws(
          render,
          /Canvas size 32768x32768 exceeds MAX_TEXTURE_SIZE 64/,
        );
      }
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        rawGl.destroy();
      }
    }
  },
);

test(
  "fatal R8 allocation errors do not attempt the larger RGBA8 fallback",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({
      processor,
      dummyId,
      forceNextR8Failure,
      wasR8FailureForced,
      rgbaAllocationsAfterR8Failure,
      gl,
    }) => {
      const sourceId = processor.add_layer(flashGerber(0));
      const compositeId = processor.add_composite_layer_with_bounds(
        new Uint32Array([sourceId, dummyId]),
        new Uint8Array([0b00001110]),
        false,
        -5,
        5,
        -5,
        5,
      );
      setHostileViewportAndBlendState(gl);
      forceNextR8Failure();
      processor.render(
        new Uint32Array([sourceId, compositeId]),
        new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]),
        0.05,
        0.05,
        0,
        0,
        1,
      );

      assert.equal(wasR8FailureForced(), true);
      assert.equal(rgbaAllocationsAfterR8Failure(), 0);
      assertHostileViewportAndBlendState(gl);
      assert.match(
        processor.get_composite_error(compositeId),
        /WebGL error 0x505/,
      );
      assert.deepEqual(
        readCanvasPixel(gl, 128, 128),
        [255, 0, 0, 255],
        "the healthy ordinary layer must still render",
      );
    }, { r8FailureMode: "fatal" });
  },
);

test(
  "composite GL stage failures isolate ordinary layers and retry cleanly",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");

    for (const [stage, drawOccurrence, expectedError] of [
      ["source", 1, /Gerber mask rendering failed with WebGL error 0x505/],
      ["membership", 1, /Composite membership rendering failed with WebGL error 0x505/],
      ["lookup", 2, /Composite lookup rendering failed with WebGL error 0x505/],
      ["final", 3, /Composite final draw failed with WebGL error 0x505/],
    ]) {
      const rawGl = createWebGLRenderingContext({
        width: 128,
        height: 128,
        majorVersion: 3,
        minorVersion: 0,
        webGLCompatibility: true,
      });
      const failure = compositeStageFailureProxy(rawGl);
      const processor = new wasm.GerberProcessor();
      try {
        processor.init_with_size(failure.gl, 128, 128);
        const first = processor.add_layer(flashGerber(0));
        const second = processor.add_layer(flashGerber(0));
        const healthy = processor.add_layer(flashGerber(0));
        if (stage !== "source") {
          processor.render(
            new Uint32Array([first, second, healthy]),
            new Float32Array(12).fill(1),
            0.08,
            0.08,
            0,
            0,
            1,
          );
        }
        const compositeId = processor.add_composite_preset_with_bounds(
          new Uint32Array([first, second]),
          "union",
          false,
          -5,
          5,
          -5,
          5,
        );
        if (stage !== "source") {
          processor.render_composite_selection(compositeId, 0.08, 0.08, 0, 0);
          processor.end_composite_selection();
          processor.release_composite_cache(compositeId);
        }
        const beforeFailure = processor.get_composite_diagnostics(compositeId);

        failure.armDrawFailure(drawOccurrence);
        processor.render(
          new Uint32Array([compositeId, healthy]),
          new Float32Array([0, 1, 0, 1, 1, 0, 0, 1]),
          0.08,
          0.08,
          0,
          0,
          1,
        );
        assert.match(processor.get_composite_error(compositeId), expectedError);
        const afterFailure = processor.get_composite_diagnostics(compositeId);
        if (stage === "membership") {
          assert.equal(
            afterFailure.membershipEncodeCount,
            beforeFailure.membershipEncodeCount,
            "a failed membership pass must not commit its encode counter",
          );
          assert.equal(
            afterFailure.membershipEncodePassCount,
            beforeFailure.membershipEncodePassCount,
            "a failed membership pass must not commit completed-pass diagnostics",
          );
        }
        if (stage === "lookup") {
          assert.equal(
            afterFailure.lookupRenderCount,
            beforeFailure.lookupRenderCount,
            "a failed lookup draw must not commit its render counter",
          );
        }
        assert.deepEqual(
          readCanvasPixel(failure.gl, 64, 64),
          [255, 0, 0, 255],
          `${stage} failure must not suppress the healthy ordinary layer`,
        );

        processor.render(
          new Uint32Array([compositeId, healthy]),
          new Float32Array([0, 1, 0, 1, 1, 0, 0, 1]),
          0.08,
          0.08,
          0,
          0,
          1,
        );
        assert.equal(processor.get_composite_error(compositeId), undefined);
        assert.ok(
          readCanvasPixel(failure.gl, 64, 64)[1] > 0,
          `${stage} retry must restore the composite output`,
        );
      } finally {
        try {
          processor.clear();
        } finally {
          processor.free();
          rawGl.destroy();
        }
      }
    }
  },
);

test(
  "selection preview and readback GL failures reject without committing stale state",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const rawGl = createWebGLRenderingContext({
      width: 128,
      height: 128,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const failure = compositeStageFailureProxy(rawGl);
    const processor = new wasm.GerberProcessor();
    try {
      processor.init_with_size(failure.gl, 128, 128);
      const first = processor.add_layer(flashGerber(0));
      const second = processor.add_layer(flashGerber(0));
      const compositeId = processor.add_composite_preset_with_bounds(
        new Uint32Array([first, second]),
        "union",
        false,
        -5,
        5,
        -5,
        5,
      );

      processor.render_composite_selection(compositeId, 0.08, 0.08, 0, 0);
      processor.end_composite_selection();
      failure.armDrawFailure(1);
      assert.throws(
        () => processor.render_composite_selection(compositeId, 0.08, 0.08, 0, 0),
        /Composite selection preview rendering failed with WebGL error 0x505/,
      );
      assert.throws(
        () => processor.pick_composite_code(compositeId, 64, 64),
        /selection preview is not active/,
      );

      processor.render_composite_selection(compositeId, 0.08, 0.08, 0, 0);
      failure.armReadFailure();
      assert.throws(
        () => processor.pick_composite_code(compositeId, 64, 64),
        /Composite membership readback failed with WebGL error 0x505/,
      );
      assert.equal(processor.pick_composite_code(compositeId, 64, 64), 3);

      failure.armReadFailure(2);
      assert.throws(
        () => processor.pick_composite_code(compositeId, 84, 64),
        /Composite outline readback failed with WebGL error 0x505/,
      );
      assert.equal(processor.pick_composite_code(compositeId, 84, 64), 0);

      processor.end_composite_selection();
      failure.armReadFailure();
      assert.throws(
        () => processor.render_pixels_with_clear(
          new Uint32Array([compositeId]),
          new Float32Array([0, 1, 0, 1]),
          0.08,
          0.08,
          0,
          0,
          1,
          true,
        ),
        /Rendered output readback failed with WebGL error 0x505/,
      );
      assert.equal(
        processor.render_pixels_with_clear(
          new Uint32Array([compositeId]),
          new Float32Array([0, 1, 0, 1]),
          0.08,
          0.08,
          0,
          0,
          1,
          true,
        ).length,
        128 * 128 * 4,
      );
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        rawGl.destroy();
      }
    }
  },
);

test(
  "invalid composite mutations preserve the prior render diagnostic until recovery",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({
      processor,
      dummyId,
      forceNextR8Failure,
    }) => {
      const sourceId = processor.add_layer(flashGerber(0));
      const compositeId = processor.add_composite_layer_with_bounds(
        new Uint32Array([sourceId, dummyId]),
        new Uint8Array([0b00001110]),
        false,
        -5,
        5,
        -5,
        5,
      );
      forceNextR8Failure();
      processor.render(
        new Uint32Array([sourceId, compositeId]),
        new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]),
        0.05,
        0.05,
        0,
        0,
        1,
      );
      const previousError = processor.get_composite_error(compositeId);
      assert.match(previousError, /WebGL error 0x505/);

      assert.throws(
        () => processor.set_composite_visible_byte(compositeId, 99, 0),
        /lookup byte index is out of range/,
      );
      assert.equal(processor.get_composite_error(compositeId), previousError);
      assert.throws(
        () => processor.update_composite_sources(
          compositeId,
          new Uint32Array([sourceId, sourceId]),
          new Uint8Array([0b00001110]),
        ),
        /source layer IDs must be unique/,
      );
      assert.equal(processor.get_composite_error(compositeId), previousError);

      processor.render(
        new Uint32Array([compositeId]),
        new Float32Array([0, 1, 0, 1]),
        0.05,
        0.05,
        0,
        0,
        1,
      );
      assert.equal(processor.get_composite_error(compositeId), undefined);
    }, { r8FailureMode: "fatal" });
  },
);

test(
  "partial composite GPU allocation stages delete resources and retry",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    for (const [kind, occurrence, expectedError] of [
      ["framebuffer", 1, /Failed to create FBO/],
      ["texture", 2, /Failed to create composite lookup texture/],
      ["texture", 3, /Failed to create texture/],
    ]) {
      const rawGl = createWebGLRenderingContext({
        width: 128,
        height: 128,
        majorVersion: 3,
        minorVersion: 0,
        webGLCompatibility: true,
      });
      const failure = compositeStageFailureProxy(rawGl);
      const processor = new wasm.GerberProcessor();
      try {
        processor.init_with_size(failure.gl, 128, 128);
        const first = processor.add_layer(flashGerber(0));
        const second = processor.add_layer(flashGerber(0));
        const compositeId = processor.add_composite_preset_with_bounds(
          new Uint32Array([first, second]),
          "union",
          false,
          -5,
          5,
          -5,
          5,
        );
        failure.armCreateFailure(kind, occurrence);
        assert.throws(
          () => processor.render_composite_selection(compositeId, 0.08, 0.08, 0, 0),
          expectedError,
        );
        assert.equal(failure.wereTrackedResourcesDeleted(), true);
        const failed = processor.get_composite_diagnostics(compositeId);
        assert.equal(failed.outputMaskBytes, 0);
        assert.equal(failed.gpuLookupBytes, 0);
        assert.equal(failed.sharedMembershipBytes, 0);

        processor.render_composite_selection(compositeId, 0.08, 0.08, 0, 0);
        assert.equal(processor.pick_composite_code(compositeId, 64, 64), 3);
      } finally {
        try {
          processor.clear();
        } finally {
          processor.free();
          rawGl.destroy();
        }
      }
    }
  },
);

test(
  "composite texture-configuration errors roll back FBO and LUT allocation",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    for (const [occurrence, expectedError] of [
      [1, /Framebuffer configuration failed with WebGL error 0x505/],
      [5, /Composite lookup texture configuration failed with WebGL error 0x505/],
    ]) {
      await withCompositeProcessor(async ({
        processor,
        dummyId,
        forceTextureParameterFailure,
      }) => {
        const sourceId = processor.add_layer(flashGerber(0));
        const compositeId = processor.add_composite_preset_with_bounds(
          new Uint32Array([sourceId, dummyId]),
          "union",
          false,
          -5,
          5,
          -5,
          5,
        );

        forceTextureParameterFailure(occurrence);
        assert.throws(
          () => processor.render_composite_selection(compositeId, 0.08, 0.08, 0, 0),
          expectedError,
        );
        const failed = processor.get_composite_diagnostics(compositeId);
        assert.equal(failed.outputMaskBytes, 0);
        assert.equal(failed.gpuLookupBytes, 0);
        assert.equal(failed.sharedMembershipBytes, 0);

        processor.render_composite_selection(compositeId, 0.08, 0.08, 0, 0);
        assert.equal(processor.pick_composite_code(compositeId, 128, 128), 1);
      }, { monitorTextureParameter: true });
    }
  },
);

test(
  "failed internal outline construction preserves IDs and shared refcounts",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const rawGl = createWebGLRenderingContext({
      width: 128,
      height: 128,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const failure = compositeStageFailureProxy(rawGl);
    const processor = new wasm.GerberProcessor();
    try {
      processor.init_with_size(failure.gl, 128, 128);
      const first = processor.add_layer(flashGerber(0));
      const second = processor.add_layer(flashGerber(0));
      const sources = new Uint32Array([first, second]);
      failure.armCreateFailure("framebuffer");
      assert.throws(
        () => processor.add_composite_preset_with_bounds(
          sources,
          "union",
          false,
          -5,
          5,
          -5,
          5,
        ),
        /Failed to create FBO/,
      );
      assert.equal(failure.wereTrackedResourcesDeleted(), true);

      const firstComposite = processor.add_composite_preset_with_bounds(
        sources,
        "union",
        false,
        -5,
        5,
        -5,
        5,
      );
      assert.equal(firstComposite, 3, "failed outline creation must not consume layer IDs");
      const secondComposite = processor.add_composite_preset_with_bounds(
        sources,
        "union",
        false,
        -5,
        5,
        -5,
        5,
      );
      assert.equal(secondComposite, 4, "matching bounds must share the internal outline");
      processor.remove_layer(firstComposite);
      processor.render_composite_selection(secondComposite, 0.08, 0.08, 0, 0);
      assert.equal(processor.pick_composite_code(secondComposite, 64, 64), 3);
      processor.end_composite_selection();
      processor.remove_layer(secondComposite);
      assert.equal(
        processor.add_layer(flashGerber(4)),
        2,
        "the shared internal outline ID must be released with its final reference",
      );
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        rawGl.destroy();
      }
    }
  },
);

test(
  "deterministic composite lifecycle rolls back staged failures and retries equivalently",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const firstRawGl = createWebGLRenderingContext({
      width: 128,
      height: 128,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const firstFailure = compositeStageFailureProxy(firstRawGl);
    const processor = new wasm.GerberProcessor();
    let secondRawGl = null;
    try {
      processor.init_with_size(firstFailure.gl, 128, 128);
      const firstSource = processor.add_layer(flashGerber(0));
      const secondSource = processor.add_layer(flashGerber(0));
      const sourceIds = new Uint32Array([firstSource, secondSource]);
      const firstComposite = processor.add_composite_preset_with_bounds(
        sourceIds,
        "union",
        false,
        -5,
        5,
        -5,
        5,
      );
      const sharedComposite = processor.add_composite_preset_with_bounds(
        sourceIds,
        "union",
        false,
        -5,
        5,
        -5,
        5,
      );
      const selectAndAssert = (compositeId, width = 128, height = 128) => {
        processor.render_composite_selection(compositeId, 0.08, 0.08, 0, 0);
        assert.equal(
          processor.pick_composite_code(
            compositeId,
            Math.round(width / 2),
            Math.round(height / 2),
          ),
          3,
        );
      };

      selectAndAssert(firstComposite);
      processor.end_composite_selection();

      processor.release_composite_cache(firstComposite);
      firstFailure.armCreateFailure("framebuffer", 1);
      assert.throws(
        () => processor.render_composite_selection(firstComposite, 0.08, 0.08, 0, 0),
        /Failed to create FBO/,
      );
      assert.equal(firstFailure.wereTrackedResourcesDeleted(), true);
      assert.throws(
        () => processor.pick_composite_code(firstComposite, 64, 64),
        /selection preview is not active/,
      );
      selectAndAssert(firstComposite);
      processor.end_composite_selection();

      for (const [occurrence, message] of [
        [1, /Composite membership rendering failed/],
        [2, /Composite lookup rendering failed/],
        [3, /Composite selection preview rendering failed/],
      ]) {
        processor.release_composite_cache(firstComposite);
        firstFailure.armDrawFailure(occurrence);
        assert.throws(
          () => processor.render_composite_selection(firstComposite, 0.08, 0.08, 0, 0),
          message,
        );
        assert.throws(
          () => processor.pick_composite_code(firstComposite, 64, 64),
          /selection preview is not active/,
        );
        selectAndAssert(firstComposite);
        processor.end_composite_selection();
      }

      selectAndAssert(firstComposite);
      firstFailure.armReadFailure();
      assert.throws(
        () => processor.pick_composite_code(firstComposite, 64, 64),
        /Composite membership readback failed/,
      );
      assert.equal(processor.pick_composite_code(firstComposite, 64, 64), 3);
      const beforeToggle = processor.get_composite_diagnostics(firstComposite);
      processor.set_composite_visible_byte(firstComposite, 0, 0xf6);
      processor.render_composite_selection(firstComposite, 0.08, 0.08, 0, 0);
      assert.equal(processor.pick_composite_code(firstComposite, 64, 64), 3);
      assert.equal(
        processor.get_composite_diagnostics(firstComposite).membershipEncodePassCount,
        beforeToggle.membershipEncodePassCount,
        "a visibility-only toggle must reuse membership within the lifecycle",
      );
      processor.set_composite_visible_byte(firstComposite, 0, 0xfe);
      processor.end_composite_selection();

      firstFailure.armCreateFailure("framebuffer", 2);
      assert.throws(() => processor.resize_to(96, 80), /Failed to create FBO/);
      assert.equal(firstFailure.wereTrackedResourcesDeleted(), true);
      selectAndAssert(firstComposite);
      processor.end_composite_selection();
      processor.resize_to(96, 80);
      selectAndAssert(firstComposite, 96, 80);

      secondRawGl = createWebGLRenderingContext({
        width: 96,
        height: 80,
        majorVersion: 3,
        minorVersion: 0,
        webGLCompatibility: true,
      });
      assert.throws(
        () => processor.restore_context_with_size(secondRawGl, 96, 80),
        /Layer geometry has been released/,
      );
      assert.equal(
        processor.pick_composite_code(firstComposite, 48, 40),
        3,
        "an early recovery rejection must preserve the old context and selection",
      );
      processor.end_composite_selection();

      processor.remove_layer(firstComposite);
      selectAndAssert(sharedComposite, 96, 80);
      processor.end_composite_selection();
      processor.remove_layer(firstSource);
      assert.throws(
        () => processor.get_composite_diagnostics(sharedComposite),
        /Invalid composite layer ID/,
        "source removal must cascade the remaining dependent composite",
      );
      assert.equal(
        processor.add_layer(flashGerber(4)),
        firstSource,
        "cascade cleanup must release the source and shared-outline ID slots",
      );
      processor.clear();
      assert.equal(processor.add_layer(flashGerber(2)), 0);
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        firstRawGl.destroy();
        secondRawGl?.destroy();
      }
    }
  },
);

test(
  "bounded composite lifecycle stress balances every WebGL resource across recovery",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const createContext = () => createWebGLRenderingContext({
      width: 32,
      height: 32,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const oldRawGl = createContext();
    const replacementRawGl = createContext();
    const oldResources = resourceLifecycleProxy(oldRawGl);
    const replacementResources = resourceLifecycleProxy(replacementRawGl);
    const processor = new wasm.GerberProcessor();
    let freed = false;
    try {
      processor.init_with_size(oldResources.gl, 32, 32);
      const oldFirst = processor.add_layer(flashGerber(0));
      const oldSecond = processor.add_layer(flashGerber(0));
      const oldSources = new Uint32Array([oldFirst, oldSecond]);
      processor.add_composite_preset_with_bounds(
        oldSources, "union", false, -4, 4, -4, 4,
      );
      processor.add_composite_preset_with_bounds(
        oldSources, "union", false, -4, 4, -4, 4,
      );
      const oldBeforeFailure = oldResources.liveCounts();

      replacementResources.failNextCreate("framebuffer", 2);
      assert.throws(
        () => processor.restore_context_with_size(replacementResources.gl, 32, 32),
        /Failed to create FBO/,
      );
      assert.deepEqual(oldResources.liveCounts(), oldBeforeFailure);
      assert.equal(replacementResources.totalLive(), 0);
      replacementResources.assertNoDoubleDeletes();

      processor.restore_context_with_size(replacementResources.gl, 32, 32);
      assert.equal(oldResources.totalLive(), 0);
      oldResources.assertNoDoubleDeletes();
      processor.clear();
      const rendererCore = replacementResources.liveCounts();

      const firstSource = processor.add_layer(flashGerber(0));
      const secondSource = processor.add_layer(flashGerber(0));
      assert.deepEqual([firstSource, secondSource], [0, 1]);
      const sources = new Uint32Array([firstSource, secondSource]);
      let width = 32;
      let height = 32;

      const cycle = (iteration, injectAllocationFailure) => {
        const firstComposite = processor.add_composite_preset_with_bounds(
          sources, "union", false, -4, 4, -4, 4,
        );
        const sharedComposite = processor.add_composite_preset_with_bounds(
          sources, "union", false, -4, 4, -4, 4,
        );
        assert.deepEqual(
          [firstComposite, sharedComposite],
          [3, 4],
          `cycle ${iteration} must reuse internal/composite ID slots`,
        );
        const centerX = Math.round(width / 2);
        const centerY = Math.round(height / 2);
        const select = (compositeId) => {
          processor.render_composite_selection(compositeId, 0.15, 0.15, 0, 0);
          assert.equal(
            processor.pick_composite_code(compositeId, centerX, centerY),
            3,
          );
        };

        select(firstComposite);
        const beforeToggle = processor.get_composite_diagnostics(firstComposite);
        processor.set_composite_visible_byte(firstComposite, 0, 0xf6);
        processor.render_composite_selection(firstComposite, 0.15, 0.15, 0, 0);
        assert.equal(
          processor.get_composite_diagnostics(firstComposite)
            .membershipEncodePassCount,
          beforeToggle.membershipEncodePassCount,
        );
        processor.set_composite_visible_byte(firstComposite, 0, 0xfe);
        processor.end_composite_selection();
        processor.release_composite_cache(firstComposite);
        const hidden = processor.get_composite_diagnostics(firstComposite);
        assert.equal(hidden.cpuBitsetBytes, 1);
        assert.equal(hidden.gpuLookupBytes, 0);
        assert.equal(hidden.outputMaskBytes, 0);

        if (injectAllocationFailure) {
          const beforeFailure = replacementResources.liveCounts();
          replacementResources.failNextCreate("framebuffer");
          assert.throws(
            () => processor.render_composite_selection(
              firstComposite, 0.15, 0.15, 0, 0,
            ),
            /Failed to create FBO/,
          );
          assert.deepEqual(replacementResources.liveCounts(), beforeFailure);
          assert.throws(
            () => processor.pick_composite_code(firstComposite, centerX, centerY),
            /selection preview is not active/,
          );
        }

        select(firstComposite);
        processor.end_composite_selection();
        processor.remove_layer(firstComposite);
        select(sharedComposite);
        processor.end_composite_selection();
        processor.remove_layer(sharedComposite);
      };

      cycle(0, true);
      const warmLiveCounts = replacementResources.liveCounts();
      for (let iteration = 1; iteration < 128; iteration += 1) {
        if (iteration % 32 === 0) {
          height = height === 32 ? 24 : 32;
          processor.resize_to(width, height);
        }
        cycle(iteration, iteration % 31 === 0);
        assert.deepEqual(
          replacementResources.liveCounts(),
          warmLiveCounts,
          `cycle ${iteration} leaked or prematurely deleted a WebGL object`,
        );
        replacementResources.assertNoDoubleDeletes();
      }

      processor.clear();
      assert.deepEqual(replacementResources.liveCounts(), rendererCore);
      replacementResources.assertNoDoubleDeletes();
      processor.free();
      freed = true;
      assert.equal(replacementResources.totalLive(), 0);
      replacementResources.assertNoDoubleDeletes();
    } finally {
      if (!freed) {
        try {
          processor.clear();
        } finally {
          processor.free();
        }
      }
      oldRawGl.destroy();
      replacementRawGl.destroy();
    }
  },
);

test(
  "outline cache separates effective offset, content revision, and parse signature",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const gl = createWebGLRenderingContext({
      width: 128,
      height: 128,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const processor = new wasm.GerberProcessor();
    try {
      processor.init_with_size(gl, 128, 128);
      const first = processor.add_layer(flashGerber(20));
      const second = processor.add_layer(flashGerber(22));
      const outlineToken = processor.add_layer(filledRegionGerber());
      const sources = new Uint32Array([first, second]);
      const codeZero = new Uint8Array([1]);
      const addOutline = (content, offsetX, preserveArcs = true, quality = 1) =>
        processor.add_composite_layer_with_outline_content_options(
          sources,
          codeZero,
          false,
          outlineToken,
          content,
          offsetX,
          0,
          preserveArcs,
          quality,
        );

      const origin = addOutline(filledRegionGerber(), 0);
      const shifted = addOutline(filledRegionGerber(), 10);
      const shiftedShared = addOutline(filledRegionGerber(), 10);
      const changedContent = addOutline(outlineGerber(), 10);
      const changedParseSignature = addOutline(filledRegionGerber(), 10, false, 0);

      assert.throws(
        () => processor.add_composite_preset_with_bounds(
          new Uint32Array([first, origin]),
          "union",
          false,
          -5,
          5,
          -5,
          5,
        ),
        /Composite sources must be ordinary Gerber layers/,
        "the generic mask resolver must keep the current Gerber-only public policy",
      );

      assert.equal(origin, 4);
      assert.equal(shifted, 6, "a changed offset allocates a distinct internal mask");
      assert.equal(
        shiftedShared,
        7,
        "an identical effective definition shares its internal mask",
      );
      assert.equal(changedContent, 9, "changed content cannot alias the stable token");
      assert.equal(
        changedParseSignature,
        11,
        "changed parse settings are part of the effective revision",
      );

      const pixelX = (worldX) => Math.round((worldX * 0.05 + 1) * 64);
      processor.render_composite_selection(origin, 0.05, 0.05, 0, 0);
      assert.equal(processor.pick_composite_code(origin, pixelX(0), 64), 0);
      assert.equal(processor.pick_composite_code(origin, pixelX(10), 64), -1);
      processor.end_composite_selection();
      processor.render_composite_selection(shifted, 0.05, 0.05, 0, 0);
      assert.equal(processor.pick_composite_code(shifted, pixelX(0), 64), -1);
      assert.equal(processor.pick_composite_code(shifted, pixelX(10), 64), 0);
      processor.end_composite_selection();

      processor.remove_layer(shifted);
      processor.remove_layer(shiftedShared);
      assert.equal(
        processor.add_layer(flashGerber(30)),
        5,
        "the shared variant is released only after its final reference",
      );
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        gl.destroy();
      }
    }
  },
);

test(
  "composite cache diagnostics prove lookup-only updates and hidden lazy rebuild",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({ processor, dummyId }) => {
      const sourceId = processor.add_layer(flashGerber(0));
      const compositeId = processor.add_composite_layer_with_bounds(
        new Uint32Array([sourceId, dummyId]),
        new Uint8Array([0b00001110]),
        false,
        -5,
        5,
        -5,
        5,
      );
      const initial = processor.get_composite_diagnostics(compositeId);
      assert.equal(initial.cpuBitsetBytes, 1);
      assert.equal(initial.gpuLookupBytes, 0);
      assert.equal(initial.outputMaskBytes, 0);
      assert.equal(initial.outputFormat, "unallocated");

      processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0);
      const selected = processor.get_composite_diagnostics(compositeId);
      assert.equal(selected.membershipEncodeCount, 1);
      assert.equal(selected.membershipEncodePassCount, 1);
      assert.equal(selected.lookupRenderCount, 1);
      assert.ok(selected.gpuLookupBytes > 0);
      assert.ok(selected.outputMaskBytes > 0);

      processor.set_composite_visible_byte(compositeId, 0, 0b00000110);
      processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0);
      const toggled = processor.get_composite_diagnostics(compositeId);
      assert.equal(toggled.membershipEncodeCount, selected.membershipEncodeCount);
      assert.equal(
        toggled.membershipEncodePassCount,
        selected.membershipEncodePassCount,
      );
      assert.equal(toggled.lookupRenderCount, selected.lookupRenderCount + 1);

      processor.end_composite_selection();
      processor.render(
        new Uint32Array([compositeId]),
        new Float32Array([1, 0, 0, 1]),
        0.05,
        0.05,
        0,
        0,
        1,
      );
      const firstColor = processor.get_composite_diagnostics(compositeId);
      processor.render(
        new Uint32Array([compositeId]),
        new Float32Array([0, 1, 0, 0.25]),
        0.05,
        0.05,
        0,
        0,
        1,
      );
      const recolored = processor.get_composite_diagnostics(compositeId);
      assert.equal(recolored.membershipEncodeCount, firstColor.membershipEncodeCount);
      assert.equal(
        recolored.membershipEncodePassCount,
        firstColor.membershipEncodePassCount,
      );
      assert.equal(recolored.lookupRenderCount, firstColor.lookupRenderCount);
      assert.equal(
        recolored.renderScratchGrowthCount,
        firstColor.renderScratchGrowthCount,
        "a warm cached render must reuse active-composite CPU scratch",
      );

      processor.release_composite_cache(compositeId);
      const released = processor.get_composite_diagnostics(compositeId);
      assert.equal(released.cpuBitsetBytes, 1);
      assert.equal(released.gpuLookupBytes, 0);
      assert.equal(released.outputMaskBytes, 0);
      assert.equal(released.outputFormat, "unallocated");

      processor.render(
        new Uint32Array([compositeId]),
        new Float32Array([0, 1, 0, 1]),
        0.05,
        0.05,
        0,
        0,
        1,
      );
      const rebuilt = processor.get_composite_diagnostics(compositeId);
      assert.equal(rebuilt.membershipEncodeCount, released.membershipEncodeCount + 1);
      assert.equal(rebuilt.lookupRenderCount, released.lookupRenderCount + 1);

      processor.set_minimum_feature_pixels(2);
      processor.render(
        new Uint32Array([compositeId]),
        new Float32Array([0, 1, 0, 1]),
        0.05,
        0.05,
        0,
        0,
        1,
      );
      const minimumWidth = processor.get_composite_diagnostics(compositeId);
      assert.equal(
        minimumWidth.membershipEncodeCount,
        rebuilt.membershipEncodeCount + 1,
      );

      processor.render(
        new Uint32Array([compositeId]),
        new Float32Array([0, 1, 0, 1]),
        0.06,
        0.05,
        0,
        0,
        1,
      );
      const cameraChanged = processor.get_composite_diagnostics(compositeId);
      assert.equal(
        cameraChanged.membershipEncodeCount,
        minimumWidth.membershipEncodeCount + 1,
      );
    });
  },
);

test(
  "cached composite order changes reuse CPU scratch and both GPU masks",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({ processor, dummyId }) => {
      const sourceId = processor.add_layer(flashGerber(0));
      const sources = new Uint32Array([sourceId, dummyId]);
      const bits = new Uint8Array([0b00001110]);
      const first = processor.add_composite_layer_with_bounds(
        sources,
        bits,
        false,
        -5,
        5,
        -5,
        5,
      );
      const second = processor.add_composite_layer_with_bounds(
        sources,
        bits,
        false,
        -5,
        5,
        -5,
        5,
      );
      processor.render(
        new Uint32Array([first, second]),
        new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]),
        0.05,
        0.05,
        0,
        0,
        1,
      );
      const beforeFirst = processor.get_composite_diagnostics(first);
      const beforeSecond = processor.get_composite_diagnostics(second);

      processor.render(
        new Uint32Array([second, first]),
        new Float32Array([0, 0, 1, 0.25, 1, 1, 0, 0.5]),
        0.05,
        0.05,
        0,
        0,
        1,
      );
      const afterFirst = processor.get_composite_diagnostics(first);
      const afterSecond = processor.get_composite_diagnostics(second);

      assert.equal(
        afterFirst.renderScratchGrowthCount,
        beforeFirst.renderScratchGrowthCount,
      );
      for (const [before, after] of [
        [beforeFirst, afterFirst],
        [beforeSecond, afterSecond],
      ]) {
        assert.equal(after.membershipEncodeCount, before.membershipEncodeCount);
        assert.equal(
          after.membershipEncodePassCount,
          before.membershipEncodePassCount,
        );
        assert.equal(after.lookupRenderCount, before.lookupRenderCount);
      }
    });
  },
);

test(
  "lookup rendering implements presets, byte toggles, code zero clipping, and inversion",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const gl = createWebGLRenderingContext({
      width: 128,
      height: 128,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const processor = new wasm.GerberProcessor();
    try {
      processor.init_with_size(gl, 128, 128);
      // Code 3 occurs in two disconnected regions (-4 and 0). A single LUT
      // bit update must change both without any geometry-local bookkeeping.
      const first = processor.add_layer(twoFlashGerber([-4, -2, 0]));
      const second = processor.add_layer(twoFlashGerber([-4, 0, 2]));
      const sources = new Uint32Array([first, second]);
      const composites = {
        union: processor.add_composite_preset_with_bounds(
          sources, "union", false, -5, 5, -5, 5,
        ),
        intersection: processor.add_composite_preset_with_bounds(
          sources, "intersection", false, -5, 5, -5, 5,
        ),
        difference: processor.add_composite_preset_with_bounds(
          sources, "difference", false, -5, 5, -5, 5,
        ),
        codeZero: processor.add_composite_layer_with_bounds(
          sources, new Uint8Array([0b00000001]), false, -5, 5, -5, 5,
        ),
        invertedUnion: processor.add_composite_preset_with_bounds(
          sources, "union", true, -5, 5, -5, 5,
        ),
      };
      const color = new Float32Array([1, 1, 1, 1]);
      const renderAlphaAt = (compositeId, worldX) => {
        const pixels = processor.render_pixels_with_clear(
          new Uint32Array([compositeId]),
          color,
          0.15,
          0.15,
          0,
          0,
          1,
          true,
        );
        const pixelX = Math.round((worldX * 0.15 + 1) * 64);
        return pixels[(64 * 128 + pixelX) * 4 + 3];
      };

      assert.ok(renderAlphaAt(composites.union, -2) > 200);
      assert.ok(renderAlphaAt(composites.union, 0) > 200);
      assert.ok(renderAlphaAt(composites.union, 2) > 200);
      assert.equal(renderAlphaAt(composites.union, 4), 0);

      assert.equal(renderAlphaAt(composites.intersection, -2), 0);
      assert.ok(renderAlphaAt(composites.intersection, -4) > 200);
      assert.ok(renderAlphaAt(composites.intersection, 0) > 200);
      assert.equal(renderAlphaAt(composites.intersection, 2), 0);

      assert.ok(renderAlphaAt(composites.difference, -2) > 200);
      assert.equal(renderAlphaAt(composites.difference, 0), 0);
      assert.equal(renderAlphaAt(composites.difference, 2), 0);
      processor.set_composite_visible_byte(composites.difference, 0, 0b00001000);
      assert.equal(renderAlphaAt(composites.difference, -2), 0);
      assert.ok(renderAlphaAt(composites.difference, -4) > 200);
      assert.ok(renderAlphaAt(composites.difference, 0) > 200);

      assert.ok(renderAlphaAt(composites.codeZero, 4) > 200);
      assert.equal(renderAlphaAt(composites.codeZero, 6), 0);
      assert.equal(renderAlphaAt(composites.invertedUnion, -2), 0);
      assert.ok(renderAlphaAt(composites.invertedUnion, 4) > 200);
      assert.equal(renderAlphaAt(composites.invertedUnion, 6), 0);
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        gl.destroy();
      }
    }
  },
);

test(
  "multiple composites independently observe a shared source FBO generation",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
    const { createWebGLRenderingContext } = require("node-gles-webgl2");
    const gl = createWebGLRenderingContext({
      width: 128,
      height: 128,
      majorVersion: 3,
      minorVersion: 0,
      webGLCompatibility: true,
    });
    const processor = new wasm.GerberProcessor();
    try {
      processor.init_with_size(gl, 128, 128);
      const firstSource = processor.add_layer(flashGerber(0));
      const secondSource = processor.add_layer(flashGerber(8));
      const sourceIds = new Uint32Array([firstSource, secondSource]);
      const unionBits = new Uint8Array([0b00001110]);
      const firstComposite = processor.add_composite_layer_with_bounds(
        sourceIds,
        unionBits,
        false,
        -2,
        10,
        -2,
        2,
      );
      const secondComposite = processor.add_composite_layer_with_bounds(
        sourceIds,
        unionBits,
        false,
        -2,
        10,
        -2,
        2,
      );
      const active = new Uint32Array([firstComposite, secondComposite]);
      const colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]);
      const initial = processor.render_pixels_with_clear(
        active,
        colors,
        0.1,
        0.1,
        0,
        0,
        1,
        true,
      );
      const center = (64 * 128 + 64) * 4;
      assert.ok(initial[center] > 200 && initial[center + 1] > 200);

      processor.set_layer_inner_outline(firstSource, 4, 0);
      const updated = processor.render_pixels_with_clear(
        active,
        colors,
        0.1,
        0.1,
        0,
        0,
        1,
        true,
      );
      assert.equal(updated[center + 3], 0);
    } finally {
      try {
        processor.clear();
      } finally {
        processor.free();
        gl.destroy();
      }
    }
  },
);

test(
  "code-zero selection clips nested aperture-outline contours as holes",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({ processor, dummyId, pick }) => {
      const outlineId = processor.add_layer(nestedOutlineGerber());
      const compositeId = processor.add_composite_layer_with_outline(
        new Uint32Array([outlineId, dummyId]),
        new Uint8Array([0b00000001]),
        false,
        outlineId,
      );
      processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0);

      assert.equal(pick(compositeId, 4, 0), 0);
      assert.equal(pick(compositeId, 0, 0), -1);
      assert.equal(pick(compositeId, 6, 0), -1);
    });
  },
);

test(
  "composite membership reuses line, flash, arc, region, and exact region-arc masks",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({ processor, dummyId, pick }) => {
      const primitives = `%FSLAX24Y24*%
%MOMM*%
%ADD10C,1.000*%
D10*
X-050000Y000000D03*
X-020000Y-020000D02*
X020000Y-020000D01*
G75*
X020000Y020000D02*
G03*
X-020000Y020000I-020000J000000D01*
G36*
X-020000Y040000D02*
G01*
X020000Y040000D01*
X020000Y060000D01*
X-020000Y060000D01*
X-020000Y040000D01*
G37*
M02*`;
      const primitiveId = processor.add_layer(primitives);
      const primitiveComposite = createSelectionComposite(
        processor,
        primitiveId,
        dummyId,
      );
      for (const point of [[-5, 0], [0, -2], [0, 4], [0, 5]]) {
        assert.equal(pick(primitiveComposite, ...point), 1, `primitive at ${point}`);
      }

      const arcRegion = `%FSLAX24Y24*%
%MOMM*%
%ABD10*%
G75*
G36*
X010000Y000000D02*
G03*
X-010000Y000000I-010000J000000D01*
G37*
%AB*%
D10*
X000000Y000000D03*
M02*`;
      const arcRegionId = processor.add_layer(arcRegion);
      const arcRegionComposite = createSelectionComposite(
        processor,
        arcRegionId,
        dummyId,
      );
      assert.equal(pick(arcRegionComposite, 0, 0.5), 1);
      assert.equal(pick(arcRegionComposite, 0, -0.5), 0);
    });
  },
);

test(
  "composite membership preserves polarity and region hole contours",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({ processor, dummyId, pick }) => {
      const polarity = `%FSLAX24Y24*%
%MOMM*%
%ABD20*%
%LPD*%
%ADD10C,4.0*%
D10*
X000000Y000000D03*
%LPC*%
%ADD11C,2.0*%
D11*
X000000Y000000D03*
%AB*%
%LPD*%
D20*
X100000Y000000D03*
M02*`;
      const polarityId = processor.add_layer(polarity);
      const polarityComposite = createSelectionComposite(
        processor,
        polarityId,
        dummyId,
      );
      assert.equal(pick(polarityComposite, 10, 0), 0);
      assert.equal(pick(polarityComposite, 11.5, 0), 1);

      const regionHole = `%FSLAX24Y24*%
%MOMM*%
%LPD*%
G36*
X-050000Y-050000D02*
G01*
X050000Y-050000D01*
X050000Y050000D01*
X-050000Y050000D01*
X-050000Y-050000D01*
X-020000Y-020000D02*
X-020000Y020000D01*
X020000Y020000D01*
X020000Y-020000D01*
X-020000Y-020000D01*
G37*
M02*`;
      const regionHoleId = processor.add_layer(regionHole);
      const regionHoleComposite = createSelectionComposite(
        processor,
        regionHoleId,
        dummyId,
      );
      assert.equal(pick(regionHoleComposite, 0, 0), 0);
      assert.equal(pick(regionHoleComposite, 4, 0), 1);
    });
  },
);

test(
  "composite membership preserves step-repeat, rotation, mirror, offset, and minimum width",
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  async () => {
    await withCompositeProcessor(async ({ processor, dummyId, pick }) => {
      const repeat = `%FSLAX24Y24*%
%MOMM*%
%ADD10C,0.5*%
%SRX2Y1I2.0J0.0*%
D10*
X000000Y000000D03*
%SR*%
M02*`;
      const repeatComposite = createSelectionComposite(
        processor,
        processor.add_layer(repeat),
        dummyId,
      );
      assert.equal(pick(repeatComposite, 0, 0), 1);
      assert.equal(pick(repeatComposite, 2, 0), 1);

      const rotatedBlock = `%FSLAX24Y24*%
%MOMM*%
%ABD20*%
%ADD10C,1.0*%
D10*
X010000Y000000D03*
%AB*%
%LR90*%
D20*
X100000Y000000D03*
M02*`;
      const rotatedComposite = createSelectionComposite(
        processor,
        processor.add_layer(rotatedBlock),
        dummyId,
      );
      assert.equal(pick(rotatedComposite, 10, 1), 1);
      assert.equal(pick(rotatedComposite, 11, 0), 0);

      const mirrored = `%FSLAX26Y26*%
%MOMM*%
%AMOFF*1,1,0.5,0.25,0*%
%ADD10OFF*%
%LMX*%
D10*
X1000000Y0000000D03*
M02*`;
      const mirroredComposite = createSelectionComposite(
        processor,
        processor.add_layer(mirrored),
        dummyId,
      );
      assert.equal(pick(mirroredComposite, 0.75, 0), 1);
      assert.equal(pick(mirroredComposite, 1.25, 0), 0);

      const offsetId = processor.add_layer_with_offset(flashGerber(0), 3, 4);
      const offsetComposite = createSelectionComposite(processor, offsetId, dummyId);
      assert.equal(pick(offsetComposite, 3, 4), 1);
      assert.equal(pick(offsetComposite, 0, 0), 0);

      processor.set_minimum_feature_pixels(3);
      const zeroWidth = `%FSLAX24Y24*%
%MOMM*%
%ADD10C,0.000*%
D10*
X-030000Y000000D02*
X030000Y000000D01*
M02*`;
      const secondZeroWidth = `%FSLAX24Y24*%
%MOMM*%
%ADD10C,0.000*%
D10*
X-030000Y000000D02*
X030000Y000000D01*
M02*`;
      const zeroWidthId = processor.add_layer(zeroWidth);
      const secondZeroWidthId = processor.add_layer(secondZeroWidth);
      const zeroWidthComposite = processor.add_composite_layer_with_bounds(
        new Uint32Array([zeroWidthId, secondZeroWidthId]),
        new Uint8Array([0b00001110]),
        false,
        -3,
        3,
        0,
        0,
      );
      processor.render_composite_selection(zeroWidthComposite, 0.05, 0.05, 0, 0);
      assert.equal(pick(zeroWidthComposite, 0, 0), 3);
    });
  },
);

async function renderComposite(strategy) {
  const renderer = await createNodeGerberRenderer();
  try {
    await renderer.withFrame(
      { width: 128, height: 64, strategy, background: null },
      async () => {
        const first = await renderer.renderLayer(
          { source: flashGerber(0), name: "first.gbr" },
          { visible: false },
        );
        const second = await renderer.renderLayer(
          { source: flashGerber(8), name: "second.gbr" },
          { visible: false },
        );
        await renderer.renderCompositeLayer([first, second], {
          preset: "union",
          color: "#00ff00",
          alpha: 1,
        });
      },
    );
    return decodeRgbaPng(await renderer.exportPng());
  } finally {
    renderer.dispose();
  }
}

async function renderMetamorphicComposite(definition, strategy, displaySources) {
  const renderer = await createNodeGerberRenderer();
  try {
    await renderer.withFrame(
      {
        width: 96,
        height: 64,
        strategy,
        background: null,
        padding: 4,
        compositeMode: definition.compositeMode,
      },
      async () => {
        const explicitPattern = definition.visibleAreas?.[0] ?? null;
        const sourceIds = [];
        for (let slot = 0; slot < definition.sourceCount; slot += 1) {
          const flashes = [-4, 4 + slot * 3];
          if (explicitPattern?.[slot] === "1") flashes.push(0);
          sourceIds.push(
            await renderer.renderLayer(
              {
                source: multiFlashGerber(flashes, 1.2),
                name: `metamorphic-${slot}.gbr`,
              },
              displaySources
                ? {
                    visible: true,
                    alpha: 0,
                    color: [
                      ((slot * 17 + 3) % 31) / 30,
                      ((slot * 11 + 5) % 29) / 28,
                      ((slot * 7 + 1) % 23) / 22,
                    ],
                  }
                : {
                    visible: false,
                    alpha: ((slot % 5) + 1) / 5,
                    color: [1, 0, 0],
                  },
            ),
          );
        }
        await renderer.renderCompositeLayer(sourceIds, {
          ...(definition.preset == null ? {} : { preset: definition.preset }),
          ...(definition.visibleAreas == null
            ? {}
            : { visibleAreas: definition.visibleAreas }),
          color: "#00ff00",
          alpha: 1,
        });
      },
    );
    return decodeRgbaPng(await renderer.exportPng());
  } finally {
    renderer.dispose();
  }
}

async function renderFixedSeedTileCase(strategy, camera) {
  const renderer = await createNodeGerberRenderer();
  try {
    await renderer.withFrame(
      {
        width: 97,
        height: 73,
        strategy,
        maxBandBytes: 4096,
        background: null,
        fit: false,
        ...camera,
      },
      async () => {
        const sourceDefinitions = [
          [[-6, -3], [-4, 2], [0, -1], [3, 4]],
          [[-6, -3], [-2, 3], [0, -1], [5, -4]],
          [[-4, 2], [-2, 3], [0, -1], [6, 1]],
        ];
        const sourceIds = [];
        for (let index = 0; index < sourceDefinitions.length; index += 1) {
          sourceIds.push(
            await renderer.renderLayer(
              {
                source: multiPointFlashGerber(sourceDefinitions[index], 0.8),
                name: `seeded-${index}.gbr`,
              },
              { visible: false },
            ),
          );
        }
        await renderer.renderCompositeLayer(sourceIds, {
          visibleAreas: ["100", "010", "001", "111"],
          color: "#31c7ff",
          alpha: 0.75,
        });
      },
    );
    return decodeRgbaPng(await renderer.exportPng());
  } finally {
    renderer.dispose();
  }
}

async function renderBandBudgetCase(strategy, background, maxBandBytes) {
  const renderer = await createNodeGerberRenderer();
  try {
    await renderer.withFrame(
      {
        width: 37,
        height: 9,
        strategy,
        background,
        maxBandBytes,
        fit: false,
        view: { zoomX: 0.2, zoomY: 0.2, offsetX: 0, offsetY: 0 },
      },
      async () => {
        await renderer.renderLayer(flashGerber(0), {
          color: "#00ff00",
          alpha: 1,
        });
      },
    );
    return decodeRgbaPng(await renderer.exportPng());
  } finally {
    renderer.dispose();
  }
}

async function exportBandBudgetFailure(strategy, background, maxBandBytes) {
  const renderer = await createNodeGerberRenderer();
  let writes = 0;
  try {
    await renderer.withFrame(
      {
        width: 37,
        height: 9,
        strategy,
        background,
        maxBandBytes,
        fit: false,
        view: { zoomX: 0.2, zoomY: 0.2, offsetX: 0, offsetY: 0 },
      },
      async () => {
        await renderer.renderLayer(flashGerber(0), {
          color: "#00ff00",
          alpha: 1,
        });
      },
    );
    await renderer.exportPngStream({
      async write() {
        writes += 1;
      },
    });
    throw new Error("Expected the row budget export to fail");
  } catch (error) {
    return {
      message: error.message,
      writes,
      activeExport: renderer.activeExport,
    };
  } finally {
    renderer.dispose();
  }
}

async function renderInvertedSourceComposite(strategy) {
  const renderer = await createNodeGerberRenderer();
  try {
    await renderer.withFrame(
      {
        width: 128,
        height: 128,
        strategy,
        background: null,
        invertedOutline: "board-outline.gbr",
      },
      async () => {
        const target = await renderer.renderLayer(
          { source: flashGerber(0), name: "target.gbr" },
          { visible: false, inverted: true },
        );
        const outline = await renderer.renderLayer(
          { source: outlineGerber(), name: "board-outline.gbr" },
          { visible: false },
        );
        await renderer.renderCompositeLayer([target, outline], {
          visibleAreas: ["10"],
          outlineLayerId: outline,
          color: "#00ff00",
          alpha: 1,
        });
      },
    );
    return decodeRgbaPng(await renderer.exportPng());
  } finally {
    renderer.dispose();
  }
}

async function renderRegionOutlineComposite(strategy) {
  const renderer = await createNodeGerberRenderer();
  try {
    await renderer.withFrame(
      {
        width: 128,
        height: 128,
        strategy,
        background: null,
        fit: false,
        view: { zoomX: 0.08, zoomY: 0.08, offsetX: 0, offsetY: 0 },
      },
      async () => {
        const first = await renderer.renderLayer(
          { source: flashGerber(20), name: "first.gbr" },
          { visible: false },
        );
        const second = await renderer.renderLayer(
          { source: flashGerber(22), name: "second.gbr" },
          { visible: false },
        );
        const outline = await renderer.renderLayer(
          { source: regionOutlineWithHoleGerber(), name: "region-routing.gbr" },
          { visible: false },
        );
        await renderer.renderCompositeLayer([first, second], {
          visibleAreas: ["00"],
          outlineLayerId: outline,
          color: "#00ff00",
          alpha: 1,
        });
      },
    );
    return decodeRgbaPng(await renderer.exportPng());
  } finally {
    renderer.dispose();
  }
}

async function renderPreparedInvertedArcRegionVariants() {
  const renderer = await createNodeGerberRenderer();
  try {
    const prepared = await renderer.loadLayer(filledRegionGerber(), {
      name: "prepared-inverted-arc-region.gbr",
      inverted: true,
      preserveArcRegions: false,
      arcTessellationQuality: 0,
    });
    const render = async (strategy, preserveArcRegions, arcTessellationQuality) => {
      await renderer.withFrame(
        {
          width: 256,
          height: 256,
          strategy,
          background: null,
          fit: false,
          view: { zoomX: 0.5, zoomY: 0.5, offsetX: 0, offsetY: 0 },
          invertedOutline: "bounds",
          preserveArcRegions,
          arcTessellationQuality,
        },
        async () => {
          await renderer.renderLayer(prepared, { color: "#00ff00", alpha: 1 });
        },
      );
      return decodeRgbaPng(await renderer.exportPng());
    };

    return [
      await render("full-frame", false, 0),
      await render("full-frame", true, 2),
      await render("stream", true, 2),
    ];
  } finally {
    renderer.dispose();
  }
}

async function renderPreparedArcOutlineVariants() {
  const renderer = await createNodeGerberRenderer();
  try {
    const first = await renderer.loadLayer(flashGerber(20), {
      name: "prepared-first.gbr",
    });
    const second = await renderer.loadLayer(flashGerber(22), {
      name: "prepared-second.gbr",
    });
    const outline = await renderer.loadLayer(filledRegionGerber(), {
      name: "prepared-arc-outline.gbr",
      preserveArcRegions: false,
      arcTessellationQuality: 0,
    });
    const render = async (strategy, preserveArcRegions, arcTessellationQuality) => {
      await renderer.withFrame(
        {
          width: 256,
          height: 256,
          strategy,
          background: null,
          fit: false,
          view: { zoomX: 0.5, zoomY: 0.5, offsetX: 0, offsetY: 0 },
          preserveArcRegions,
          arcTessellationQuality,
        },
        async () => {
          const firstId = await renderer.renderLayer(first, { visible: false });
          const secondId = await renderer.renderLayer(second, { visible: false });
          const outlineId = await renderer.renderLayer(outline, { visible: false });
          await renderer.renderCompositeLayer([firstId, secondId], {
            visibleAreas: ["00"],
            outlineLayerId: outlineId,
            color: "#00ff00",
            alpha: 1,
          });
        },
      );
      return decodeRgbaPng(await renderer.exportPng());
    };

    return [
      await render("full-frame", false, 0),
      await render("full-frame", true, 2),
      await render("stream", true, 2),
    ];
  } finally {
    renderer.dispose();
  }
}

async function renderBrowserLateFallbackComposite() {
  const wasm = await import(wasmModuleUrl.href);
  wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
  const { createWebGLRenderingContext } = require("node-gles-webgl2");
  const gl = createWebGLRenderingContext({
    width: 128,
    height: 128,
    majorVersion: 3,
    minorVersion: 0,
    webGLCompatibility: true,
  });
  const canvas = { width: 128, height: 128, getContext: () => gl };
  const renderer = new GerberRenderer(canvas, { releaseContext: false }, wasm);
  try {
    await addLateFallbackFrame(renderer);
    const pixels = new Uint8Array(128 * 128 * 4);
    gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  } finally {
    renderer.dispose();
    gl.destroy();
  }
}

async function renderCompositeMode(compositeMode, strategy = "full-frame") {
  const renderer = await createNodeGerberRenderer();
  try {
    await renderer.withFrame(
      {
        width: 128,
        height: 128,
        strategy,
        background: null,
        fit: false,
        globalAlpha: 1,
        compositeMode,
        view: { zoomX: 0.08, zoomY: 0.08, offsetX: 0, offsetY: 0 },
      },
      async () => {
        const first = await renderer.renderLayer(
          { source: flashGerber(0), name: "visible-source.gbr" },
          { color: "#ff0000", alpha: 1 },
        );
        const second = await renderer.renderLayer(
          { source: flashGerber(10), name: "hidden-source.gbr" },
          { visible: false },
        );
        await renderer.renderCompositeLayer([first, second], {
          preset: "union",
          color: "#0000ff",
          alpha: 1,
        });
      },
    );
    return decodeRgbaPng(await renderer.exportPng());
  } finally {
    renderer.dispose();
  }
}

async function renderBrowserLayerAfterComposite() {
  const wasm = await import(wasmModuleUrl.href);
  wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
  const { createWebGLRenderingContext } = require("node-gles-webgl2");
  const gl = createWebGLRenderingContext({
    width: 128,
    height: 128,
    majorVersion: 3,
    minorVersion: 0,
    webGLCompatibility: true,
  });
  const renderer = new GerberRenderer(
    { width: 128, height: 128, getContext: () => gl },
    { releaseContext: false },
    wasm,
  );
  try {
    await addLayerAfterCompositeFrame(renderer);
    const pixels = new Uint8Array(128 * 128 * 4);
    gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  } finally {
    renderer.dispose();
    gl.destroy();
  }
}

async function renderNodeLayerAfterComposite(strategy) {
  const renderer = await createNodeGerberRenderer();
  try {
    await addLayerAfterCompositeFrame(renderer, strategy);
    return decodeRgbaPng(await renderer.exportPng());
  } finally {
    renderer.dispose();
  }
}

async function addLayerAfterCompositeFrame(renderer, strategy = "full-frame") {
  await renderer.withFrame(
    {
      width: 128,
      height: 128,
      strategy,
      background: null,
      fit: false,
      globalAlpha: 1,
      compositeMode: "stack",
      view: { zoomX: 0.08, zoomY: 0.08, offsetX: 0, offsetY: 0 },
    },
    async () => {
      const first = await renderer.renderLayer(flashGerber(0), { visible: false });
      const second = await renderer.renderLayer(flashGerber(4), { visible: false });
      await renderer.renderCompositeLayer([first, second], {
        color: "#0000ff",
        alpha: 1,
      });
      await renderer.renderLayer(flashGerber(0), {
        color: [0, 1, 0],
        alpha: 1,
      });
    },
  );
}

async function createForcedCompositeFailureModule() {
  const wasm = await import(wasmModuleUrl.href);
  wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
  class ForcedCompositeFailureProcessor {
    constructor() {
      const processor = new wasm.GerberProcessor();
      return new Proxy(processor, {
        get(target, property) {
          if (property === "get_composite_error") {
            return () => "forced composite allocation failure";
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
  }
  return {
    ...wasm,
    default: undefined,
    GerberProcessor: ForcedCompositeFailureProcessor,
  };
}

async function createForcedCompositeConstructionFailureModule() {
  const wasm = await import(wasmModuleUrl.href);
  wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
  class ForcedCompositeConstructionFailureProcessor {
    constructor() {
      const processor = new wasm.GerberProcessor();
      let constructionCount = 0;
      return new Proxy(processor, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "add_composite_layer_with_bounds") {
            return (...args) => {
              constructionCount += 1;
              if (constructionCount === 1) {
                throw new Error("forced composite construction failure");
              }
              return value.apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
  }
  return {
    ...wasm,
    default: undefined,
    GerberProcessor: ForcedCompositeConstructionFailureProcessor,
  };
}

async function createOneCompositeFailureModule() {
  const wasm = await import(wasmModuleUrl.href);
  wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
  class OneCompositeFailureProcessor {
    constructor() {
      const processor = new wasm.GerberProcessor();
      let failureAvailable = true;
      return new Proxy(processor, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "get_composite_error") {
            return () => {
              if (!failureAvailable) return "";
              failureAvailable = false;
              return "forced one-composite allocation failure";
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
  }
  return {
    ...wasm,
    default: undefined,
    GerberProcessor: OneCompositeFailureProcessor,
  };
}

async function createForcedCompositeRetryModule(retryMode) {
  const wasm = await import(wasmModuleUrl.href);
  wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
  class ForcedCompositeRetryProcessor {
    constructor() {
      const processor = new wasm.GerberProcessor();
      let renderCalls = 0;
      let compositeFailureAvailable = true;
      let hasComposite = false;
      return new Proxy(processor, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof property === "string" && property.startsWith("add_composite_layer")) {
            return (...args) => {
              hasComposite = true;
              return value.apply(target, args);
            };
          }
          if (property === "get_composite_error") {
            return () => {
              if (!hasComposite || !compositeFailureAvailable) return "";
              compositeFailureAvailable = false;
              return "forced composite retry failure";
            };
          }
          const isRetryRender =
            (retryMode === "full-frame" &&
              property === "render_pixels_with_clear") ||
            (retryMode === "stream" && property === "render_tile");
          if (isRetryRender) {
            return (...args) => {
              renderCalls += 1;
              if (hasComposite && renderCalls === 2) {
                throw new Error(`forced ${retryMode} context retry`);
              }
              return value.apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
  }
  return {
    ...wasm,
    default: undefined,
    GerberProcessor: ForcedCompositeRetryProcessor,
  };
}

async function createExcludedDependencyRetryModule() {
  const wasm = await import(wasmModuleUrl.href);
  wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
  let invertedRebuildCount = 0;
  let failureReported = false;
  let retryThrown = false;
  class ExcludedDependencyRetryProcessor {
    constructor() {
      const processor = new wasm.GerberProcessor();
      let compositeCount = 0;
      let fullFrameRenderCount = 0;
      return new Proxy(processor, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof property === "string" && property.startsWith("add_composite_layer")) {
            return (...args) => {
              compositeCount += 1;
              return value.apply(target, args);
            };
          }
          if (
            property === "add_inverted_layer_with_bounds" ||
            property === "add_inverted_layer_with_bounds_options"
          ) {
            return (...args) => {
              invertedRebuildCount += 1;
              if (invertedRebuildCount > 1) {
                throw new Error("excluded inverted dependency was reconstructed");
              }
              return value.apply(target, args);
            };
          }
          if (property === "get_composite_error") {
            return () => {
              if (failureReported) return "";
              failureReported = true;
              return "forced excluded composite failure";
            };
          }
          if (property === "render_pixels_with_clear") {
            return (...args) => {
              fullFrameRenderCount += 1;
              if (
                compositeCount >= 2 &&
                fullFrameRenderCount === 2 &&
                !retryThrown
              ) {
                retryThrown = true;
                throw new Error("forced full-frame fallback after exclusion");
              }
              return value.apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
  }
  return {
    ...wasm,
    default: undefined,
    GerberProcessor: ExcludedDependencyRetryProcessor,
    __getInvertedRebuildCount: () => invertedRebuildCount,
  };
}

async function createLateBandCompositeFailureModule() {
  const wasm = await import(wasmModuleUrl.href);
  wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
  let failureReported = false;
  class LateBandCompositeFailureProcessor {
    constructor() {
      const processor = new wasm.GerberProcessor();
      let hasComposite = false;
      let renderedLaterBand = false;
      return new Proxy(processor, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof property === "string" && property.startsWith("add_composite_layer")) {
            return (...args) => {
              hasComposite = true;
              return value.apply(target, args);
            };
          }
          if (property === "render_tile" || property === "render_tile_with_blend_modes") {
            return (...args) => {
              renderedLaterBand ||= Number(args[5]) > 0;
              return value.apply(target, args);
            };
          }
          if (property === "get_composite_error") {
            return () => {
              if (!hasComposite || !renderedLaterBand || failureReported) return "";
              failureReported = true;
              return "forced late-band composite failure";
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
  }
  return {
    ...wasm,
    default: undefined,
    GerberProcessor: LateBandCompositeFailureProcessor,
  };
}

async function renderLateBandFailureCase(wasmModule, failures = []) {
  const renderer = await createNodeGerberRenderer({
    ...(wasmModule
      ? {
          wasmModule,
          __continueOnCompositeError: true,
          __onCompositeError: (failure) => failures.push(failure),
        }
      : {}),
  });
  try {
    await renderer.withFrame(
      {
        width: 96,
        height: 96,
        strategy: "stream",
        maxBandBytes: 96 * 4 * 12,
        fit: false,
        background: null,
        view: { zoomX: 0.08, zoomY: 0.08, offsetX: 0, offsetY: 0 },
      },
      async () => {
        const first = await renderer.renderLayer(flashGerber(0), {
          color: "#ff0000",
          alpha: 1,
        });
        const second = await renderer.renderLayer(flashGerber(4), {
          visible: false,
        });
        if (wasmModule) {
          await renderer.renderCompositeLayer([first, second], {
            name: "Late band failure",
            color: "#00ff00",
            alpha: 1,
          });
        }
      },
    );
    return decodeRgbaPng(await renderer.exportPng());
  } finally {
    renderer.dispose();
  }
}

async function addForcedFailureFrame(renderer, strategy) {
  await renderer.withFrame(
    {
      width: 64,
      height: 64,
      strategy,
      background: null,
      fit: false,
      view: { zoomX: 0.08, zoomY: 0.08, offsetX: 0, offsetY: 0 },
    },
    async () => {
      const first = await renderer.renderLayer(
        { source: flashGerber(0), name: "healthy.gbr" },
        { color: "#ff0000", alpha: 1 },
      );
      const second = await renderer.renderLayer(
        { source: flashGerber(4), name: "dependency.gbr" },
        { visible: false },
      );
      await renderer.renderCompositeLayer([first, second], {
        name: "Forced failure",
        color: "#00ff00",
        alpha: 1,
      });
    },
  );
}

async function addExcludedDependencyFrame(
  renderer,
  includeFailedComposite,
  strategy = "auto",
) {
  await renderer.withFrame(
    {
      width: 96,
      height: 64,
      strategy,
      background: null,
      fit: false,
      invertedOutline: "bounds",
      view: { zoomX: 0.08, zoomY: 0.08, offsetX: 0, offsetY: 0 },
    },
    async () => {
      await renderer.renderLayer(flashGerber(0), {
        color: "#ff0000",
        alpha: 1,
      });
      const remoteInverted = await renderer.renderLayer(flashGerber(1_000), {
        visible: false,
        inverted: true,
      });
      const remoteOther = await renderer.renderLayer(flashGerber(1_004), {
        visible: false,
      });
      if (includeFailedComposite) {
        await renderer.renderCompositeLayer([remoteInverted, remoteOther], {
          name: "Excluded remote composite",
          color: "#00ff00",
          alpha: 1,
        });
      }
      const healthyFirst = await renderer.renderLayer(flashGerber(0), {
        visible: false,
      });
      const healthySecond = await renderer.renderLayer(flashGerber(4), {
        visible: false,
      });
      await renderer.renderCompositeLayer([healthyFirst, healthySecond], {
        name: "Healthy composite",
        color: "#0000ff",
        alpha: 1,
      });
    },
  );
}

async function renderAutoFitFailureCase({ strategy, failureKind = null }) {
  const wasmModule = failureKind === "construction"
    ? await createForcedCompositeConstructionFailureModule()
    : failureKind === "lazy"
      ? await createForcedCompositeFailureModule()
      : undefined;
  const renderer = await createNodeGerberRenderer({
    ...(wasmModule ? { wasmModule, __continueOnCompositeError: true } : {}),
  });
  try {
    await renderer.withFrame(
      {
        width: 96,
        height: 64,
        strategy,
        background: null,
        padding: 4,
      },
      async () => {
        await renderer.renderLayer(
          { source: flashGerber(0), name: "healthy-origin.gbr" },
          { color: "#ff0000", alpha: 1 },
        );
        const remoteFirst = await renderer.renderLayer(
          { source: flashGerber(1_000), name: "remote-first.gbr" },
          { visible: false },
        );
        const remoteSecond = await renderer.renderLayer(
          { source: flashGerber(1_004), name: "remote-second.gbr" },
          { visible: false },
        );
        if (failureKind) {
          await renderer.renderCompositeLayer([remoteFirst, remoteSecond], {
            name: "Remote failed composite",
            color: "#00ff00",
            alpha: 1,
          });
        }
      },
    );
    return decodeRgbaPng(await renderer.exportPng());
  } finally {
    renderer.dispose();
  }
}

async function addTwoCompositeFrame(renderer, strategy) {
  await renderer.withFrame(
    {
      width: 64,
      height: 64,
      strategy,
      background: null,
      fit: false,
      view: { zoomX: 0.08, zoomY: 0.08, offsetX: 0, offsetY: 0 },
    },
    async () => {
      const first = await renderer.renderLayer(flashGerber(0), { visible: false });
      const second = await renderer.renderLayer(flashGerber(4), { visible: false });
      await renderer.renderCompositeLayer([first, second], {
        name: "First composite",
        color: "#ff0000",
        alpha: 1,
      });
      await renderer.renderCompositeLayer([first, second], {
        name: "Second composite",
        color: "#00ff00",
        alpha: 1,
      });
    },
  );
}

async function renderNodeLateFallbackComposite(strategy) {
  const renderer = await createNodeGerberRenderer();
  try {
    await addLateFallbackFrame(renderer, strategy);
    return decodeRgbaPng(await renderer.exportPng());
  } finally {
    renderer.dispose();
  }
}

async function addLateFallbackFrame(renderer, strategy) {
  await renderer.withFrame(
    {
      width: 128,
      height: 128,
      strategy,
      background: null,
      fit: false,
      view: { zoomX: 0.08, zoomY: 0.08, offsetX: 0, offsetY: 0 },
    },
    async () => {
      const first = await renderer.renderLayer(
        { source: flashGerber(0), name: "first.gbr" },
        { visible: false },
      );
      const second = await renderer.renderLayer(
        { source: flashGerber(1), name: "second.gbr" },
        { visible: false },
      );
      await renderer.renderCompositeLayer([first, second], {
        visibleAreas: ["00"],
        color: "#00ff00",
        alpha: 1,
      });
      await renderer.renderLayer(
        { source: flashGerber(10), name: "late-transparent.gbr" },
        { alpha: 0 },
      );
    },
  );
}

function flashGerber(x) {
  const coordinate = String(x * 10_000).padStart(6, "0");
  return `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.000*%\nD10*\nX${coordinate}Y000000D03*\nM02*`;
}

function filledRegionGerber() {
  return `%FSLAX24Y24*%
%MOMM*%
%LPD*%
G36*
X010000Y000000D02*
G03*
X-010000Y000000I-010000J000000D01*
X010000Y000000I010000J000000D01*
G37*
M02*`;
}

function membershipGerber(x) {
  return `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.400*%\nD10*\nX${gerberCoordinate(x)}Y000000D03*\nX000000Y050000D03*\nM02*`;
}

function outlineGerber() {
  return `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.200*%\nD10*\nX-050000Y-050000D02*\nX050000Y-050000D01*\nX050000Y050000D01*\nX-050000Y050000D01*\nX-050000Y-050000D01*\nM02*`;
}

function nestedOutlineGerber() {
  return `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.200*%\nD10*\nX-050000Y-050000D02*\nX050000Y-050000D01*\nX050000Y050000D01*\nX-050000Y050000D01*\nX-050000Y-050000D01*\nX-020000Y-020000D02*\nX020000Y-020000D01*\nX020000Y020000D01*\nX-020000Y020000D01*\nX-020000Y-020000D01*\nM02*`;
}

function regionOutlineWithHoleGerber() {
  return `%FSLAX24Y24*%
%MOMM*%
%LPD*%
G36*
X-050000Y-050000D02*
G01*
X050000Y-050000D01*
X050000Y050000D01*
X-050000Y050000D01*
X-050000Y-050000D01*
X-020000Y-020000D02*
X-020000Y020000D01*
X020000Y020000D01*
X020000Y-020000D01*
X-020000Y-020000D01*
G37*
M02*`;
}

function twoFlashGerber(xs) {
  return multiFlashGerber(xs, 1.5);
}

function multiFlashGerber(xs, diameter) {
  return multiPointFlashGerber(xs.map((x) => [x, 0]), diameter);
}

function multiPointFlashGerber(points, diameter) {
  const flashes = points
    .map(([x, y]) => `X${gerberCoordinate(x)}Y${gerberCoordinate(y)}D03*`)
    .join("\n");
  return `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,${diameter.toFixed(3)}*%\nD10*\n${flashes}\nM02*`;
}

function gerberCoordinate(value) {
  const sign = value < 0 ? "-" : "";
  return `${sign}${String(Math.round(Math.abs(value) * 10_000)).padStart(6, "0")}`;
}

function compositePngPixelOffset(worldX, worldY) {
  const x = Math.round((worldX * 0.08 + 1) * 64);
  const y = 127 - Math.round((worldY * 0.08 + 1) * 64);
  return (y * 128 + x) * 4;
}

function assertGreenPixel(pixels, worldX, worldY, label) {
  const offset = compositePngPixelOffset(worldX, worldY);
  assert.ok(pixels[offset] < 20, `${label}: red channel`);
  assert.ok(pixels[offset + 1] > 200, `${label}: green channel`);
  assert.ok(pixels[offset + 2] < 20, `${label}: blue channel`);
  assert.ok(pixels[offset + 3] > 200, `${label}: alpha channel`);
}

function assertTransparentPixel(pixels, worldX, worldY, label) {
  const offset = compositePngPixelOffset(worldX, worldY);
  assert.equal(pixels[offset + 3], 0, `${label}: alpha channel`);
}

function createHostileObjectBindingState(gl) {
  const createAttachment = () => {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    return { framebuffer, texture };
  };
  const compileShader = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    assert.equal(gl.getShaderParameter(shader, gl.COMPILE_STATUS), true);
    return shader;
  };

  const draw = createAttachment();
  const read = createAttachment();
  const renderbuffer = gl.createRenderbuffer();
  const vertexShader = compileShader(
    gl.VERTEX_SHADER,
    "#version 300 es\nin vec2 position; void main(){gl_Position=vec4(position,0,1);}",
  );
  const fragmentShader = compileShader(
    gl.FRAGMENT_SHADER,
    "#version 300 es\nprecision mediump float; out vec4 color; void main(){color=vec4(1);}",
  );
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  assert.equal(gl.getProgramParameter(program, gl.LINK_STATUS), true);

  const vertexArray = gl.createVertexArray();
  const arrayBuffer = gl.createBuffer();
  const pixelPackBuffer = gl.createBuffer();
  const pixelUnpackBuffer = gl.createBuffer();
  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, arrayBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 0, 0, 0]), gl.STATIC_DRAW);
  const attributeCount = gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
  for (let index = 0; index < attributeCount; index += 1) {
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(index, 1);
  }

  const textureUnits = [...Array(8).keys()];
  const highTextureUnit = Math.min(
    gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) - 1,
    15,
  );
  assert.ok(highTextureUnit >= 8);
  textureUnits.push(highTextureUnit);
  const textures = textureUnits.map((unit) => {
    const texture = gl.createTexture();
    const sampler = gl.createSampler();
    gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindSampler(unit, sampler);
    return { unit, texture, sampler };
  });

  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw.framebuffer);
  gl.drawBuffers([gl.NONE]);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read.framebuffer);
  gl.readBuffer(gl.NONE);
  gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
  gl.useProgram(program);
  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, arrayBuffer);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pixelPackBuffer);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, pixelUnpackBuffer);
  gl.activeTexture(gl.TEXTURE0 + highTextureUnit);

  return {
    draw,
    read,
    renderbuffer,
    program,
    vertexShader,
    fragmentShader,
    vertexArray,
    arrayBuffer,
    pixelPackBuffer,
    pixelUnpackBuffer,
    attributeCount,
    textures,
    highTextureUnit,
    readBuffer: gl.NONE,
  };
}

function assertHostileObjectBindingState(gl, state) {
  assert.equal(gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), state.draw.framebuffer);
  assert.equal(gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), state.read.framebuffer);
  assert.equal(gl.getParameter(gl.READ_BUFFER), state.readBuffer);
  assert.equal(gl.getParameter(gl.DRAW_BUFFER0), gl.NONE);
  assert.equal(gl.getParameter(gl.RENDERBUFFER_BINDING), state.renderbuffer);
  assert.equal(gl.getParameter(gl.CURRENT_PROGRAM), state.program);
  assert.equal(gl.getParameter(gl.VERTEX_ARRAY_BINDING), state.vertexArray);
  assert.equal(gl.getParameter(gl.ARRAY_BUFFER_BINDING), state.arrayBuffer);
  assert.equal(gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING), state.pixelPackBuffer);
  assert.equal(gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING), state.pixelUnpackBuffer);
  for (let index = 0; index < state.attributeCount; index += 1) {
    assert.equal(gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_DIVISOR), 1);
    assert.equal(
      gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING),
      state.arrayBuffer,
    );
  }
  for (const { unit, texture, sampler } of state.textures) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    assert.equal(gl.getParameter(gl.TEXTURE_BINDING_2D), texture);
    assert.equal(gl.getParameter(gl.SAMPLER_BINDING), sampler);
  }
  gl.activeTexture(gl.TEXTURE0 + state.highTextureUnit);
  assert.equal(gl.getParameter(gl.ACTIVE_TEXTURE), gl.TEXTURE0 + state.highTextureUnit);
}

function readDefaultFramebufferPixel(gl, state, x, y) {
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  const pixel = readCanvasPixel(gl, x, y);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.read.framebuffer);
  gl.readBuffer(state.readBuffer);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, state.pixelPackBuffer);
  return pixel;
}

function disposeHostileObjectBindingState(gl, state) {
  gl.useProgram(null);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.drawBuffers([gl.BACK]);
  for (const { unit, texture, sampler } of state.textures) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindSampler(unit, null);
    gl.deleteTexture(texture);
    gl.deleteSampler(sampler);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.deleteBuffer(state.arrayBuffer);
  gl.deleteBuffer(state.pixelPackBuffer);
  gl.deleteBuffer(state.pixelUnpackBuffer);
  gl.deleteVertexArray(state.vertexArray);
  gl.deleteProgram(state.program);
  gl.deleteShader(state.vertexShader);
  gl.deleteShader(state.fragmentShader);
  gl.deleteRenderbuffer(state.renderbuffer);
  gl.deleteFramebuffer(state.draw.framebuffer);
  gl.deleteTexture(state.draw.texture);
  gl.deleteFramebuffer(state.read.framebuffer);
  gl.deleteTexture(state.read.texture);
}

function compositeStageFailureProxy(rawGl) {
  let queuedError = null;
  let drawCount = 0;
  let failDrawAt = null;
  let readCount = 0;
  let failReadAt = null;
  let createFailure = null;
  let createFailureRemaining = 0;
  let tracked = null;
  const deleted = {
    textures: new Set(),
    framebuffers: new Set(),
    renderbuffers: new Set(),
  };

  const gl = new Proxy(rawGl, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "getError") {
        return () => {
          if (queuedError != null) {
            const error = queuedError;
            queuedError = null;
            return error;
          }
          return value.call(target);
        };
      }
      if (property === "drawArrays") {
        return (...args) => {
          drawCount += 1;
          if (failDrawAt === drawCount) {
            failDrawAt = null;
            queuedError = target.OUT_OF_MEMORY;
            return undefined;
          }
          return value.apply(target, args);
        };
      }
      if (property === "readPixels") {
        return (...args) => {
          const result = value.apply(target, args);
          readCount += 1;
          if (failReadAt === readCount) {
            failReadAt = null;
            queuedError = target.OUT_OF_MEMORY;
          }
          return result;
        };
      }
      if (["createTexture", "createFramebuffer", "createRenderbuffer"].includes(property)) {
        return (...args) => {
          const kind = property.slice("create".length).toLowerCase();
          if (createFailure === kind) {
            createFailureRemaining -= 1;
            if (createFailureRemaining === 0) {
              createFailure = null;
              return null;
            }
          }
          const resource = value.apply(target, args);
          if (resource && tracked) tracked[`${kind}s`].add(resource);
          return resource;
        };
      }
      if (["deleteTexture", "deleteFramebuffer", "deleteRenderbuffer"].includes(property)) {
        return (resource) => {
          const kind = property.slice("delete".length).toLowerCase();
          if (resource) deleted[`${kind}s`].add(resource);
          return value.call(target, resource);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    gl,
    armDrawFailure(occurrence) {
      drawCount = 0;
      failDrawAt = occurrence;
    },
    armReadFailure(occurrence = 1) {
      readCount = 0;
      failReadAt = occurrence;
    },
    armCreateFailure(kind, occurrence = 1) {
      assert.ok(["texture", "framebuffer", "renderbuffer"].includes(kind));
      createFailure = kind;
      createFailureRemaining = occurrence;
      tracked = {
        textures: new Set(),
        framebuffers: new Set(),
        renderbuffers: new Set(),
      };
      for (const resources of Object.values(deleted)) resources.clear();
    },
    wereTrackedResourcesDeleted() {
      return tracked != null && Object.entries(tracked).every(
        ([kind, resources]) => [...resources].every((resource) => deleted[kind].has(resource)),
      );
    },
  };
}

function resourceLifecycleProxy(rawGl) {
  const methodKinds = new Map([
    ["createTexture", "texture"],
    ["createFramebuffer", "framebuffer"],
    ["createRenderbuffer", "renderbuffer"],
    ["createBuffer", "buffer"],
    ["createProgram", "program"],
    ["createVertexArray", "vertexArray"],
    ["createShader", "shader"],
  ]);
  const live = new Map([...new Set(methodKinds.values())].map((kind) => [kind, new Set()]));
  const doubleDeletes = [];
  let failureKind = null;
  let failureRemaining = 0;
  const gl = new Proxy(rawGl, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      const createKind = methodKinds.get(property);
      if (createKind) {
        return (...args) => {
          if (failureKind === createKind) {
            failureRemaining -= 1;
            if (failureRemaining === 0) {
              failureKind = null;
              return null;
            }
          }
          const resource = value.apply(target, args);
          if (resource != null) live.get(createKind).add(resource);
          return resource;
        };
      }
      if (typeof property === "string" && property.startsWith("delete")) {
        const createName = `create${property.slice("delete".length)}`;
        const deleteKind = methodKinds.get(createName);
        if (deleteKind) {
          return (resource) => {
            if (resource != null && !live.get(deleteKind).delete(resource)) {
              doubleDeletes.push(deleteKind);
            }
            return value.call(target, resource);
          };
        }
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const liveCounts = () => Object.fromEntries(
    [...live].map(([kind, resources]) => [kind, resources.size]),
  );
  return {
    gl,
    failNextCreate(kind, occurrence = 1) {
      assert.ok(live.has(kind));
      assert.ok(Number.isInteger(occurrence) && occurrence > 0);
      failureKind = kind;
      failureRemaining = occurrence;
    },
    liveCounts,
    totalLive() {
      return Object.values(liveCounts()).reduce((sum, count) => sum + count, 0);
    },
    assertNoDoubleDeletes() {
      assert.deepEqual(doubleDeletes, []);
    },
  };
}

function bufferUploadFailureProxy(rawGl) {
  let nextOperation = null;
  let remainingOperationCalls = 0;
  let forcedGetError = null;
  let failedBuffer = null;
  let failedBufferDeleted = false;
  let buffersCreatedSinceArm = null;
  const gl = new Proxy(rawGl, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "getError") {
        return () => {
          if (forcedGetError != null) {
            const error = forcedGetError;
            forcedGetError = null;
            return error;
          }
          return value.call(target);
        };
      }
      if (property === "bufferData" || property === "bufferSubData") {
        return (...args) => {
          const result = value.apply(target, args);
          if (nextOperation === property) {
            remainingOperationCalls -= 1;
            if (remainingOperationCalls === 0) {
              nextOperation = null;
              failedBuffer = target.getParameter(target.ARRAY_BUFFER_BINDING);
              forcedGetError = target.OUT_OF_MEMORY;
            }
          }
          return result;
        };
      }
      if (property === "createBuffer") {
        return () => {
          const buffer = value.call(target);
          if (buffer != null) buffersCreatedSinceArm?.add(buffer);
          return buffer;
        };
      }
      if (property === "deleteBuffer") {
        return (buffer) => {
          if (buffer != null && buffer === failedBuffer) failedBufferDeleted = true;
          buffersCreatedSinceArm?.delete(buffer);
          return value.call(target, buffer);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    gl,
    force(operation, occurrence = 1) {
      assert.ok(operation === "bufferData" || operation === "bufferSubData");
      assert.ok(Number.isInteger(occurrence) && occurrence > 0);
      nextOperation = operation;
      remainingOperationCalls = occurrence;
      failedBuffer = null;
      failedBufferDeleted = false;
      buffersCreatedSinceArm = new Set();
    },
    wasFailedBufferDeleted() {
      return failedBufferDeleted;
    },
    wereCreatedBuffersDeleted() {
      return buffersCreatedSinceArm?.size === 0;
    },
  };
}

async function withCompositeProcessor(
  callback,
  {
    r8FailureMode = null,
    monitorDither = false,
    monitorLutUpload = false,
    monitorStencilClear = false,
    monitorTextureUnitQuery = false,
    monitorBufferUpload = false,
    monitorTextureAllocation = false,
    monitorTextureParameter = false,
    poisonRgbaAllocations = false,
  } = {},
) {
  const wasm = await import(wasmModuleUrl.href);
  wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
  const { createWebGLRenderingContext } = require("node-gles-webgl2");
  const rawGl = createWebGLRenderingContext({
    width: 256,
    height: 256,
    majorVersion: 3,
    minorVersion: 0,
    webGLCompatibility: true,
  });
  let forceNextR8 = false;
  let forcedR8 = false;
  let rgbaAfterR8Failure = 0;
  let forcedGetError = null;
  let forceNextLutUpload = false;
  let forceNextTextureUnitQuery = false;
  let forceNextTextureAllocation = false;
  let textureParameterFailureCountdown = 0;
  let ditherDisableCount = 0;
  let drawsWhileDitherDisabled = 0;
  let stencilZeroClearCount = 0;
  const bufferFailure = bufferUploadFailureProxy(rawGl);
  const instrumentedGl = monitorBufferUpload ? bufferFailure.gl : rawGl;
  const gl = r8FailureMode || monitorDither || monitorLutUpload || monitorStencilClear ||
      monitorTextureUnitQuery || monitorTextureAllocation || monitorTextureParameter ||
      poisonRgbaAllocations
    ? new Proxy(instrumentedGl, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "disable") {
            return (capability) => {
              if (monitorDither && capability === target.DITHER) {
                ditherDisableCount += 1;
              }
              return value.call(target, capability);
            };
          }
          if (property === "drawArrays") {
            return (...args) => {
              if (monitorDither && !target.isEnabled(target.DITHER)) {
                drawsWhileDitherDisabled += 1;
              }
              return value.apply(target, args);
            };
          }
          if (property === "clearStencil") {
            return (valueToClear) => {
              if (monitorStencilClear && valueToClear === 0) {
                stencilZeroClearCount += 1;
              }
              return value.call(target, valueToClear);
            };
          }
          if (property === "getError") {
            return () => {
              if (forcedGetError != null) {
                const error = forcedGetError;
                forcedGetError = null;
                return error;
              }
              return value.call(target);
            };
          }
          if (property === "getParameter") {
            return (parameter) => {
              if (
                monitorTextureUnitQuery &&
                forceNextTextureUnitQuery &&
                parameter === target.MAX_TEXTURE_IMAGE_UNITS
              ) {
                forceNextTextureUnitQuery = false;
                throw new Error("forced membership texture-unit query failure");
              }
              return value.call(target, parameter);
            };
          }
          if (property === "texImage2D") {
            return (...args) => {
              if (
                poisonRgbaAllocations &&
                args.length === 9 &&
                args[2] === target.RGBA &&
                args[6] === target.RGBA &&
                args[8] == null
              ) {
                args[8] = new Uint8Array(args[3] * args[4] * 4).fill(0x5a);
              }
              if (forceNextTextureAllocation) {
                forceNextTextureAllocation = false;
                const result = value.apply(target, args);
                forcedGetError = 0x0505;
                return result;
              }
              if (forceNextR8 && args[2] === target.R8) {
                forceNextR8 = false;
                forcedR8 = true;
                const result = value.apply(target, args);
                forcedGetError = r8FailureMode === "unsupported"
                  ? target.INVALID_ENUM
                  : 0x0505;
                return result;
              }
              if (forcedR8 && args[2] === target.RGBA8) rgbaAfterR8Failure += 1;
              return value.apply(target, args);
            };
          }
          if (property === "texSubImage2D") {
            return (...args) => {
              const result = value.apply(target, args);
              if (forceNextLutUpload) {
                forceNextLutUpload = false;
                forcedGetError = 0x0505;
              }
              return result;
            };
          }
          if (property === "texParameteri") {
            return (...args) => {
              const result = value.apply(target, args);
              if (textureParameterFailureCountdown > 0) {
                textureParameterFailureCountdown -= 1;
                if (textureParameterFailureCountdown === 0) {
                  forcedGetError = 0x0505;
                }
              }
              return result;
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : instrumentedGl;
  const processor = new wasm.GerberProcessor();
  try {
    processor.init_with_size(gl, 256, 256);
    const dummyId = processor.add_layer(flashGerber(40));
    const pick = (compositeId, worldX, worldY) =>
      processor.pick_composite_code(
        compositeId,
        Math.round((worldX * 0.05 + 1) * 128),
        Math.round((worldY * 0.05 + 1) * 128),
      );
    await callback({
      processor,
      gl,
      dummyId,
      pick,
      forceNextR8Failure: () => {
        forceNextR8 = true;
      },
      forceNextLutUploadFailure: () => {
        forceNextLutUpload = true;
      },
      forceNextTextureUnitQueryFailure: () => {
        forceNextTextureUnitQuery = true;
      },
      forceNextTextureAllocationFailure: () => {
        forceNextTextureAllocation = true;
      },
      forceTextureParameterFailure: (occurrence = 1) => {
        assert.ok(Number.isInteger(occurrence) && occurrence > 0);
        textureParameterFailureCountdown = occurrence;
      },
      forceNextBufferUploadFailure: bufferFailure.force,
      wasFailedBufferDeleted: bufferFailure.wasFailedBufferDeleted,
      wereCreatedBuffersDeleted: bufferFailure.wereCreatedBuffersDeleted,
      wasR8FailureForced: () => forcedR8,
      rgbaAllocationsAfterR8Failure: () => rgbaAfterR8Failure,
      resetDitherObservations: () => {
        ditherDisableCount = 0;
        drawsWhileDitherDisabled = 0;
      },
      getDitherObservations: () => ({
        disableCount: ditherDisableCount,
        drawsWhileDisabled: drawsWhileDitherDisabled,
      }),
      getStencilZeroClearCount: () => stencilZeroClearCount,
    });
  } finally {
    try {
      processor.clear();
    } finally {
      processor.free();
      rawGl.destroy();
    }
  }
}

function readCanvasPixel(gl, x, y) {
  const pixel = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  return [...pixel];
}

function setHostileViewportAndBlendState(gl) {
  gl.viewport(2, 3, 17, 19);
  gl.enable(gl.BLEND);
  gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_SUBTRACT);
  gl.blendFuncSeparate(
    gl.SRC_ALPHA,
    gl.ONE_MINUS_SRC_ALPHA,
    gl.DST_ALPHA,
    gl.ONE_MINUS_DST_ALPHA,
  );
  gl.clearColor(0.125, 0.25, 0.5, 0.75);
  gl.clearStencil(37);
}

function assertHostileViewportAndBlendState(gl) {
  assert.deepEqual([...gl.getParameter(gl.VIEWPORT)], [2, 3, 17, 19]);
  assert.equal(gl.isEnabled(gl.BLEND), true);
  assert.equal(gl.getParameter(gl.BLEND_EQUATION_RGB), gl.FUNC_REVERSE_SUBTRACT);
  assert.equal(gl.getParameter(gl.BLEND_EQUATION_ALPHA), gl.FUNC_SUBTRACT);
  assert.equal(gl.getParameter(gl.BLEND_SRC_RGB), gl.SRC_ALPHA);
  assert.equal(gl.getParameter(gl.BLEND_DST_RGB), gl.ONE_MINUS_SRC_ALPHA);
  assert.equal(gl.getParameter(gl.BLEND_SRC_ALPHA), gl.DST_ALPHA);
  assert.equal(gl.getParameter(gl.BLEND_DST_ALPHA), gl.ONE_MINUS_DST_ALPHA);
  assert.deepEqual([...gl.getParameter(gl.COLOR_CLEAR_VALUE)], [0.125, 0.25, 0.5, 0.75]);
  assert.equal(gl.getParameter(gl.STENCIL_CLEAR_VALUE), 37);
}

function createSelectionComposite(processor, sourceId, dummyId) {
  const compositeId = processor.add_composite_layer_with_bounds(
    new Uint32Array([sourceId, dummyId]),
    new Uint8Array([0b00000010]),
    false,
    -20,
    60,
    -20,
    20,
  );
  processor.render_composite_selection(compositeId, 0.05, 0.05, 0, 0);
  return compositeId;
}

function decodeRgbaPng(buffer) {
  const bytes = new Uint8Array(buffer);
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dataView.getUint32(16);
  const height = dataView.getUint32(20);
  const colorType = bytes[25];
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new Error(`Unsupported PNG color type: ${colorType}`);
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = dataView.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "IDAT") {
      chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const compressed = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.length, 0),
  );
  let compressedOffset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, compressedOffset);
    compressedOffset += chunk.length;
  }

  const raw = inflateSync(compressed);
  const stride = width * channels;
  const decoded = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const sourceOffset = y * (stride + 1) + 1;
    const targetOffset = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? decoded[targetOffset + x - channels] : 0;
      const up = y > 0 ? decoded[targetOffset + x - stride] : 0;
      const upLeft =
        y > 0 && x >= channels
          ? decoded[targetOffset + x - stride - channels]
          : 0;
      let value = raw[sourceOffset + x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`Unsupported PNG filter: ${filter}`);
      decoded[targetOffset + x] = value & 0xff;
    }
  }
  if (channels === 4) return decoded;

  const pixels = new Uint8Array(width * height * 4);
  for (let source = 0, target = 0; source < decoded.length; source += 3) {
    pixels[target] = decoded[source];
    pixels[target + 1] = decoded[source + 1];
    pixels[target + 2] = decoded[source + 2];
    pixels[target + 3] = 255;
    target += 4;
  }
  return pixels;
}

function paeth(left, up, upLeft) {
  const prediction = left + up - upLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upLeftDistance = Math.abs(prediction - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}
