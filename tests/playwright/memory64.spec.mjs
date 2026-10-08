import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

// The viewer mixes two builds of the WASM package: wasm/pkg (wasm32) and
// wasm/pkg64 (memory64). These specs need both; build the second one with
// scripts/build-wasm64.sh.

const demoFile = (name) => fileURLToPath(new URL(`../../demo/${name}`, import.meta.url));
const demoFiles = [
  demoFile("gerber-feature-test.gbr"),
  demoFile("performance-test-region-72K.gbr"),
  demoFile("performance-test-stars-10K.gbr"),
];
const GIB = 2 ** 30;
const WASM32_BINARY = "/wasm/pkg/wasm_gerber_processor_bg.wasm";
const WASM64_BINARY = "/wasm/pkg64/wasm_gerber_processor_bg.wasm";
const WASM32_GLUE = "**/wasm/pkg/wasm_gerber_processor.js";

// One 8 mm pad in the middle of a 40 x 30 mm outline, so the centre of the
// fitted view is always on the pad.
const padSource = (marker = "") => `%FSLAX24Y24*%
%MOMM*%
G04 ${marker}*
%ADD10C,8.000*%
%ADD11C,0.200*%
D11*
X-200000Y-150000D02*
X200000D01*
Y150000D01*
X-200000D01*
Y-150000D01*
D10*
X000000Y000000D03*
M02*`;

// About 22,000 small pads on the same board that leave its middle free: enough
// picking data that it cannot hide in the gaps of a nearly empty heap.
function padGridSource(columns = 180, rows = 130) {
  const lines = ["%FSLAX24Y24*%", "%MOMM*%", "%ADD12C,0.100*%", "D12*"];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = -18 + (36 * column) / (columns - 1);
      const y = -13 + (26 * row) / (rows - 1);
      if (Math.abs(x) < 6 && Math.abs(y) < 6) continue;
      lines.push(`X${Math.round(x * 10000)}Y${Math.round(y * 10000)}D03*`);
    }
  }
  lines.push("M02*");
  return lines.join("\n");
}

const gerber = (name, source) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(source),
});

function watchPage(page) {
  const watched = { errors: [], binaries: [] };
  page.on("pageerror", (error) => watched.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") watched.errors.push(message.text());
  });
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.endsWith("_bg.wasm")) watched.binaries.push(pathname);
  });
  return watched;
}

// The viewer listens for files once its main WASM instance is up, which it
// marks on <html>; files chosen before that are ignored.
async function uploadFiles(page, files) {
  await expect(page.locator("html")).toHaveAttribute("data-wasm-main", /^wasm/);
  await page.locator("#file-input").setInputFiles(files);
}

async function loadFiles(page, files, layerCount = files.length) {
  await uploadFiles(page, files);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".gerber-layer-item, .drill-layer-item")).toHaveCount(layerCount);
}

async function batchWorkerCount(page, layerCount) {
  if (layerCount <= 1) return 0;
  return page.evaluate((count) => {
    const cores = Number(navigator.hardwareConcurrency);
    const available = Number.isFinite(cores) ? Math.max(1, cores - 1) : 2;
    return Math.min(count, available, 4);
  }, layerCount);
}

async function layerSummary(page) {
  const texts = await page.locator(".gerber-layer-item, .drill-layer-item").allInnerTexts();
  return texts.map((text) => text.replace(/\s+/g, " ").trim());
}

async function canvasPixels(page) {
  // Two frames so the fitted view has been drawn before the capture.
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.locator("#gerber-canvas").screenshot();
}

async function expectBuilds(page, main, worker) {
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-wasm-main", main);
  await expect(root).toHaveAttribute("data-wasm-worker", worker);
}

async function diagnosticsText(page) {
  await page.locator('[data-panel-tab="diagnostics"]').click();
  return page.locator("#diagnostic-list").innerText();
}

// Hides memory64 from the page the way a browser without it would: the
// viewer's feature probe is the only module it validates.
async function hideMemory64(page) {
  await page.addInitScript(() => {
    WebAssembly.validate = () => false;
  });
}

async function loadAndCapture(page, query, files = demoFiles) {
  const watched = watchPage(page);
  await page.goto(`/${query}`);
  await loadFiles(page, files);
  return {
    watched,
    layers: await layerSummary(page),
    pixels: await canvasPixels(page),
  };
}

