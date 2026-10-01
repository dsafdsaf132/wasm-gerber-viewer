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

const size = 241;
const coordinate = (value) => Math.round(value * 1e6);
const point = (x, y) => `X${coordinate(x)}Y${coordinate(y)}`;
function contour(radius, clockwise = false, rotation = 0, segments = 4) {
  const points = Array.from({ length: segments + 1 }, (_, i) => {
    const angle = rotation + (clockwise ? -1 : 1) * i * Math.PI * 2 / segments;
    return [5 + radius * Math.cos(angle), 5 + radius * Math.sin(angle)];
  });
  return [
    `${point(...points[0])}D02*`,
    ...points.slice(1).map((p, i) => `${clockwise ? "G02" : "G03"}${point(...p)}I${coordinate(5 - points[i][0])}J${coordinate(5 - points[i][1])}D01*`),
  ];
}
const region = (radius, clockwise = false, rotation = 0, hole = 0, segments = 4) => [
  "G36*", ...contour(radius, clockwise, rotation, segments),
  ...(hole ? contour(hole, !clockwise, rotation, segments) : []), "G37*",
];
const gerber = (...body) => ["%FSLAX46Y46*%", "%MOMM*%", "%ADD10C,6.6*%", "D10*", "G75*", "%LPD*%", ...body, "M02*"].join("\n");

function render(content, antiAliasing = true, tileHeight = size) {
  const gl = createWebGLRenderingContext({ width: size, height: tileHeight, majorVersion: 3, minorVersion: 0, webGLCompatibility: true });
  const processor = new wasm.GerberProcessor();
  try {
    processor.init_with_size(gl, size, tileHeight);
    processor.set_anti_aliasing(antiAliasing);
    const id = processor.add_layer(content);
    const ids = new Uint32Array([id]);
    const colors = new Float32Array([1, 1, 1, 1]);
    const scale = 2 / 12;
    const pixels = new Uint8Array(size * size * 4);
    if (tileHeight === size) {
      processor.render(ids, colors, scale, scale, -5 * scale, -5 * scale, 1);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    } else {
      const tile = new Uint8Array(size * tileHeight * 4);
      for (let top = 0; top < size; top += tileHeight) {
        const height = Math.min(tileHeight, size - top);
        const renderTop = Math.min(top, size - tileHeight);
        processor.render_tile(ids, colors, size, size, 0, renderTop, size, tileHeight, scale, scale, -5 * scale, -5 * scale, 1);
        gl.readPixels(0, 0, size, tileHeight, gl.RGBA, gl.UNSIGNED_BYTE, tile);
        const sourceY = tileHeight - (top - renderTop) - height;
        pixels.set(tile.subarray(sourceY * size * 4, (sourceY + height) * size * 4), (size - top - height) * size * 4);
      }
    }
    assert.equal(processor.get_anti_aliasing_diagnostics().mode, antiAliasing ? "multisampled" : "point-sampled");
    return pixels;
  } finally {
    processor.free();
    gl.destroy();
  }
}
const partial = (pixels) => {
  let count = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0 && pixels[i] < 255) count++;
  return count;
};
const differences = (a, b) => {
  let count = 0;
  let maximum = 0;
  for (let i = 3; i < a.length; i += 4) {
    if (a[i] !== b[i]) count++;
    maximum = Math.max(maximum, Math.abs(a[i] - b[i]));
  }
  return { count, maximum };
};

renderTest("exact circular arc-region boundaries have partial coverage", () => {
  for (const rotation of [0, Math.PI / 12, Math.PI / 4]) {
    const content = gerber(...region(3.3, false, rotation));
    const off = render(content, false);
    const on = render(content);
    assert.equal(partial(off), 0);
    assert.ok(partial(on) > 100, "curves, not only sector triangle seams, must be anti-aliased");
  }
});

renderTest("arc-region dark/clear cancellation and repeated clear are exact", () => {
  const shape = region(3.3);
  const empty = render(gerber(...shape, "%LPC*%", ...shape));
  assert.equal(empty.some((value) => value !== 0), false);
  const once = render(gerber(...region(4.5), "%LPC*%", ...shape));
  const twice = render(gerber(...region(4.5), "%LPC*%", ...shape, ...shape));
  assert.deepEqual(once, twice);
});

