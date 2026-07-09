import assert from "node:assert/strict";
import test from "node:test";

import { GerberViewer } from "../../../js/core/viewer.js";

test("viewer upload cleanup runs when source collection fails", async () => {
  const calls = [];
  const context = {
    fileInput: { value: "selected" },
    isRendererBusy: () => false,
    setWorkspaceStatus: () => {},
    showFileSizeWarning: () => {},
    showLoadingModal: () => calls.push("show"),
    hideLoadingModal: () => calls.push("hide"),
    updateUiState: () => calls.push("update"),
    async collectLayerSources() {
      throw new Error("collection failed");
    },
  };

  await assert.rejects(
    GerberViewer.prototype.handleFileUpload.call(context, [
      { name: "board.gbr", size: 1 },
    ]),
    /collection failed/,
  );

  assert.deepEqual(calls, ["show", "hide", "update"]);
  assert.equal(context.fileInput.value, "");
});

test("viewer upload event boundary reports rejected promises", async () => {
  let reported = null;
  const context = {
    async handleFileUpload() {
      throw new Error("upload failed");
    },
    handleLayerLoadError(name, error) {
      reported = { name, error };
    },
  };

  GerberViewer.prototype.startFileUpload.call(context, []);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(reported.name, "File upload");
  assert.match(reported.error.message, /upload failed/);
});