test("a memory64 browser runs the main instance on memory64 and parses in wasm32 workers", async ({ page }) => {
  const { watched } = await loadAndCapture(page, "");
  await expectBuilds(page, "wasm64", "wasm32");

  // The main instance is the first to load its binary; every worker after it
  // loads the wasm32 one.
  expect(watched.binaries[0]).toBe(WASM64_BINARY);
  expect(watched.binaries.length).toBeGreaterThan(1);
  expect(watched.binaries.slice(1).every((path) => path === WASM32_BINARY)).toBe(true);
  expect(await page.evaluate(async () => {
    const main = await import("/wasm/pkg64/wasm_gerber_processor.js");
    return main.memory_address_bits();
  })).toBe(64);
  expect(watched.errors).toEqual([]);
});

test("?wasm=32 and ?wasm=64 pin every instance to one build", async ({ browser }) => {
  for (const [query, variant, binary] of [
    ["?wasm=32", "wasm32", WASM32_BINARY],
    ["?wasm=64", "wasm64", WASM64_BINARY],
  ]) {
    const page = await browser.newPage();
    const { watched } = await loadAndCapture(page, query);
    await expectBuilds(page, variant, variant);
    expect(watched.binaries.length).toBeGreaterThan(1);
    expect(watched.binaries.every((path) => path === binary)).toBe(true);
    expect(watched.errors).toEqual([]);
    await page.close();
  }
});

test("wasm32, memory64 and the mixed setup draw the same pixels", async ({ browser }) => {
  const captures = [];
  for (const query of ["?wasm=32", "?wasm=64", ""]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const capture = await loadAndCapture(page, query);
    expect(capture.watched.errors).toEqual([]);
    captures.push(capture);
    await page.close();
  }
  const [wasm32, wasm64, mixed] = captures;
  expect(wasm64.layers).toEqual(wasm32.layers);
  expect(mixed.layers).toEqual(wasm32.layers);
  expect(wasm64.pixels.equals(wasm32.pixels)).toBe(true);
  expect(mixed.pixels.equals(wasm32.pixels)).toBe(true);
});

test("single-file and mixed Gerber/drill uploads use the selected parsing builds", async ({ browser }) => {
  for (const files of [
    [demoFile("performance-test-stars-10K.gbr")],
    [demoFile("gerber-feature-test.gbr"), demoFile("smoke-test.drl")],
  ]) {
    const mixedPage = await browser.newPage();
    const mixed = await loadAndCapture(mixedPage, "", files);
    await expectBuilds(mixedPage, "wasm64", "wasm32");
    // The mixed setup also uses one worker for a single file. Larger batches,
    // including drill layers, use a pool sized for the available CPU cores.
    const mixedWorkers = Math.max(1, await batchWorkerCount(mixedPage, files.length));
    expect(mixed.watched.binaries).toEqual([
      WASM64_BINARY,
      ...Array(mixedWorkers).fill(WASM32_BINARY),
    ]);
    expect(mixed.watched.errors).toEqual([]);

    const wasm32Page = await browser.newPage();
    const wasm32 = await loadAndCapture(wasm32Page, "?wasm=32", files);
    // Pinned wasm32 parses a single file on the main instance, while mixed
    // Gerber/drill batches use the same parallel pool as other batches.
    const wasm32Workers = await batchWorkerCount(wasm32Page, files.length);
    expect(wasm32.watched.binaries).toEqual(
      Array(1 + wasm32Workers).fill(WASM32_BINARY),
    );
    expect(mixed.layers).toEqual(wasm32.layers);
    expect(mixed.pixels.equals(wasm32.pixels)).toBe(true);
    await mixedPage.close();
    await wasm32Page.close();
  }
});

test("a browser without memory64 runs wasm32 only and never requests the memory64 package", async ({ browser }) => {
  const reference = await browser.newPage();
  const wasm32 = await loadAndCapture(reference, "?wasm=32");

  const page = await browser.newPage();
  await hideMemory64(page);
  const fallback = await loadAndCapture(page, "");
  await expectBuilds(page, "wasm32", "wasm32");
  expect(fallback.watched.binaries.every((path) => path === WASM32_BINARY)).toBe(true);
  expect(fallback.watched.binaries).toEqual(wasm32.watched.binaries);
  expect(fallback.layers).toEqual(wasm32.layers);
  expect(fallback.pixels.equals(wasm32.pixels)).toBe(true);
  expect(fallback.watched.errors).toEqual([]);
  await expect(page.locator("#diagnostics-count")).toHaveText("0");
});

