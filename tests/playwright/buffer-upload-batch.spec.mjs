import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { collectOdbLayerSourcesFromTree, readTarArchive } from "../../js/src/odb/index.js";
import { loadUnixZDecoder } from "../../packages/wasm-gerber-renderer/test/helpers/wasm-module.mjs";

// Small committed fixture, not a large real-board performance test.
const bytes = await readFile(new URL("../../demo/odb-sample.tgz", import.meta.url));
const archive = await readTarArchive({
  name: "odb-sample.tgz",
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
}, { decompressUnixZ: await loadUnixZDecoder() });
const layers = await collectOdbLayerSourcesFromTree(archive.tree, "odb-sample.tgz");
const source = await layers.find((layer) => layer.name === "top.gtl").readText();

for (const variant of ["32", "64"]) {
  test(`wasm${variant} payload batches preserve pixels and roll back failed uploads`, async ({ page }) => {
    await page.goto("/tests/fixtures/benchmark.html");
    const result = await page.evaluate(async ({ variant, source }) => {
      const wasm = await import(`/wasm/pkg${variant === "64" ? "64" : ""}/wasm_gerber_processor.js`);
      await wasm.default();
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2", { antialias: false });
      const processor = new wasm.GerberProcessor();
      processor.init_with_size(gl, 64, 64);
      const payload = wasm.parse_gerber_layer_payload_with_options(source, 0, 0, true, 1).renderPayload;
      const reference = processor.add_layer(source);
      const pixels = (id) => Array.from(processor.render_pixels_with_clear(
        new Uint32Array([id]), new Float32Array([1, 0, 0, 1]), 0.04, 0.04, -0.8, -0.6, 1, true,
      ));
      // Populate the reference's lazy buffers before monitoring new resources.
      const expected = pixels(reference);
      const created = new Map(["Buffer", "VertexArray", "Framebuffer", "Texture"].map((kind) => [kind, new Set()]));
      const originals = new Map();
      let armed = false;
      let operation = null;
      let remaining = 0;
      let queuedErrors = [];
      let forcedErrors = null;
      let uploads = 0;
      let sinceQuery = 0;
      let queryUploads = [];
      let attributeFailure = false;
      for (const kind of created.keys()) {
        for (const prefix of ["create", "delete"]) {
          const name = prefix + kind;
          const original = gl[name].bind(gl);
          originals.set(name, original);
          gl[name] = (...args) => {
            const value = original(...args);
            if (armed && prefix === "create" && value) created.get(kind).add(value);
            if (prefix === "delete") created.get(kind).delete(args[0]);
            return value;
          };
        }
      }
      for (const name of ["bufferData", "bufferSubData", "vertexAttribPointer", "getError"]) {
        const original = gl[name].bind(gl);
        originals.set(name, original);
        gl[name] = (...args) => {
          if (name === "getError") {
            if (armed) { queryUploads.push(sinceQuery); sinceQuery = 0; }
            if (queuedErrors.length) return queuedErrors.shift();
            return original(...args);
          }
          const value = original(...args);
          if (!armed) return value;
          if (name === "bufferData") { uploads++; sinceQuery++; }
          if (operation === name && --remaining === 0) {
            queuedErrors.push(...(forcedErrors ?? [attributeFailure ? gl.INVALID_OPERATION : gl.OUT_OF_MEMORY]));
            operation = null;
          }
          return value;
        };
      }
      const reset = () => {
        armed = true; uploads = 0; sinceQuery = 0; queryUploads = [];
        for (const resources of created.values()) resources.clear();
      };
      const errors = [];
      const leaks = [];
      const survivingReference = [];
      try {
        // Errors at early and later buffers must survive until the final check.
        for (const name of ["bufferData", "bufferSubData", "vertexAttribPointer"]) {
          for (const occurrence of [1, 16, 17]) {
            reset(); operation = name; remaining = occurrence;
            attributeFailure = name === "vertexAttribPointer";
            try { processor.add_render_payload(payload); errors.push("missing error"); }
            catch (error) { errors.push(String(error)); }
            leaks.push([...created.values()].reduce((sum, resources) => sum + resources.size, 0));
            armed = false;
            survivingReference.push(JSON.stringify(pixels(reference)) === JSON.stringify(expected));
          }
        }
        // A decoding failure after a valid sublayer must also retire that
        // earlier sublayer's pending GPU resources.
        reset();
        const malformed = { ...payload, sublayers: [payload.sublayers[0], { pathRegions: {} }] };
        try { processor.add_render_payload(malformed); errors.push("missing decode error"); }
        catch (error) { errors.push(String(error)); }
        leaks.push([...created.values()].reduce((sum, resources) => sum + resources.size, 0));
        armed = false;

        // Secondary invalid-operation flags must not hide the allocation or
        // context-loss cause when the batch drains multiple flags.
        for (const flags of [[gl.INVALID_OPERATION, gl.OUT_OF_MEMORY],
          [gl.OUT_OF_MEMORY, gl.CONTEXT_LOST_WEBGL]]) {
          reset(); operation = "bufferData"; remaining = 1; forcedErrors = flags;
          try { processor.add_render_payload(payload); errors.push("missing multi-flag error"); }
          catch (error) { errors.push(String(error)); }
          leaks.push([...created.values()].reduce((sum, resources) => sum + resources.size, 0));
          armed = false;
        }
        forcedErrors = null;

        const tiny = wasm.parse_gerber_layer_payload_with_options(
          "%FSLAX24Y24*%%MOMM*%%ADD10C,1*%D10*X0Y0D03*M02*", 0, 0, true, 1,
        ).renderPayload;
        const first = tiny.sublayers[0];
        const invalidCircles = { ...first, circles: { ...first.circles, y: new Float32Array(0) } };
        const earlyReturnPayloads = [
          { ...tiny, sublayers: [first, { pathRegions: {} }] },
          { ...tiny, sublayers: [first, { ...first, boundary: { ...first.boundary, minX: NaN } }] },
          { ...tiny, sublayers: [first, invalidCircles] },
          { ...tiny, sublayers: [{ ...invalidCircles, triangles: {
            ...first.triangles, vertices: new Float32Array([0, 0, 1, 0, 0, 1]),
          } }] },
        ];
        const earlyReturns = [];
        for (const malformed of earlyReturnPayloads) {
          for (const flags of [null, [gl.INVALID_OPERATION, gl.OUT_OF_MEMORY],
            [gl.OUT_OF_MEMORY, gl.CONTEXT_LOST_WEBGL]]) {
            reset(); operation = flags ? "bufferData" : null; remaining = 1; forcedErrors = flags;
            let failure;
            try { processor.add_render_payload(malformed); failure = "missing error"; }
            catch (error) { failure = String(error); }
            const pendingError = gl.getError();
            earlyReturns.push({ failure, pendingError,
              resources: [...created.values()].reduce((sum, resources) => sum + resources.size, 0),
            });
            // Keep deliberately failing pre-fix runs from contaminating later cases.
            while (queuedErrors.length) gl.getError();
            armed = false;
          }
        }
        forcedErrors = null;

        // Polarity boundaries retain separate resources, not separate error
        // queries. This also exercises rollback across multiple sublayers and
        // the final attribute setup must still be checked at layer end.
        const alternatingSource = "%FSLAX24Y24*%%MOMM*%%ADD10C,1*%D10*" +
          Array.from({ length: 64 }, (_, i) =>
            `%LP${i % 2 ? "C" : "D"}*%X${i * 1000}Y0D03*`).join("") + "M02*";
        const alternating = wasm.parse_gerber_layer_payload_with_options(
          alternatingSource, 0, 0, true, 1,
        ).renderPayload;
        const crossLayerErrors = [];
        const crossLayerLeaks = [];
        for (const [name, occurrence] of [["bufferData", 17], ["vertexAttribPointer", 192]]) {
          reset(); operation = name; remaining = occurrence;
          attributeFailure = name === "vertexAttribPointer";
          try { processor.add_render_payload(alternating); crossLayerErrors.push("missing error"); }
          catch (error) { crossLayerErrors.push(String(error)); }
          crossLayerLeaks.push([...created.values()].reduce((sum, resources) => sum + resources.size, 0));
          armed = false;
        }
        const alternatingReference = processor.add_layer(alternatingSource);
        const alternatingExpected = pixels(alternatingReference);
        reset();
        const alternatingImported = processor.add_render_payload(alternating);
        const alternatingChecks = [...queryUploads];
        const alternatingBufferCount = uploads;
        armed = false;
        const alternatingPixelsEqual = JSON.stringify(pixels(alternatingImported)) ===
          JSON.stringify(alternatingExpected);

        reset();
        const imported = processor.add_render_payload(payload);
        const checks = [...queryUploads];
        const bufferCount = uploads;
        armed = false;
        const actual = pixels(imported);

        // Check only when cumulative bytes reach 16MiB, plus the final check.
        // A single attribute at or above the threshold is checked immediately.
        const circle = wasm.parse_gerber_layer_payload_with_options(
          "%FSLAX24Y24*%%MOMM*%%ADD10C,1*%D10*X0Y0D03*M02*", 0, 0, true, 1,
        ).renderPayload;
        const circles = circle.sublayers[0].circles;
        const byteChecks = [];
        for (const length of [3 * 1024 * 1024 / 4, 8 * 1024 * 1024 / 4,
          16 * 1024 * 1024 / 4, 16 * 1024 * 1024 / 4 + 1]) {
          circles.x = new Float32Array(length);
          circles.y = new Float32Array(length);
          circles.radius = new Float32Array(length).fill(0.5);
          reset();
          const large = processor.add_render_payload(circle);
          byteChecks.push([...queryUploads]);
          armed = false;
          processor.remove_layer(large);
        }
        // Threshold checks precede attribute setup. Errors on both the first
        // and final attribute must be caught by the next or final checkpoint.
        const thresholdErrors = [];
        const thresholdLeaks = [];
        for (const name of ["bufferData", "bufferSubData", "vertexAttribPointer"]) {
          for (const occurrence of [1, 3]) {
            reset(); operation = name; remaining = occurrence;
            attributeFailure = name === "vertexAttribPointer";
            try { processor.add_render_payload(circle); thresholdErrors.push("missing error"); }
            catch (error) { thresholdErrors.push(String(error)); }
            thresholdLeaks.push([...created.values()].reduce((sum, resources) => sum + resources.size, 0));
            armed = false;
          }
        }
        return { errors, leaks, survivingReference, checks, bufferCount, byteChecks,
          earlyReturns,
          thresholdErrors, thresholdLeaks,
          crossLayerErrors, crossLayerLeaks, alternatingChecks, alternatingBufferCount,
          alternatingPixelsEqual, alternatingSublayerCount: alternating.sublayers.length,
          hasGeometryPixels: expected.some((value, index) => index % 4 === 0 &&
            value > 0 && expected[index + 1] === 0 && expected[index + 2] === 0),
          pixelsEqual: JSON.stringify(actual) === JSON.stringify(expected),
          finalError: gl.getError() };
      } finally {
        armed = false;
        for (const [name, original] of originals) gl[name] = original;
        processor.clear(); processor.free();
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    }, { variant, source });
    expect(result.errors.slice(0, 9)).toHaveLength(9);
    for (const error of result.errors.slice(0, 9)) expect(error).toMatch(/WebGL buffer upload batch failed/);
    for (const error of result.errors.slice(0, 6)) expect(error).toContain("GPU allocation out of memory");
    expect(result.errors[9]).not.toContain("missing decode error");
    expect(result.errors[10]).toContain("GPU allocation out of memory");
    expect(result.errors[11]).toContain("WebGL context lost");
    expect(result.leaks).toEqual(Array(12).fill(0));
    expect(result.earlyReturns).toHaveLength(12);
    for (let i = 0; i < result.earlyReturns.length; i++) {
      const failure = result.earlyReturns[i];
      expect(failure.pendingError).toBe(0);
      expect(failure.resources).toBe(0);
      if (i % 3 === 0) {
        expect(failure.failure).not.toContain("missing error");
        expect(failure.failure).not.toContain("WebGL buffer upload batch failed");
      } else {
        expect(failure.failure).toContain(i % 3 === 1 ? "GPU allocation out of memory" : "WebGL context lost");
      }
    }
    expect(result.survivingReference.every(Boolean)).toBe(true);
    expect(result.bufferCount).toBeGreaterThan(16);
    expect(result.checks.filter((count) => count > 0)).toEqual([result.bufferCount]);
    expect(result.byteChecks[0].filter((count) => count > 0)).toEqual([3]);
    expect(result.byteChecks[1].filter((count) => count > 0)).toEqual([2, 1]);
    expect(result.byteChecks[2].filter((count) => count > 0)).toEqual([1, 1, 1]);
    expect(result.byteChecks[3].filter((count) => count > 0)).toEqual([1, 1, 1]);
    expect(result.thresholdErrors).toHaveLength(6);
    for (const error of result.thresholdErrors) expect(error).toMatch(/WebGL buffer upload batch failed/);
    for (const error of result.thresholdErrors.slice(0, 4)) expect(error).toContain("GPU allocation out of memory");
    expect(result.thresholdLeaks).toEqual(Array(6).fill(0));
    expect(result.pixelsEqual).toBe(true);
    expect(result.hasGeometryPixels).toBe(true);
    expect(result.finalError).toBe(0);
    expect(result.alternatingSublayerCount).toBe(64);
    expect(result.alternatingBufferCount).toBe(192);
    expect(result.alternatingChecks.filter((count) => count > 0)).toEqual([192]);
    expect(result.alternatingPixelsEqual).toBe(true);
    expect(result.crossLayerErrors[0]).toContain("GPU allocation out of memory");
    expect(result.crossLayerErrors[1]).toMatch(/WebGL buffer upload batch failed/);
    expect(result.crossLayerLeaks).toEqual([0, 0]);
  });
}
