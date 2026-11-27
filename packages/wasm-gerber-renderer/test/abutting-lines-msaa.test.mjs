import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const wasmUrl = new URL("../../../wasm/pkg/wasm_gerber_processor.js", import.meta.url);
const wasmBinaryUrl = new URL("../../../wasm/pkg/wasm_gerber_processor_bg.wasm", import.meta.url);
let canRender = existsSync(wasmUrl) && existsSync(wasmBinaryUrl);
try {
  require.resolve("node-gles-webgl2");
} catch {
  canRender = false;
}
const renderTest = (name, callback) => test(
  name,
  { skip: !canRender && "release WASM and node-gles-webgl2 are required" },
  callback,
);

let wasm;
let createWebGLRenderingContext;
if (canRender) {
  ({ createWebGLRenderingContext } = require("node-gles-webgl2"));
  wasm = await import(wasmUrl.href);
  wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
}

// Horizontal abutting lines: radius = 1 mm (width = 2 mm), spacing = 2 mm
// Line 1: Y = 0 mm, spans Y in [-1, +1]
// Line 2: Y = 2 mm, spans Y in [+1, +3]
// Touching boundary is at Y = 1.0 mm without any gap.
const horizontalAbuttingGerber = `
%FSLAX46Y46*%
%MOMM*%
%ADD10C,2.0*%
D10*
X0000000Y0000000D02*
X10000000Y0000000D01*
X0000000Y2000000D02*
X10000000Y2000000D01*
M02*
`;

// Vertical abutting lines: radius = 1 mm, spacing = 2 mm
// Line 1: X = 0 mm, spans X in [-1, +1]
// Line 2: X = 2 mm, spans X in [+1, +3]
// Touching boundary is at X = 1.0 mm.
const verticalAbuttingGerber = `
%FSLAX46Y46*%
%MOMM*%
%ADD10C,2.0*%
D10*
X0000000Y0000000D02*
X0000000Y10000000D01*
X2000000Y0000000D02*
X2000000Y10000000D01*
M02*
`;

renderTest("horizontal abutting lines have full coverage and no gap with MSAA off, 4x, 8x, 16x", () => {
  const size = 200;
  const gl = createWebGLRenderingContext({ width: size, height: size, majorVersion: 3, minorVersion: 0, webGLCompatibility: true });
  const processor = new wasm.GerberProcessor();
  processor.init_with_size(gl, size, size);

  const id = processor.add_layer(horizontalAbuttingGerber);
  const ids = new Uint32Array([id]);
  const colors = new Float32Array([1, 1, 1, 1]);
  const scale = 0.2; // 1 mm = 20 px, 1 px = 0.05 mm

  for (const msaa of [false, 4, 8, 16]) {
    processor.set_anti_aliasing(msaa !== false);
    if (msaa !== false) {
      processor.set_msaa_samples(msaa);
    }

    for (const frac of [0.0, 0.25, 0.5, 0.75]) {
      const yShift = frac * 0.05;
      processor.render(ids, colors, scale, scale, -5.0 * scale, -(1.0 + yShift) * scale, 1);
      const pixels = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      // Check rows across the touching boundary at X=100 (inside line segments)
      let minAlpha = 255;
      for (let y = 97; y <= 103; y++) {
        const idx = (y * size + 100) * 4;
        minAlpha = Math.min(minAlpha, pixels[idx + 3]);
      }
      assert.equal(
        minAlpha,
        255,
        `Expected full coverage (255) along boundary for MSAA=${msaa}, frac=${frac}, got ${minAlpha}`,
      );
    }
  }
});

renderTest("vertical abutting lines have full coverage and no gap with MSAA off, 4x, 8x, 16x", () => {
  const size = 200;
  const gl = createWebGLRenderingContext({ width: size, height: size, majorVersion: 3, minorVersion: 0, webGLCompatibility: true });
  const processor = new wasm.GerberProcessor();
  processor.init_with_size(gl, size, size);

  const id = processor.add_layer(verticalAbuttingGerber);
  const ids = new Uint32Array([id]);
  const colors = new Float32Array([1, 1, 1, 1]);
  const scale = 0.2;

  for (const msaa of [false, 4, 8, 16]) {
    processor.set_anti_aliasing(msaa !== false);
    if (msaa !== false) {
      processor.set_msaa_samples(msaa);
    }

    for (const frac of [0.0, 0.25, 0.5, 0.75]) {
      const xShift = frac * 0.05;
      processor.render(ids, colors, scale, scale, -(1.0 + xShift) * scale, -5.0 * scale, 1);
      const pixels = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      let minAlpha = 255;
      for (let x = 97; x <= 103; x++) {
        const idx = (100 * size + x) * 4;
        minAlpha = Math.min(minAlpha, pixels[idx + 3]);
      }
      assert.equal(
        minAlpha,
        255,
        `Expected full coverage (255) along boundary for MSAA=${msaa}, frac=${frac}, got ${minAlpha}`,
      );
    }
  }
});

renderTest("diagonal line retains smooth hardware MSAA anti-aliased edge coverage", () => {
  const diagonalGerber = `
%FSLAX46Y46*%
%MOMM*%
%ADD10C,2.0*%
D10*
X0000000Y0000000D02*
X10000000Y5000000D01*
M02*
`;
  const size = 200;
  const gl = createWebGLRenderingContext({ width: size, height: size, majorVersion: 3, minorVersion: 0, webGLCompatibility: true });
  const processor = new wasm.GerberProcessor();
  processor.init_with_size(gl, size, size);
  const id = processor.add_layer(diagonalGerber);
  const ids = new Uint32Array([id]);
  const colors = new Float32Array([1, 1, 1, 1]);
  const scale = 0.15;

  processor.set_anti_aliasing(false);
  processor.render(ids, colors, scale, scale, -5.0 * scale, -2.5 * scale, 1);
  const offPixels = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, offPixels);
  const offAlphas = new Set(Array.from({ length: size * size }, (_, i) => offPixels[i * 4 + 3]));
  // Off should only have binary 0 and 255
  assert.deepEqual(Array.from(offAlphas).sort((a, b) => a - b), [0, 255]);

  processor.set_anti_aliasing(true);
  processor.set_msaa_samples(4);
  processor.render(ids, colors, scale, scale, -5.0 * scale, -2.5 * scale, 1);
  const onPixels = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, onPixels);
  const onAlphas = new Set(Array.from({ length: size * size }, (_, i) => onPixels[i * 4 + 3]));
  // MSAA on should produce intermediate edge alpha values from multisample resolve
  assert.ok(onAlphas.size > 2, "Expected intermediate coverage values from MSAA resolve");
});
