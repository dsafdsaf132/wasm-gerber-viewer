import assert from "node:assert/strict";
import test from "node:test";

import { GerberRenderer } from "../index.js";

test("browser PNG streaming aborts the writable after a render failure", async () => {
  const gl = makeGl({ readError: new Error("readPixels failed") });
  const renderer = makeRenderer(gl);
  const events = [];
  const writable = {
    async write() {
      events.push("write");
    },
    async close() {
      events.push("close");
    },
    async abort(error) {
      events.push(["abort", error]);
    },
  };

  await assert.rejects(
    renderer.exportPngStream(writable, { background: null, maxBandBytes: 1024 }),
    /readPixels failed/,
  );

  assert.equal(events.filter((event) => event === "write").length >= 2, true);
  assert.equal(events.includes("close"), false);
  const abortEvent = events.find(Array.isArray);
  assert.equal(abortEvent[0], "abort");
  assert.match(abortEvent[1].message, /readPixels failed/);
});

test("browser PNG streaming closes the writable after success", async () => {
  const renderer = makeRenderer(makeGl());
  const events = [];
  const writable = {
    async write() {
      events.push("write");
    },
    async close() {
      events.push("close");
    },
    async abort() {
      events.push("abort");
    },
  };

  await renderer.exportPngStream(writable, {
    background: null,
    maxBandBytes: 1024,
  });

  assert.equal(events.at(-1), "close");
  assert.equal(events.includes("abort"), false);
});

test("browser PNG streaming preserves write errors when abort also fails", async () => {
  const renderer = makeRenderer(makeGl());
  let aborted = false;
  const writable = {
    async write() {
      throw new Error("write failed");
    },
    async abort() {
      aborted = true;
      throw new Error("abort failed");
    },
  };

  await assert.rejects(
    renderer.exportPngStream(writable, { background: null, maxBandBytes: 1024 }),
    /write failed/,
  );
  assert.equal(aborted, true);
});

test("browser PNG streaming aborts the destination after compression fails", async () => {
  const OriginalCompressionStream = globalThis.CompressionStream;
  let rejectRead;
  globalThis.CompressionStream = class {
    readable = {
      getReader: () => ({
        read: () =>
          new Promise((_resolve, reject) => {
            rejectRead = reject;
          }),
        cancel: async (error) => rejectRead?.(error),
        releaseLock() {},
      }),
    };

    writable = {
      getWriter: () => ({
        async write() {
          throw new Error("compression failed");
        },
        async abort(error) {
          rejectRead?.(error);
        },
        releaseLock() {},
      }),
    };
  };

  try {
    const renderer = makeRenderer(makeGl());
    let abortError = null;
    const writable = {
      async write() {},
      async abort(error) {
        abortError = error;
      },
    };

    await assert.rejects(
      renderer.exportPngStream(writable, { background: null, maxBandBytes: 1024 }),
      /compression failed/,
    );
    assert.match(abortError.message, /compression failed/);
  } finally {
    globalThis.CompressionStream = OriginalCompressionStream;
  }
});

function makeRenderer(gl) {
  const canvas = {
    width: 1,
    height: 1,
    getContext() {
      return gl;
    },
  };
  const renderer = new GerberRenderer(canvas, { releaseContext: false }, {});
  renderer.gl = gl;
  renderer.lastFrame = { background: null };
  return renderer;
}

function makeGl({ readError = null } = {}) {
  return {
    FRAMEBUFFER: 0x8d40,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    bindFramebuffer() {},
    finish() {},
    readPixels(_x, _y, _width, _height, _format, _type, pixels) {
      if (readError) throw readError;
      pixels.fill(255);
    },
  };
}
