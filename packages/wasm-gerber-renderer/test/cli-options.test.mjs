import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../bin/wasm-gerber-renderer.js", import.meta.url));

test("CLI help lists Node PNG memory and strategy options", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "--help",
  ]);

  assert.match(stdout, /--max-band-bytes <size>/);
  assert.match(stdout, /--max-full-frame-bytes <size>/);
  assert.match(stdout, /--framebuffer-memory-safety-factor <n>/);
  assert.match(stdout, /--render-strategy <strategy>/);
});

test("CLI validates render strategy before rendering", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      "--render-strategy",
      "invalid",
      "board.gbr",
    ]),
    /--render-strategy must be auto, full-frame, or stream\./,
  );
});
