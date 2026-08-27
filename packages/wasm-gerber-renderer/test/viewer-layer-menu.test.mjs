import assert from "node:assert/strict";
import test from "node:test";

import { GerberViewer } from "../../../js/core/viewer.js";
import { CompositeLayerDialog } from "../../../js/ui/composite-layer-dialog.js";

const COMPOSITE_ACTIONS = [
  "edit-composite",
  "composite-union",
  "composite-intersection",
  "composite-difference",
  "select-visible-area",
];

function createButton() {
  const attributes = new Map();
  const classes = new Set();
  return {
    hidden: false,
    disabled: false,
    title: "",
    attributes,
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
  };
}

test("layer menu offers standalone rename only for ordinary layers", () => {
  const viewer = Object.create(GerberViewer.prototype);
  const actions = ["delete-layer", "rename-layer", "invert-layer", ...COMPOSITE_ACTIONS];
  viewer.layerContextMenuButtons = new Map(
    actions.map((action) => [action, createButton()]),
  );
  viewer.canInvertLayer = () => false;

  viewer.syncLayerContextMenuState({ kind: "composite", inverted: false });
  const rename = viewer.layerContextMenuButtons.get("rename-layer");
  assert.equal(rename.hidden, true);
  assert.equal(rename.disabled, true);
  for (const action of COMPOSITE_ACTIONS) {
    const button = viewer.layerContextMenuButtons.get(action);
    assert.equal(button.hidden, false);
    assert.equal(button.disabled, false);
  }

  viewer.syncLayerContextMenuState({ kind: "gerber", inverted: false });
  assert.equal(rename.hidden, false);
  assert.equal(rename.disabled, false);
  for (const action of COMPOSITE_ACTIONS) {
    const button = viewer.layerContextMenuButtons.get(action);
    assert.equal(button.hidden, true);
    assert.equal(button.disabled, true);
  }
});

test("viewer rename uses the standalone dialog and rejects composite layers", async () => {
  const viewer = Object.create(GerberViewer.prototype);
  const drill = { kind: "drill", name: "holes.drl" };
  const composite = { kind: "composite", name: "Coverage" };
  const openedNames = [];
  let renderCount = 0;
  viewer.layers = [drill, composite];
  viewer.isRendererBusy = () => false;
  viewer.renameLayerDialog = {
    async open(name) {
      openedNames.push(name);
      return "Renamed holes";
    },
  };
  viewer.renderLayerList = () => {
    renderCount += 1;
  };
  viewer.syncBoardOutlineSelect = () => {};
  viewer.requestRender = () => {};

  await viewer.renameLayer(composite);
  assert.deepEqual(openedNames, []);
  assert.equal(composite.name, "Coverage");

  await viewer.renameLayer(drill);
  assert.deepEqual(openedNames, ["holes.drl"]);
  assert.equal(drill.name, "Renamed holes");
  assert.equal(renderCount, 1);
});

test("composite creation records retain an owned custom bitset and slot order", () => {
  const custom = new Uint8Array([0x92]);
  const layer = GerberViewer.prototype.createCompositeLayerRecord.call(
    {},
    {
      name: "Custom coverage",
      sourceIds: ["source-b", "source-a"],
      slotSourceIds: ["source-a", "source-b"],
      visibleBitset: custom,
      presetCommand: "custom",
    },
  );

  assert.deepEqual(layer.sourceIds, ["source-b", "source-a"]);
  assert.deepEqual(layer.slotSourceIds, ["source-a", "source-b"]);
  assert.equal(layer.visibleBitset, custom);
});

