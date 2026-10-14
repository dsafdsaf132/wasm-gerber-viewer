import assert from "node:assert/strict";
import test from "node:test";

import { formatFileSize } from "../js/loading/file-utils.js";

test("formatFileSize reports GB, TB, and PB with their unit", () => {
  assert.equal(formatFileSize(0), "0 Bytes");
  assert.equal(formatFileSize(1536), "1.5 KB");
  assert.equal(formatFileSize(5 * 1024 ** 3), "5 GB");
  assert.equal(formatFileSize(2 * 1024 ** 4), "2 TB");
  assert.equal(formatFileSize(1024 ** 5), "1 PB");
});

test("formatFileSize clamps sizes beyond PB instead of printing an undefined unit", () => {
  assert.equal(formatFileSize(1024 ** 6), "1024 PB");
});