test("?wasm=64 without memory64 falls back to wasm32 and says so", async ({ page }) => {
  await hideMemory64(page);
  const { watched } = await loadAndCapture(page, "?wasm=64");
  await expectBuilds(page, "wasm32", "wasm32");
  expect(watched.binaries.every((path) => path === WASM32_BINARY)).toBe(true);
  expect(await diagnosticsText(page)).toContain("memory64 unavailable");
});

test("a deployment without wasm/pkg64 falls back to wasm32", async ({ page }) => {
  await page.route("**/wasm/pkg64/**", (route) => route.fulfill({ status: 404, body: "Not found" }));
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expectBuilds(page, "wasm32", "wasm32");
  await loadFiles(page, demoFiles);
  expect(pageErrors).toEqual([]);
  await expect(page.locator("#diagnostics-count")).toHaveText("0");
});

test("the memory64 main instance picks features stored above 4 GiB", async ({ page }) => {
  test.setTimeout(180_000);
  const watched = watchPage(page);
  await page.goto("/");
  await expectBuilds(page, "wasm64", "wasm32");

  // Pin 4.25 GiB of the main heap. The block is never freed, so the picking
  // data built afterwards can only live above the 32-bit address range.
  const pinned = await page.evaluate(async (bytes) => {
    const main = await import("/wasm/pkg64/wasm_gerber_processor.js");
    const wasm = await main.default();
    try {
      const pointer = wasm.__wbindgen_malloc(bytes, 1);
      return { pointer, memoryBytes: wasm.memory.buffer.byteLength };
    } catch (error) {
      return { error: String(error) };
    }
  }, 4.25 * GIB);
  // The allocator traps when the browser cannot grow the heap, which here
  // means the machine had no 4.25 GiB to spare (for instance while other
  // tests ran alongside), not that the viewer failed.
  test.skip(Boolean(pinned.error), `could not pin 4.25 GiB: ${pinned.error}`);
  expect(pinned.pointer).toBeGreaterThan(0);
  expect(pinned.memoryBytes).toBeGreaterThan(4.25 * GIB);

  await loadFiles(page, [
    gerber("grid.gbl", padGridSource()),
    gerber("pad.gtl", padSource()),
  ]);
  const afterLoad = await page.evaluate(async () => {
    const main = await import("/wasm/pkg64/wasm_gerber_processor.js");
    return (await main.default()).memory.buffer.byteLength;
  });
  // The picking index did not fit below the pinned block.
  expect(afterLoad).toBeGreaterThan(pinned.memoryBytes);

  const box = await page.locator("#gerber-canvas").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("#bounds-readout")).toContainText("pad.gtl");
  await expect(page.locator("#bounds-readout")).toContainText("D10");
  expect(watched.errors).toEqual([]);
  await expect(page.locator("#diagnostics-count")).toHaveText("0");
});