function createSelectionFinishContext({ createDialogState }) {
  const resumedStates = [];
  let removeCount = 0;
  const original = new Uint8Array([0]);
  const draft = new Uint8Array([0x0e]);
  const layer = {
    id: "composite-create-draft",
    layerId: 7,
    kind: "composite",
    name: "Pending coverage",
    visible: true,
    sourceIds: ["source-a", "source-b"],
    slotSourceIds: ["source-a", "source-b"],
    visibleBitset: original,
  };
  const viewer = Object.create(GerberViewer.prototype);
  viewer.compositeSelection = {
    layer,
    original,
    draft,
    hoverFrame: null,
    changedByteIndices: new Set(),
    bulkBitsetChanged: false,
    rulerWasActive: false,
    returnFocusLayerId: layer.id,
    createDialogState,
    cancelLayerState: null,
  };
  viewer.wasmProcessor = { end_composite_selection() {} };
  viewer.cancelCompositeAreaScan = () => {};
  viewer.removeCompositeRendererLayer = () => {
    removeCount += 1;
    layer.layerId = null;
    return true;
  };
  viewer.renderLayerList = () => {};
  viewer.updateUiState = () => {};
  viewer.requestRender = () => {};
  viewer.focusLayerActionButton = () => {};
  viewer.createCompositeLayer = (state) => {
    resumedStates.push(state);
  };
  return {
    viewer,
    layer,
    draft,
    resumedStates,
    get removeCount() {
      return removeCount;
    },
  };
}

test("Custom Done returns a highlighted custom draft to Create", () => {
  const createDialogState = {
    name: "Pending coverage",
    defaultName: "Composite 1",
    sourceIds: ["source-a", "source-b"],
    presetCommand: "union",
  };
  const context = createSelectionFinishContext({ createDialogState });

  context.viewer.finishCompositeSelection(true);

  assert.equal(context.removeCount, 1);
  assert.equal(context.resumedStates.length, 1);
  assert.equal(context.resumedStates[0].presetCommand, "custom");
  assert.equal(context.resumedStates[0].visibleBitset, context.draft);
  assert.equal(context.layer.visibleBitset, context.draft);
});

test("Custom Cancel returns the untouched Create dialog state", () => {
  const createDialogState = {
    name: "Pending coverage",
    defaultName: "Composite 1",
    sourceIds: ["source-a", "source-b"],
    presetCommand: "intersection",
  };
  const context = createSelectionFinishContext({ createDialogState });

  context.viewer.finishCompositeSelection(false);

  assert.equal(context.removeCount, 1);
  assert.deepEqual(context.resumedStates, [createDialogState]);
  assert.notEqual(context.layer.visibleBitset, context.draft);
});

test("existing composite cancellation restores its pre-edit definition", () => {
  const viewer = Object.create(GerberViewer.prototype);
  const previousBitset = new Uint8Array([0x06]);
  const layer = {
    kind: "composite",
    name: "Edited name",
    visible: true,
    layerId: 11,
    rendererDefinitionKey: "edited-definition",
    sourceIds: ["source-c", "source-b"],
    slotSourceIds: ["source-b", "source-c"],
    visibleBitset: new Uint8Array([0x09]),
    bounds: { minX: 5, maxX: 6, minY: 7, maxY: 8 },
    renderBounds: null,
    error: "edited error",
  };
  const state = {
    name: "Original name",
    sourceIds: ["source-a", "source-b"],
    slotSourceIds: ["source-a", "source-b"],
    visibleBitset: previousBitset,
    bounds: { minX: 1, maxX: 2, minY: 3, maxY: 4 },
    renderBounds: null,
    error: null,
    reportedError: null,
    renderError: null,
  };
  let ensuredLayer = null;
  viewer.removeCompositeRendererLayer = (target) => {
    target.layerId = null;
    target.rendererDefinitionKey = null;
    return true;
  };
  viewer.ensureCompositeRendererLayer = (target) => {
    ensuredLayer = target;
    return 12;
  };
  viewer.clearSelectedCompositeAreaForLayer = () => {};

  assert.equal(viewer.restoreCompositeLayerState(layer, state), true);
  assert.equal(ensuredLayer, layer);
  assert.equal(layer.name, "Original name");
  assert.deepEqual(layer.sourceIds, ["source-a", "source-b"]);
  assert.deepEqual(layer.slotSourceIds, ["source-a", "source-b"]);
  assert.equal(layer.visibleBitset, previousBitset);
  assert.deepEqual(layer.bounds, state.bounds);
  assert.equal(layer.error, null);
});

