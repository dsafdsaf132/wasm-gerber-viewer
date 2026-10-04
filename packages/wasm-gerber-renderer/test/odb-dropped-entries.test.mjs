import assert from "node:assert/strict";
import test from "node:test";

import {
  collectDroppedEntries,
  getDroppedEntries,
} from "../../../js/loading/dropped-entries.js";

function fileEntry(name, content) {
  const blob = new Blob([content]);
  const file = { name, size: blob.size, text: () => blob.text() };
  return { isFile: true, isDirectory: false, name, file: (resolve) => resolve(file) };
}

function directoryEntry(name, children, { batchSize = 2 } = {}) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let cursor = 0;
      return {
        readEntries(resolve) {
          const batch = children.slice(cursor, cursor + batchSize);
          cursor += batch.length;
          resolve(batch);
        },
      };
    },
  };
}

test("collectDroppedEntries flattens folders into relative-path wrappers", async () => {
  const job = directoryEntry("job", [
    directoryEntry("matrix", [fileEntry("matrix", "STEP {\nNAME=pcb\n}\n")]),
    directoryEntry("steps", [
      directoryEntry("pcb", [
        fileEntry("profile", "S P 0\n"),
        directoryEntry("layers", [directoryEntry("top", [fileEntry("features", "UNITS=MM\n")])]),
      ]),
    ]),
    fileEntry("readme.txt", "hi"),
  ]);

  const items = await collectDroppedEntries([job, fileEntry("loose.gbr", "%MOMM*%")]);
  assert.deepEqual(
    items.map((item) => item.relativePath),
    [
      "job/matrix/matrix",
      "job/steps/pcb/profile",
      "job/steps/pcb/layers/top/features",
      "job/readme.txt",
      "loose.gbr",
    ],
  );
  assert.equal(items[0].name, "matrix");
  assert.equal(items[0].size, 18);
  assert.equal(typeof items[0].file.text, "function");
});

test("collectDroppedEntries enforces entry and depth limits", async () => {
  const many = directoryEntry(
    "big",
    Array.from({ length: 5 }, (_, index) => fileEntry(`f${index}`, "x")),
  );
  await assert.rejects(collectDroppedEntries([many], { maxEntries: 3 }), /more than 3 files/);

  let deep = fileEntry("leaf", "x");
  for (let level = 0; level < 5; level++) deep = directoryEntry(`d${level}`, [deep]);
  await assert.rejects(collectDroppedEntries([deep], { maxDepth: 3 }), /deeper than 3 levels/);
});

test("getDroppedEntries resolves entries synchronously and tolerates missing APIs", () => {
  const entry = { isDirectory: true };
  const dataTransfer = {
    items: [{ webkitGetAsEntry: () => entry }, { kind: "string" }],
  };
  assert.deepEqual(getDroppedEntries(dataTransfer), [entry, null]);
  assert.deepEqual(getDroppedEntries(null), []);
});
