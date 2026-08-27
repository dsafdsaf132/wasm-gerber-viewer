import assert from "node:assert/strict";
import test from "node:test";

import { GerberRenderer } from "../index.js";

test("browser export requires a successfully completed inactive frame", async () => {
  const gl = makeGl();
  const canvas = {
    width: 1,
    height: 1,
    getContext() {
      return gl;
    },
    async convertToBlob() {
      return new Blob(["browser-state-machine"], { type: "image/png" });
    },
  };
  let clearCount = 0;
  let freeCount = 0;
  class Processor {
    init() {}
    clear() {
      clearCount += 1;
    }
    free() {
      freeCount += 1;
    }
  }
  const renderer = new GerberRenderer(
    canvas,
    { releaseContext: false },
    { GerberProcessor: Processor },
  );

  await assert.rejects(
    renderer.exportPng(),
    /No successfully completed browser frame/,
  );
  await assert.rejects(
    renderer.withFrame({ width: 2, height: 2 }, async () => {
      await assert.rejects(
        renderer.exportPng(),
        /render frame is active/,
      );
      await assert.rejects(
        renderer.exportPngStream({}),
        /render frame is active/,
      );
      throw new Error("forced browser frame callback failure");
    }),
    /forced browser frame callback failure/,
  );
  assert.equal(canvas.width, 2);
  assert.equal(canvas.height, 2);
  await assert.rejects(
    renderer.exportPng(),
    /No successfully completed browser frame/,
  );
  assert.equal(renderer.frame, null);
  assert.equal(clearCount, 1);
  assert.equal(freeCount, 1);

  await renderer.withFrame({ width: 3, height: 3 }, async () => {});
  assert.equal(renderer.frame, null);
  assert.equal((await renderer.exportPng()).type, "image/png");
  assert.equal(renderer.activeExport, false);
  assert.equal(clearCount, 2);
  assert.equal(freeCount, 2);

  renderer.dispose();
  await assert.rejects(renderer.withFrame({}, async () => {}), /disposed/);
  await assert.rejects(renderer.exportPng(), /disposed/);
});

test("browser dispose cannot invalidate an active frame", async () => {
  const gl = makeGl();
  const canvas = {
    width: 1,
    height: 1,
    getContext() {
      return gl;
    },
  };
  class Processor {
    init() {}
    clear() {}
    free() {}
  }
  const renderer = new GerberRenderer(
    canvas,
    { releaseContext: false },
    { GerberProcessor: Processor },
  );
  let releaseFrame;
  let signalFrame;
  const frameGate = new Promise((resolve) => {
    releaseFrame = resolve;
  });
  const frameStarted = new Promise((resolve) => {
    signalFrame = resolve;
  });
  const frame = renderer.withFrame({}, async () => {
    assert.throws(() => renderer.dispose(), /render frame is active/);
    signalFrame();
    await frameGate;
  });
  await frameStarted;
  assert.throws(() => renderer.dispose(), /render frame is active/);
  releaseFrame();
  await frame;
  assert.doesNotThrow(() => renderer.dispose());
});

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

test("browser Blob and stream exports share modern CSS validation", async () => {
  const OriginalOffscreenCanvas = globalThis.OffscreenCanvas;
  const filledColors = [];
  class CssOffscreenCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }

    getContext(kind) {
      if (kind !== "2d") return null;
      let fillStyle = "#000000";
      return {
        get fillStyle() {
          return fillStyle;
        },
        set fillStyle(value) {
          const normalized = new Map([
            ["hsl(120 100% 50%)", "rgb(0, 255, 0)"],
            ["rgb(0, 255, 0)", "rgb(0, 255, 0)"],
            [
              "color(display-p3 0 1 0 / 50%)",
              "color(display-p3 0 1 0 / 50%)",
            ],
          ]).get(value);
          if (normalized) {
            fillStyle = normalized;
          } else if (/^#[0-9a-f]{6}$/i.test(value)) {
            fillStyle = value.toLowerCase();
          }
        },
        fillRect() {
          filledColors.push(fillStyle);
        },
        clearRect() {},
        getImageData() {
          return {
            data:
              fillStyle === "color(display-p3 0 1 0 / 50%)"
                ? new Uint8ClampedArray([0, 255, 0, 128])
                : new Uint8ClampedArray([0, 0, 0, 255]),
          };
        },
        drawImage() {},
      };
    }

    async convertToBlob() {
      return new Blob(["png"], { type: "image/png" });
    }
  }
  globalThis.OffscreenCanvas = CssOffscreenCanvas;

  const renderer = makeRenderer(makeGl());
  try {
    const blob = await renderer.exportPng({
      background: "hsl(120 100% 50%)",
    });
    assert.equal(blob.type, "image/png");
    assert.equal(filledColors.at(-1), "rgb(0, 255, 0)");

    const modernEvents = [];
    await renderer.exportPngStream(
      {
        async write() {
          modernEvents.push("write");
        },
        async close() {
          modernEvents.push("close");
        },
        async abort() {
          modernEvents.push("abort");
        },
      },
      { background: "color(display-p3 0 1 0 / 50%)" },
    );
    assert.equal(modernEvents.at(-1), "close");
    assert.equal(modernEvents.includes("abort"), false);

    await assert.rejects(
      renderer.exportPng({ background: "not-a-css-color" }),
      /Unsupported color format/,
    );
    assert.equal(renderer.activeExport, false);

    const events = [];
    await assert.rejects(
      renderer.exportPngStream(
        {
          async write() {
            events.push("write");
          },
          async abort(error) {
            events.push(["abort", error]);
          },
        },
        { background: "not-a-css-color" },
      ),
      /Unsupported color format/,
    );
    assert.equal(events.some((event) => event === "write"), false);
    assert.equal(events.filter(Array.isArray).length, 1);
    assert.equal(renderer.activeExport, false);
  } finally {
    renderer.dispose();
    if (OriginalOffscreenCanvas === undefined) {
      delete globalThis.OffscreenCanvas;
    } else {
      globalThis.OffscreenCanvas = OriginalOffscreenCanvas;
    }
  }
});