renderTest("arc-region holes stay empty and both curved boundaries are smooth", () => {
  const pixels = render(gerber(...region(3.3, false, 0, 1.65)));
  assert.equal(pixels[((size >> 1) * size + (size >> 1)) * 4 + 3], 0);
  assert.ok(partial(pixels) > 150);
  // Fractional coverage belongs only to the two true contours, never the
  // internal chord/triangle seams used to construct their stencil parity.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) * 12 / size;
      const alpha = pixels[(y * size + x) * 4 + 3];
      if (distance > 1.75 && distance < 3.2) assert.equal(alpha, 255);
      if (distance < 1.55 || distance > 3.4) assert.equal(alpha, 0);
    }
  }
});

renderTest("mixed line/arc contours keep concave cuts and solid interiors", () => {
  // A square with a semicircular notch cut into its top edge.
  const content = gerber(
    "G36*", `${point(1, 1)}D02*`, `${point(9, 1)}D01*`,
    `${point(9, 9)}D01*`, `${point(8.3, 9)}D01*`,
    `G02${point(1.7, 9)}I-3300000J0D01*`,
    `G01${point(1, 9)}D01*`, `${point(1, 1)}D01*`, "G37*",
  );
  const pixels = render(content);
  const at = (x, y) => pixels[(Math.floor(((y - 5) / 12 + 0.5) * size) * size + Math.floor(((x - 5) / 12 + 0.5) * size)) * 4 + 3];
  assert.equal(at(5, 7), 0);
  assert.equal(at(5, 3), 255);
  assert.ok(partial(pixels) > 80);
});

renderTest("arc-region coverage agrees with the equivalent circle flash", () => {
  const arc = render(gerber(...region(3.3)));
  const flash = render(gerber(`${point(5, 5)}D03*`));
  let error = 0;
  for (let i = 3; i < arc.length; i += 4) error += Math.abs(arc[i] - flash[i]) / 255;
  assert.ok(error < 50, "sector clipping must not materially change the circular contour");
});

renderTest("subpixel arc-region fringes are not clipped by sector or bounds quads", () => {
  for (const radius of [0.1, 0.2, 0.5, 1, 3.37]) {
    const flashContent = gerber(`%ADD11C,${radius * 2}*%`, "D11*", `${point(5, 5)}D03*`);
    const flash = render(flashContent);
    for (const angle of [0, Math.PI / 12, Math.PI / 4]) {
      const arc = render(gerber(...region(radius, false, angle)));
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) * 12 / size;
          if (distance < radius) continue;
          const index = (y * size + x) * 4 + 3;
          assert.ok(Math.abs(arc[index] - flash[index]) <= 64,
            `radius ${radius}, angle ${angle}: outer fringe alpha ${arc[index]} differs from ${flash[index]}`);
        }
      }
    }
  }
});

renderTest("short arc caps keep solid interiors and cancel without stencil residue", () => {
  for (const segments of [16, 128]) {
    const shape = region(3.3, false, Math.PI / 12, 1.65, segments);
    const pixels = render(gerber(...shape));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) * 12 / size;
        if (distance > 1.75 && distance < 3.2) assert.equal(pixels[(y * size + x) * 4 + 3], 255);
      }
    }
    const empty = render(gerber(...shape, "%LPC*%", ...shape));
    assert.equal(empty.some((value) => value !== 0), false);
  }
});

renderTest("arc-region tiles preserve geometry and winding does not affect coverage", () => {
  for (const angle of [0, Math.PI / 12, Math.PI / 4]) {
    const content = gerber(...region(3.3, false, angle, 1.65));
    const full = render(content);
    const tiled = render(content, true, 17);
    const reversed = render(gerber(...region(3.3, true, angle, 1.65)));
    // GL permits position-dependent alpha-to-coverage dithering. ANGLE GLES
    // also differs by one sample for the existing analytic circle shader.
    // Require exact Off parity and no more than one sample of AA difference.
    assert.equal(differences(render(content, false, 17), render(content, false)).count, 0);
    assert.ok(differences(tiled, full).maximum <= 64);
    assert.ok(partial(tiled) > 150);
    assert.equal(differences(reversed, full).count, 0);
  }
});