test("the wasm32 main instance still refuses layers once its memory is nearly full", async ({ page }) => {
  await page.goto("/?wasm=32");
  await expectBuilds(page, "wasm32", "wasm32");
  await page.evaluate(async () => {
    const main = await import("/wasm/pkg/wasm_gerber_processor.js");
    const { memory } = await main.default();
    const targetPages = (3600 * 2 ** 20) / 65536;
    memory.grow(targetPages - memory.buffer.byteLength / 65536);
  });
  await uploadFiles(page, [
    gerber("first.gtl", padSource()),
    gerber("second.gbl", padSource()),
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(0);
  // This browser has memory64; only the address keeps it off.
  await expectNotice(page, "More than 4 GiB needed", [
    "needs more than 4 GiB of memory, but ?wasm=32 in the address",
    "Remove it to use memory64.",
  ]);
  expect(await diagnosticsText(page)).toContain("WASM memory limit reached");
});

const notice = (page) => page.locator("#file-size-warning");

async function expectNotice(page, title, texts) {
  await expect(notice(page)).toBeVisible();
  await expect(page.locator("#warning-title")).toHaveText(title);
  for (const text of texts) {
    await expect(page.locator("#warning-message")).toContainText(text);
  }
}

const SUPPORTED_BROWSER_LIST = [
  "Chrome 133 or later",
  "Edge 133 or later",
  "Firefox 134 or later",
  "Safari does not support it yet.",
];

test("a browser without memory64 lists the supported browsers when a layer needs more than 4 GiB", async ({ page }) => {
  await hideMemory64(page);
  await failWasm32Parser(page);
  await page.goto("/");
  await expectBuilds(page, "wasm32", "wasm32");
  await uploadFiles(page, [
    gerber("exhausted.gtl", padSource("WASM32-OUT-OF-MEMORY")),
    gerber("pad.gbl", padSource()),
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(1);
  await expectNotice(page, "Unsupported browser", [
    "exhausted.gtl needs more than the 4 GiB of memory this browser gives WebAssembly",
    ...SUPPORTED_BROWSER_LIST,
  ]);
  await expect(page.locator("#warning-message li")).toHaveText([
    "Chrome 133 or later",
    "Edge 133 or later",
    "Firefox 134 or later",
  ]);
  expect(await diagnosticsText(page)).toContain("not enough memory");
});

test("the notice also covers a single file parsed on the main instance", async ({ page }) => {
  await hideMemory64(page);
  await failWasm32Parser(page);
  const watched = watchPage(page);
  await page.goto("/");
  await uploadFiles(page, gerber("exhausted.gtl", padSource("WASM32-OUT-OF-MEMORY")));
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  // No worker: wasm32 parses a single file on the main instance.
  expect(watched.binaries).toEqual([WASM32_BINARY]);
  await expectNotice(page, "Unsupported browser", [
    "exhausted.gtl needs more than the 4 GiB",
    ...SUPPORTED_BROWSER_LIST,
  ]);
});

test("a trap counts as running out of memory only once the instance is large", async ({ page }) => {
  await hideMemory64(page);
  await failWasm32Parser(page);
  await page.goto("/");
  await uploadFiles(page, [
    gerber("grown.gtl", padSource("WASM32-TRAP-LARGE")),
    gerber("pad.gbl", padSource()),
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expectNotice(page, "Unsupported browser", ["grown.gtl needs more than the 4 GiB"]);

  // The same trap in a worker that is still small reads as a bug.
  await page.goto("/");
  await uploadFiles(page, [
    gerber("trapped.gtl", padSource("WASM32-TRAP")),
    gerber("pad.gbl", padSource()),
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  // Every notification is also logged, so the log shows which one appeared.
  const diagnostics = await diagnosticsText(page);
  expect(diagnostics).toContain("Failed to load file trapped.gtl: unreachable");
  expect(diagnostics).not.toContain("Unsupported browser");
});

test("a browser without memory64 shows the notice when the main instance is full", async ({ page }) => {
  await hideMemory64(page);
  await page.goto("/");
  await expectBuilds(page, "wasm32", "wasm32");
  await page.evaluate(async () => {
    const main = await import("/wasm/pkg/wasm_gerber_processor.js");
    const { memory } = await main.default();
    const targetPages = (3600 * 2 ** 20) / 65536;
    memory.grow(targetPages - memory.buffer.byteLength / 65536);
  });
  await uploadFiles(page, [
    gerber("first.gtl", padSource()),
    gerber("second.gbl", padSource()),
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(0);
  await expectNotice(page, "Unsupported browser", SUPPORTED_BROWSER_LIST);
});

test("a missing memory64 build asks for a reload instead of another browser", async ({ page }) => {
  await page.route("**/wasm/pkg64/**", (route) => route.fulfill({ status: 404, body: "Not found" }));
  await failWasm32Parser(page);
  await page.goto("/");
  await expectBuilds(page, "wasm32", "wasm32");
  await uploadFiles(page, [
    gerber("exhausted.gtl", padSource("WASM32-OUT-OF-MEMORY")),
    gerber("pad.gbl", padSource()),
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expectNotice(page, "More than 4 GiB needed", [
    "the memory64 build could not be loaded. Reload the page to try again.",
  ]);
  await expect(page.locator("#warning-message li")).toHaveCount(0);
});

const LOAD_MARKER_KEY = "gerber-viewer:load-in-progress";
const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

// Serves `source` at a fixed address and returns the viewer URL that opens it.
async function remoteSource(page, name, source) {
  const base = test.info().project.use.baseURL;
  await page.route(`**/remote-samples/${name}`, (route) =>
    route.fulfill({ contentType: "text/plain", body: source }));
  const fileUrl = `${base}/remote-samples/${name}`;
  return { fileUrl, viewerUrl: `/?url=${encodeURIComponent(fileUrl)}` };
}

// What a crashed load leaves behind, written before the viewer starts.
async function seedInterruptedLoad(page, marker) {
  await page.addInitScript(
    ({ key, marker }) => {
      if (sessionStorage.getItem("seeded-interrupted-load")) return;
      sessionStorage.setItem("seeded-interrupted-load", "1");
      sessionStorage.setItem(key, JSON.stringify({ ...marker, startedAt: Date.now() }));
    },
    { key: LOAD_MARKER_KEY, marker },
  );
}

test("a load the browser killed is not repeated, and the reopened page says why", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await hideMemory64(page);
  await failWasm32Parser(page);
  const { viewerUrl } = await remoteSource(page, "dense.gbr", padSource("WASM32-HANG"));
  // Playwright actions snapshot the page for traces, which a stuck page never
  // answers, so the stuck page is only driven through the protocol.
  const pageCdp = await page.context().newCDPSession(page);
  const fetched = page.waitForRequest("**/remote-samples/dense.gbr");
  await page.goto(viewerUrl);
  await fetched;
  // The parse now holds the page's main thread. Move the tab to another site
  // and end the stuck process from outside, the way a browser ends a tab that
  // ran out of memory: the page never gets to run its pagehide handler.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await sleep(1_000);
  // The stuck renderer is the one burning CPU right now; other renderers of
  // this shared browser are idle.
  const cdp = await browser.newBrowserCDPSession();
  const rendererCpu = async () => {
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    return new Map(
      processInfo
        .filter((process) => process.type === "renderer")
        .map((process) => [process.id, process.cpuTime]),
    );
  };
  const before = await rendererCpu();
  await sleep(1_000);
  const after = await rendererCpu();
  const [stuckId] = [...after]
    .map(([id, cpuTime]) => [id, cpuTime - (before.get(id) ?? 0)])
    .sort((left, right) => right[1] - left[1])[0];
  const otherSite = new URL(test.info().project.use.baseURL);
  otherSite.hostname = "localhost";
  const leftStuckPage = page.waitForURL(/localhost/);
  await pageCdp.send("Page.navigate", {
    url: new URL("/demo/preview.png", otherSite).href,
  });
  await leftStuckPage;
  try {
    process.kill(stuckId);
  } catch (_error) {
    // The browser already ended it.
  }

  // The tab comes back to the same address.
  const refetched = [];
  page.on("request", (request) => {
    if (request.url().includes("/remote-samples/dense.gbr")) refetched.push(request.url());
  });
  await page.goto(viewerUrl);
  await expectBuilds(page, "wasm32", "wasm32");
  await expectNotice(page, "Unsupported browser", [
    "Loading dense.gbr stopped this page before it finished",
    "needs more memory than this browser gives WebAssembly",
    ...SUPPORTED_BROWSER_LIST,
    "It was not loaded again; reload the page to try once more.",
  ]);
  await page.waitForTimeout(500);
  expect(refetched).toEqual([]);
  await expect(page.locator(".gerber-layer-item")).toHaveCount(0);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), LOAD_MARKER_KEY)).toBeNull();
});

test("after the notice a reload tries the same address again", async ({ page }) => {
  const { fileUrl, viewerUrl } = await remoteSource(page, "pad.gbr", padSource());
  await seedInterruptedLoad(page, { names: ["pad.gbr"], nameCount: 1, sourceUrl: fileUrl });
  await page.goto(viewerUrl);
  // This browser has memory64, so memory is the only suspect.
  await expectNotice(page, "Loading stopped", [
    "Loading pad.gbr stopped this page before it finished, most likely because the device ran out of memory.",
    "It was not loaded again",
  ]);
  await expect(page.locator(".gerber-layer-item")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".gerber-layer-item")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("#diagnostics-count")).toHaveText("0");
});

test("an interrupted file upload is reported without loading anything", async ({ page }) => {
  await hideMemory64(page);
  await seedInterruptedLoad(page, {
    names: ["top.gtl", "bottom.gbl", "drill.drl"],
    nameCount: 3,
    sourceUrl: null,
  });
  await page.goto("/");
  await expectNotice(page, "Unsupported browser", [
    "Loading top.gtl, bottom.gbl and 1 more file stopped this page before it finished",
    "Safari does not support it yet.",
  ]);
  await expect(page.locator("#warning-message")).not.toContainText("It was not loaded again");
});

test("on an iPhone the notice sends the user to a computer", async ({ browser }) => {
  const context = await browser.newContext({ userAgent: IPHONE_USER_AGENT });
  const page = await context.newPage();
  await hideMemory64(page);
  await seedInterruptedLoad(page, { names: ["dense.gbr"], nameCount: 1, sourceUrl: null });
  await page.goto("/");
  await expectNotice(page, "Unsupported browser", [
    "Open it on a computer, in a browser that supports WebAssembly memory64:",
    "Chrome 133 or later",
    "On iPhone and iPad every browser uses Safari's engine, which does not support it yet.",
  ]);
  await context.close();
});

test("a load that finishes or is left on purpose leaves no marker", async ({ page }) => {
  await page.goto("/");
  await loadFiles(page, [gerber("pad.gtl", padSource())]);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), LOAD_MARKER_KEY)).toBeNull();

  await page.evaluate((key) => sessionStorage.setItem(key, JSON.stringify({
    names: ["left.gbr"], nameCount: 1, sourceUrl: null, startedAt: Date.now(),
  })), LOAD_MARKER_KEY);
  // A reload is a page the user left on purpose, not a crash.
  await page.reload();
  await expect(page.locator("#workspace-status")).toHaveText("Ready");
  await expect(page.locator("#diagnostics-count")).toHaveText("0");
});

// Serves the wasm32 glue to the workers with a parser that fails the way an
// exhausted wasm32 instance does for sources carrying a marker comment.
async function failWasm32Parser(page) {
  await page.route(WASM32_GLUE, (route) => {
    if (new URL(route.request().url()).searchParams.has("real")) {
      return route.continue();
    }
    return route.fulfill({
      contentType: "text/javascript",
      body: `
        import init, * as real from "/wasm/pkg/wasm_gerber_processor.js?real";
        export * from "/wasm/pkg/wasm_gerber_processor.js?real";
        export default init;
        // Parser errors are thrown as strings, the way the module throws a
        // Rust Err; the traps below are thrown as RuntimeErrors.
        function fail(content) {
          if (content.includes("WASM32-OUT-OF-MEMORY")) {
            throw "Gerber layer is too large to parse: not enough memory for primitives (forced)";
          }
          if (content.includes("WASM32-HANG")) {
            // Stands in for a parse the browser kills the page during.
            const until = Date.now() + 120000;
            while (Date.now() < until) {}
          }
          if (content.includes("WASM32-TRAP-LARGE")) {
            // Trap only after the instance has grown the way a real
            // allocation failure leaves it.
            real.reserve_input_capacity(1.25 * 2 ** 30);
            throw new WebAssembly.RuntimeError("unreachable (forced)");
          }
          if (content.includes("WASM32-TRAP")) {
            throw new WebAssembly.RuntimeError("unreachable (forced)");
          }
          if (content.includes("WASM32-ITEM-LIMIT")) {
            throw "Gerber generated geometry exceeds the supported limit of 60000000 items while processing flash (forced)";
          }
        }
        export function parse_gerber_layer_payload_with_progress(content, ...rest) {
          fail(content);
          return real.parse_gerber_layer_payload_with_progress(content, ...rest);
        }
        export function parse_gerber_layer_payload_with_options(content, ...rest) {
          fail(content);
          return real.parse_gerber_layer_payload_with_options(content, ...rest);
        }
        export function parse_gerber_layer_with_options(content, a, b, c, d) {
          fail(content);
          return real.parse_gerber_layer_with_options(content, a, b, c, d);
        }
        export function parse_gerber_layer(content, a, b) {
          fail(content);
          return real.parse_gerber_layer(content, a, b);
        }
      `,
    });
  });
}

test("a layer the wasm32 worker runs out of memory on is parsed again by a memory64 worker", async ({ browser }) => {
  const reference = await browser.newPage();
  const files = [
    gerber("exhausted.gtl", padSource("WASM32-OUT-OF-MEMORY")),
    gerber("trapped.gbl", padSource("WASM32-TRAP")),
    gerber("over-limit.gto", padSource("WASM32-ITEM-LIMIT")),
    gerber("ordinary.gbo", padSource("ordinary")),
  ];
  const expected = await loadAndCapture(reference, "", files);
  expect(expected.watched.binaries.filter((path) => path === WASM64_BINARY)).toHaveLength(1);

  const page = await browser.newPage();
  await failWasm32Parser(page);
  const retried = await loadAndCapture(page, "", files);
  await expectBuilds(page, "wasm64", "wasm32");

  // Main instance plus one memory64 worker per failed layer; the ordinary
  // layer stayed on wasm32.
  expect(retried.watched.binaries.filter((path) => path === WASM64_BINARY)).toHaveLength(4);
  expect(retried.layers).toEqual(expected.layers);
  expect(retried.pixels.equals(expected.pixels)).toBe(true);

  const diagnostics = await diagnosticsText(page);
  for (const name of ["exhausted.gtl", "trapped.gbl", "over-limit.gto"]) {
    expect(diagnostics).toContain(name);
  }
  expect(diagnostics).not.toContain("ordinary.gbo");
  expect(diagnostics).toContain("Parsed with the memory64 build");
  await expect(page.locator("#diagnostics-count")).toHaveText("3");

  // The re-parsed layers carry picking data like any other layer.
  const box = await page.locator("#gerber-canvas").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("#bounds-readout")).toContainText("D10");
});

test("the loading modal says when memory64 parses a layer again", async ({ page }) => {
  await page.addInitScript(() => {
    window.__loadingStages = [];
    new MutationObserver(() => {
      const stage = document.getElementById("loading-stage")?.textContent;
      if (stage && window.__loadingStages.at(-1) !== stage) {
        window.__loadingStages.push(stage);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await failWasm32Parser(page);
  await loadAndCapture(page, "", [gerber("exhausted.gtl", padSource("WASM32-OUT-OF-MEMORY"))]);
  const stages = await page.evaluate(() => window.__loadingStages);
  const retry = stages.indexOf("Parsing again with memory64");
  expect(retry, stages.join(" > ")).toBeGreaterThan(stages.indexOf("Parsing"));
  expect(stages.indexOf("Rendering")).toBeGreaterThan(retry);
});

// A layer of a million flashes: its worker parse lasts a second or more and
// reports several times along the way.
function flashLayerSource(count = 1_000_000) {
  const lines = ["%FSLAX34Y34*%", "%MOMM*%", "%ADD10C,0.250*%", "D10*"];
  for (let index = 0; index < count; index += 1) {
    lines.push(`X${(index % 1000) * 3000}Y${Math.floor(index / 1000) * 3000}D03*`);
  }
  lines.push("M02*");
  return lines.join("\n");
}

test("re-parsing for a parser option shows how far the parse has got", async ({ page }) => {
  // Records what the loading modal shows each time it changes; the percentage
  // is null while the modal shows none.
  await page.addInitScript(() => {
    window.__loadingSnapshots = [];
    new MutationObserver(() => {
      const modal = document.getElementById("loading-modal");
      if (!modal || modal.hidden) return;
      const value = document.getElementById("loading-progress-value");
      const snapshot = {
        title: document.getElementById("loading-title").textContent,
        stage: document.getElementById("loading-stage").textContent,
        percent: value.hidden ? null : Number.parseInt(value.textContent, 10),
      };
      const last = window.__loadingSnapshots.at(-1);
      if (
        !last ||
        last.title !== snapshot.title ||
        last.stage !== snapshot.stage ||
        last.percent !== snapshot.percent
      ) {
        window.__loadingSnapshots.push(snapshot);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "value"],
    });
  });
  await page.goto("/");
  await loadFiles(page, [gerber("flashes.gtl", flashLayerSource())]);
  await expectBuilds(page, "wasm64", "wasm32");

  await page.evaluate(() => {
    window.__loadingSnapshots.length = 0;
  });
  await page.locator("#region-arc-approximate").evaluate((input) => {
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(1);

  const snapshots = (await page.evaluate(() => window.__loadingSnapshots)).filter(
    ({ title }) => title === "Applying options",
  );
  const parsing = snapshots.filter(({ stage }) => stage === "Parsing");
  const between = parsing.filter(({ percent }) => percent > 5 && percent < 90);
  expect(
    between.length,
    `parse progress between 5% and 90%: ${JSON.stringify(snapshots)}`,
  ).toBeGreaterThanOrEqual(3);
  for (const [index, snapshot] of parsing.entries()) {
    if (index > 0) {
      expect(snapshot.percent, JSON.stringify(parsing)).toBeGreaterThanOrEqual(
        parsing[index - 1].percent,
      );
    }
  }

  // The passes that follow the parse count the layers again, without a
  // percentage.
  const later = snapshots.filter(({ stage }) => stage !== "Parsing");
  expect(later.map(({ stage }) => stage)).toEqual(
    expect.arrayContaining(["Loading", "Building picking index"]),
  );
  for (const snapshot of later) {
    expect(snapshot.percent, JSON.stringify(snapshot)).toBeNull();
  }
});

test("the memory64 retry also covers a mixed Gerber/drill worker pool", async ({ page }) => {
  await failWasm32Parser(page);
  const { watched } = await loadAndCapture(page, "", [
    gerber("exhausted.gtl", padSource("WASM32-OUT-OF-MEMORY")),
    {
      name: "smoke-test.drl",
      mimeType: "text/plain",
      buffer: readFileSync(demoFile("smoke-test.drl")),
    },
  ]);
  const workerCount = await batchWorkerCount(page, 2);
  expect(watched.binaries[0]).toBe(WASM64_BINARY);
  // Other workers may request their binary before or after the retry starts.
  expect(watched.binaries.filter((path) => path === WASM32_BINARY)).toHaveLength(workerCount);
  expect(watched.binaries.filter((path) => path === WASM64_BINARY)).toHaveLength(2);
  expect(watched.binaries).toHaveLength(workerCount + 2);
  expect(await diagnosticsText(page)).toContain("Parsed with the memory64 build");
});

test("errors that more memory cannot fix are not retried on memory64", async ({ page }) => {
  const watched = watchPage(page);
  await page.goto("/");
  await uploadFiles(page, [
    gerber("empty.gtl", "%FSLAX24Y24*%\n%MOMM*%\nM02*"),
    gerber("pad.gbl", padSource()),
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(1);
  expect(watched.binaries.filter((path) => path === WASM64_BINARY)).toHaveLength(1);
  expect(await diagnosticsText(page)).toContain("no geometry found");
});

test("a layer that fails on both builds reports both failures", async ({ page }) => {
  await failWasm32Parser(page);
  await page.goto("/");
  await uploadFiles(page, [
    gerber("broken.gtl", "%FSLAX24Y24*%\n%MOMM*%\nG04 WASM32-OUT-OF-MEMORY*\nM02*"),
    gerber("pad.gbl", padSource()),
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(1);
  const diagnostics = await diagnosticsText(page);
  expect(diagnostics).toContain("no geometry found");
  expect(diagnostics).toContain("wasm64 retry after wasm32 failed");
  // memory64 was there and could not help, so no browser advice.
  await expect(page.locator("#warning-title")).not.toHaveText(/Unsupported browser|More than 4 GiB/);
});

// One parse worker, so every layer goes to the same worker unless the pool
// replaces it, and a record of the tasks each worker receives, counting
// those that arrive after it trapped.
async function recordParseWorkers(page) {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { get: () => 2 });
    const NativeWorker = window.Worker;
    window.__parseWorkers = [];
    window.Worker = class RecordingWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        const record = { tasks: 0, tasksAfterTrap: 0, trapped: false };
        window.__parseWorkers.push(record);
        const post = this.postMessage.bind(this);
        this.postMessage = (message, ...rest) => {
          if (typeof message?.content === "string") {
            record.tasks += 1;
            if (record.trapped) record.tasksAfterTrap += 1;
          }
          return post(message, ...rest);
        };
        this.addEventListener("message", (event) => {
          if (event.data?.ok === false && event.data.trapped) record.trapped = true;
        });
      }
    };
  });
}

const sixPads = () =>
  Array.from({ length: 6 }, (_, index) => gerber(`pad-${index}.gbl`, padSource(`pad ${index}`)));

test("a worker whose parse trapped gets no further layer, even with nothing to retry on", async ({ page }) => {
  await failWasm32Parser(page);
  await recordParseWorkers(page);
  // Pinned to wasm32, so the pool has no memory64 build to retry on.
  await page.goto("/?wasm=32");
  await uploadFiles(page, [gerber("trapped.gtl", padSource("WASM32-TRAP")), ...sixPads()]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(6);

  const workers = await page.evaluate(() => window.__parseWorkers);
  expect(workers.filter((worker) => worker.trapped)).toHaveLength(1);
  expect(workers.map((worker) => worker.tasksAfterTrap)).toEqual(workers.map(() => 0));
});

test("a parser error that returned normally keeps its worker", async ({ page }) => {
  await recordParseWorkers(page);
  await page.goto("/?wasm=32");
  await uploadFiles(page, [gerber("empty.gtl", "%FSLAX24Y24*%\n%MOMM*%\nM02*"), ...sixPads()]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(6);
  expect(await diagnosticsText(page)).toContain("no geometry found");

  // The one worker parsed all seven files.
  const workers = await page.evaluate(() => window.__parseWorkers);
  expect(workers.map((worker) => worker.tasks)).toEqual([7]);
});

test("with every instance on wasm32 a memory failure is final", async ({ page }) => {
  await failWasm32Parser(page);
  const watched = watchPage(page);
  await page.goto("/?wasm=32");
  await uploadFiles(page, [
    gerber("exhausted.gtl", padSource("WASM32-OUT-OF-MEMORY")),
    gerber("pad.gbl", padSource()),
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(1);
  expect(watched.binaries.every((path) => path === WASM32_BINARY)).toBe(true);
  await expectNotice(page, "More than 4 GiB needed", [
    "exhausted.gtl needs more than 4 GiB of memory, but ?wasm=32 in the address",
  ]);
  expect(await diagnosticsText(page)).toContain("not enough memory");
});