test("browser PNG streaming enforces the combined one-row budget before writes", async () => {
  for (const background of [null, "#ffffff"]) {
    const channels = background == null ? 4 : 3;
    const exactBudget = 4 + 1 + channels;
    const success = makeRenderer(makeGl());
    await success.exportPngStream(
      {
        async write() {},
        async close() {},
        async abort() {},
      },
      { background, maxBandBytes: exactBudget },
    );
    success.dispose();

    const events = [];
    const rejected = makeRenderer(makeGl());
    await assert.rejects(
      rejected.exportPngStream(
        {
          async write() {
            events.push("write");
          },
          async close() {
            events.push("close");
          },
          async abort(error) {
            events.push(["abort", error]);
          },
        },
        { background, maxBandBytes: exactBudget - 1 },
      ),
      /stream band limit at 1px wide/,
    );
    assert.equal(events.some((event) => event === "write"), false);
    assert.equal(events.some((event) => event === "close"), false);
    assert.equal(events.filter(Array.isArray).length, 1);
    assert.equal(rejected.activeExport, false);
    rejected.dispose();
  }
});

test("browser PNG streaming does not copy the converted full band", async () => {
  const renderer = makeRenderer(makeGl());
  const originalSlice = Uint8Array.prototype.slice;
  let fullBandSliceCount = 0;
  Uint8Array.prototype.slice = function trackFullBandSlice(...args) {
    if (this.byteLength === 5 && this[0] === 0) {
      fullBandSliceCount += 1;
    }
    return originalSlice.apply(this, args);
  };

  try {
    await renderer.exportPngStream(
      {
        async write() {},
        async close() {},
        async abort() {},
      },
      {
        background: null,
        // One RGBA readback row plus one five-byte encoded PNG row.
        maxBandBytes: 9,
      },
    );
    assert.equal(fullBandSliceCount, 0);
  } finally {
    Uint8Array.prototype.slice = originalSlice;
    renderer.dispose();
  }
});

test("browser PNG streaming rejects invalid dimensions before writes", async () => {
  for (const [width, height, message] of [
    [0x01000001, 1, /PNG dimensions must be safe integers/],
    [100_000_000, 100_000_000, /PNG dimensions must be safe integers/],
  ]) {
    const renderer = makeRenderer(makeGl());
    renderer.canvas.width = width;
    renderer.canvas.height = height;
    const events = [];
    await assert.rejects(
      renderer.exportPngStream({
        async write() {
          events.push("write");
        },
        async abort(error) {
          events.push(["abort", error]);
        },
      }),
      message,
    );
    assert.equal(events.some((event) => event === "write"), false);
    assert.equal(events.filter(Array.isArray).length, 1);
    assert.equal(renderer.activeExport, false);
    renderer.dispose();
  }
});

test("browser PNG streaming initializes compression before destination bytes", async () => {
  const OriginalCompressionStream = globalThis.CompressionStream;
  const renderer = makeRenderer(makeGl());
  let constructorCount = 0;
  let writeCount = 0;
  let abortCount = 0;
  globalThis.CompressionStream = class {
    constructor(format) {
      constructorCount += 1;
      assert.equal(format, "deflate");
      throw new Error("deflate compression is unavailable");
    }
  };

  try {
    await assert.rejects(
      renderer.exportPngStream({
        async write() {
          writeCount += 1;
        },
        async abort(error) {
          abortCount += 1;
          assert.match(error.message, /deflate compression is unavailable/);
        },
      }),
      /deflate compression is unavailable/,
    );
    assert.equal(constructorCount, 1);
    assert.equal(writeCount, 0);
    assert.equal(abortCount, 1);
    assert.equal(renderer.activeExport, false);
  } finally {
    globalThis.CompressionStream = OriginalCompressionStream;
  }

  const events = [];
  await renderer.exportPngStream({
    async write() {
      events.push("write");
    },
    async close() {
      events.push("close");
    },
    async abort() {
      events.push("abort");
    },
  });
  assert.equal(events.at(-1), "close");
  assert.equal(events.includes("abort"), false);
  renderer.dispose();
});

