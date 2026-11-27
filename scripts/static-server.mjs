import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const root = resolve(process.cwd());
const port = Number(process.env.GERBER_VIEWER_TEST_PORT ?? 4173);
const host = process.env.GERBER_VIEWER_HOST ?? "0.0.0.0";
// "32" or "64": adds ?wasm= to viewer page requests that do not choose a build
// themselves, so specs that open "/" run on one build (js/core/wasm-variant.js).
const pinnedWasmVariant = process.env.GERBER_VIEWER_TEST_WASM ?? "";
// Directory under wasm/ served in place of wasm/pkg, e.g. "pkg64" to run the
// specs that import /wasm/pkg/ in the page against the memory64 binary.
const wasmPackageDir = process.env.GERBER_VIEWER_TEST_WASM_PKG_DIR ?? "";
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tar", "application/x-tar"],
  [".tgz", "application/gzip"],
  [".gz", "application/gzip"],
  [".wasm", "application/wasm"],
  [".woff2", "font/woff2"],
]);

function resolveRequestPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  let relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  if (wasmPackageDir && relativePath.startsWith("wasm/pkg/")) {
    relativePath = `wasm/${wasmPackageDir}/${relativePath.slice("wasm/pkg/".length)}`;
  }
  const candidate = resolve(join(root, normalize(relativePath)));
  const relativeCandidate = relative(root, candidate);
  const escapesRoot =
    isAbsolute(relativeCandidate) || relativeCandidate === ".." || relativeCandidate.startsWith(`..${sep}`);
  return escapesRoot ? null : candidate;
}

function pinnedWasmVariantRedirect(requestUrl) {
  if (!pinnedWasmVariant) return null;
  const url = new URL(requestUrl, "http://localhost");
  const isViewerPage = url.pathname === "/" || url.pathname === "/index.html";
  if (!isViewerPage || url.searchParams.has("wasm")) return null;
  url.searchParams.set("wasm", pinnedWasmVariant);
  return `${url.pathname}${url.search}`;
}

const server = createServer((request, response) => {
  const redirect = pinnedWasmVariantRedirect(request.url ?? "/");
  if (redirect) {
    response.writeHead(302, { "Cache-Control": "no-store", Location: redirect }).end();
    return;
  }
  const path = resolveRequestPath(request.url ?? "/");
  if (!path) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    if (!statSync(path).isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": mimeTypes.get(extname(path).toLowerCase()) ?? "application/octet-stream",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(path).pipe(response);
  } catch (_error) {
    response.writeHead(404).end("Not found");
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Gerber viewer test server listening on http://${host}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
