import assert from "node:assert/strict";
import test from "node:test";

import {
  collectOdbLayerSourcesFromTree as collectPackageSources,
  readTarArchive as readPackageTar,
} from "../dst/odb/index.js";
import {
  collectOdbLayerSourcesFromTree as collectViewerSources,
  readTarArchive as readViewerTar,
} from "../../../js/loading/odb/index.js";
import { buildSampleJobFiles, writeTgz } from "./helpers/odb-fixture.mjs";

test("package ODB loader stays behaviorally aligned with the viewer loader", async () => {
  const { files } = buildSampleJobFiles({
    compressTopLayer: false,
    includeDiagnosticCases: true,
  });
  const archive = writeTgz(files);
  const file = {
    name: "parity-board.tgz",
    arrayBuffer: async () => archive.buffer.slice(
      archive.byteOffset,
      archive.byteOffset + archive.byteLength,
    ),
  };

  const [packageArchive, viewerArchive] = await Promise.all([
    readPackageTar(file),
    readViewerTar(file),
  ]);
  const [packageSources, viewerSources] = await Promise.all([
    collectPackageSources(packageArchive.tree, file.name),
    collectViewerSources(viewerArchive.tree, file.name),
  ]);
  const packageLayers = await Promise.all(
    packageSources.map(async (source) => ({
      name: source.name,
      kind: source.kind,
      source: await source.readText(),
    })),
  );
  const viewerLayers = await Promise.all(
    viewerSources.map(async (source) => ({
      name: source.name,
      kind: source.kind,
      source: await source.readText(),
    })),
  );

  assert.deepEqual(packageLayers, viewerLayers);
});