test("browser streaming export owns the canvas until success or failure", async () => {
  const renderer = makeRenderer(makeGl());
  let releaseFirstWrite;
  let signalFirstWrite;
  const firstWriteReached = new Promise((resolve) => {
    signalFirstWrite = resolve;
  });
  const firstWriteGate = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  let firstWrite = true;
  const writable = {
    async write() {
      if (!firstWrite) return;
      firstWrite = false;
      signalFirstWrite();
      await firstWriteGate;
    },
    async close() {},
    async abort() {},
  };

  const exportPromise = renderer.exportPngStream(writable, {
    background: null,
    maxBandBytes: 1024,
  });
  await firstWriteReached;
  await assert.rejects(
    renderer.withFrame({ width: 3, height: 4 }, async () => {}),
    /while an export is active/,
  );
  await assert.rejects(
    renderer.exportPngStream(writable, { background: null }),
    /export is already active/,
  );
  assert.throws(() => renderer.dispose(), /while an export is active/);
  assert.equal(renderer.canvas.width, 1);
  assert.equal(renderer.canvas.height, 1);

  releaseFirstWrite();
  await exportPromise;
  assert.equal(renderer.activeExport, false);
  assert.doesNotThrow(() => renderer.dispose());
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
  assert.equal(renderer.activeExport, false);
  assert.doesNotThrow(() => renderer.dispose());
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

test("browser PNG streaming breaks compression backpressure after an IDAT destination failure", async () => {
  const OriginalCompressionStream = globalThis.CompressionStream;
  let deliverCompressedChunk;
  let rejectBlockedCompressionWrite;
  let compressionAbortCount = 0;
  globalThis.CompressionStream = class {
    readable = {
      getReader: () => ({
        read: () =>
          new Promise((resolve) => {
            deliverCompressedChunk = resolve;
          }),
        async cancel() {},
        releaseLock() {},
      }),
    };

    writable = {
      getWriter: () => ({
        write() {
          deliverCompressedChunk({
            done: false,
            value: new Uint8Array([1, 2, 3]),
          });
          return new Promise((_resolve, reject) => {
            rejectBlockedCompressionWrite = reject;
          });
        },
        async close() {},
        async abort(error) {
          compressionAbortCount += 1;
          rejectBlockedCompressionWrite?.(error);
        },
        releaseLock() {},
      }),
    };
  };

  const renderer = makeRenderer(makeGl());
  let destinationAbortCount = 0;
  let exportPromise;
  let timeoutId;
  try {
    const writable = {
      async write(chunk) {
        const chunkType =
          chunk.length >= 8
            ? String.fromCharCode(...chunk.subarray(4, 8))
            : "";
        if (chunkType === "IDAT") {
          throw new Error("forced IDAT destination failure");
        }
      },
      async abort(error) {
        destinationAbortCount += 1;
        assert.match(error.message, /forced IDAT destination failure/);
      },
    };

    exportPromise = renderer.exportPngStream(writable, {
      background: null,
      maxBandBytes: 1024,
    });
    const outcome = await Promise.race([
      exportPromise.then(
        () => ({ status: "resolved" }),
        (error) => ({ status: "rejected", error }),
      ),
      new Promise((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ status: "timed-out" }),
          500,
        );
      }),
    ]);
    assert.equal(outcome.status, "rejected");
    assert.match(outcome.error.message, /forced IDAT destination failure/);
    assert.equal(destinationAbortCount, 1);
    assert.equal(compressionAbortCount, 1);
    assert.equal(renderer.activeExport, false);
  } finally {
    clearTimeout(timeoutId);
    // Let a buggy implementation unwind instead of leaving a pending promise
    // behind when this regression fails by timing out.
    rejectBlockedCompressionWrite?.(new Error("test cleanup"));
    try {
      await exportPromise;
    } catch (_error) {
      // The expected destination error was asserted above.
    }
    globalThis.CompressionStream = OriginalCompressionStream;
  }

  const events = [];
  await renderer.exportPngStream(
    {
      async write() {
        events.push("write");
      },
      async close() {
        events.push("close");
      },
      async abort() {
        events.push("abort");
      },
    },
    { background: null, maxBandBytes: 1024 },
  );
  assert.equal(events.at(-1), "close");
  assert.equal(events.includes("abort"), false);
  renderer.dispose();
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
    COLOR_BUFFER_BIT: 0x4000,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    bindFramebuffer() {},
    viewport() {},
    clearColor() {},
    clear() {},
    finish() {},
    readPixels(_x, _y, _width, _height, _format, _type, pixels) {
      if (readError) throw readError;
      pixels.fill(255);
    },
  };
}