test("custom source changes discard stale membership and never resurrect an unchecked source", () => {
  const dialog = {
    options: { isEdit: false },
    selectedSourceIds: ["source-a", "source-b"],
    draftLayer: {
      kind: "composite",
      sourceIds: ["source-a", "source-b"],
      slotSourceIds: ["source-a", "source-b"],
      visibleBitset: new Uint8Array([0x06]),
    },
    presetCommand: "custom",
    requiresAreaMode: false,
    bitsetDirty: false,
    nameInput: { value: "Custom coverage" },
    submit: { disabled: false },
    custom: { disabled: false },
  };

  CompositeLayerDialog.prototype.updateSourceComposition.call(
    dialog,
    ["source-a"],
  );
  CompositeLayerDialog.prototype.syncSubmitState.call(dialog);
  assert.deepEqual(dialog.selectedSourceIds, ["source-a"]);
  assert.equal(dialog.draftLayer, null);
  assert.equal(dialog.presetCommand, null);
  assert.equal(dialog.requiresAreaMode, true);
  assert.equal(dialog.submit.disabled, true);
  assert.equal(dialog.custom.disabled, true);

  CompositeLayerDialog.prototype.updateSourceComposition.call(
    dialog,
    ["source-a", "source-c"],
  );
  CompositeLayerDialog.prototype.syncSubmitState.call(dialog);
  assert.deepEqual(dialog.selectedSourceIds, ["source-a", "source-c"]);
  assert.equal(dialog.selectedSourceIds.includes("source-b"), false);
  assert.equal(dialog.submit.disabled, true);
  assert.equal(dialog.custom.disabled, false);
});

test("edit source changes also invalidate the pre-edit membership draft", () => {
  const dialog = {
    options: { isEdit: true },
    selectedSourceIds: ["source-a", "source-b"],
    draftLayer: {
      kind: "composite",
      sourceIds: ["source-a", "source-b"],
      slotSourceIds: ["source-a", "source-b"],
      visibleBitset: new Uint8Array([0x0e]),
    },
    presetCommand: null,
    requiresAreaMode: false,
    bitsetDirty: false,
    nameInput: { value: "Existing coverage" },
    submit: { disabled: false },
    custom: { disabled: false },
  };

  CompositeLayerDialog.prototype.updateSourceComposition.call(
    dialog,
    ["source-a"],
  );
  CompositeLayerDialog.prototype.updateSourceComposition.call(
    dialog,
    ["source-a", "source-c"],
  );
  CompositeLayerDialog.prototype.syncSubmitState.call(dialog);

  assert.deepEqual(dialog.selectedSourceIds, ["source-a", "source-c"]);
  assert.equal(dialog.draftLayer, null);
  assert.equal(dialog.requiresAreaMode, true);
  assert.equal(dialog.submit.disabled, true);
  assert.equal(dialog.custom.disabled, false);
});

test("a selected preset is rebuilt after an intermediate one-source edit", () => {
  const dialog = Object.create(CompositeLayerDialog.prototype);
  dialog.selectedSourceIds = ["source-a", "source-b"];
  dialog.draftLayer = {
    kind: "composite",
    sourceIds: ["source-a", "source-b"],
    slotSourceIds: ["source-a", "source-b"],
    visibleBitset: new Uint8Array([0x0e]),
  };
  dialog.presetCommand = "union";
  dialog.requiresAreaMode = false;
  dialog.bitsetDirty = true;

  dialog.updateSourceComposition(["source-a"]);
  assert.equal(dialog.draftLayer, null);
  dialog.updateSourceComposition(["source-a", "source-c", "source-c"]);

  assert.deepEqual(dialog.selectedSourceIds, ["source-a", "source-c"]);
  assert.deepEqual(dialog.draftLayer.sourceIds, ["source-a", "source-c"]);
  assert.deepEqual(dialog.draftLayer.slotSourceIds, ["source-a", "source-c"]);
  assert.deepEqual([...dialog.draftLayer.visibleBitset], [0xfe]);
});
