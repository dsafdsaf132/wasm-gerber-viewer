import assert from "node:assert/strict";
import test from "node:test";

import { classifyWebGlRenderer } from "../scripts/webgl-renderer-classification.mjs";

test("known software WebGL backends are never hardware-verified", () => {
  for (const renderer of [
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))",
    "llvmpipe (LLVM 18.1.8, 256 bits)",
    "Mesa Vulkan lavapipe",
    "softpipe",
    "Microsoft Basic Render Driver",
  ]) {
    assert.deepEqual(classifyWebGlRenderer("test vendor", renderer), {
      softwareRenderer: true,
      hardwareRendererVerified: false,
    });
  }
});

test("representative physical GPUs are hardware-verified", () => {
  for (const [vendor, renderer] of [
    ["Google Inc. (NVIDIA)", "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090)"],
    ["Intel Inc.", "ANGLE (Intel, Intel Arc A770)"],
    ["ATI Technologies Inc.", "AMD Radeon RX 7900 XTX"],
    ["Apple Inc.", "Apple M3"],
    ["Qualcomm", "Adreno 740"],
  ]) {
    assert.deepEqual(classifyWebGlRenderer(vendor, renderer), {
      softwareRenderer: false,
      hardwareRendererVerified: true,
    });
  }
});

test("unknown or masked renderer identities are not accepted as hardware", () => {
  assert.deepEqual(classifyWebGlRenderer("WebKit", "WebKit WebGL"), {
    softwareRenderer: false,
    hardwareRendererVerified: false,
  });
  assert.deepEqual(classifyWebGlRenderer("", ""), {
    softwareRenderer: false,
    hardwareRendererVerified: false,
  });
});
