import { parseNumber, parseStructuredText } from "./structured-text.js";

export const BOARD_LAYER_TYPES = new Set([
  "SIGNAL",
  "POWER_GROUND",
  "MIXED",
  "SOLDER_MASK",
  "SILK_SCREEN",
  "SOLDER_PASTE",
  "DRILL",
  "ROUT",
]);

export const COPPER_LAYER_TYPES = new Set(["SIGNAL", "POWER_GROUND", "MIXED"]);
export const DRILL_LAYER_TYPES = new Set(["DRILL", "ROUT"]);

/**
 * Parse `matrix/matrix` into ordered steps and layers.
 */
export function parseMatrix(text) {
  const { blocks } = parseStructuredText(text);
  const steps = [];
  const layers = [];

  for (const block of blocks) {
    if (block.name === "STEP") {
      const name = block.values.get("NAME") ?? "";
      if (name === "") continue;
      steps.push({ col: parseNumber(block.values.get("COL"), steps.length + 1), name });
    } else if (block.name === "LAYER") {
      const name = block.values.get("NAME") ?? "";
      if (name === "") continue;
      layers.push({
        row: parseNumber(block.values.get("ROW"), layers.length + 1),
        context: (block.values.get("CONTEXT") ?? "BOARD").toUpperCase(),
        type: (block.values.get("TYPE") ?? "").toUpperCase(),
        name,
        polarity: (block.values.get("POLARITY") ?? "POSITIVE").toUpperCase(),
        startName: block.values.get("START_NAME") ?? "",
        endName: block.values.get("END_NAME") ?? "",
        addType: (block.values.get("ADD_TYPE") ?? "").toUpperCase(),
      });
    }
  }

  steps.sort((a, b) => a.col - b.col);
  layers.sort((a, b) => a.row - b.row);
  return { steps, layers };
}

export function isImportableBoardLayer(layer) {
  return layer.context === "BOARD" && BOARD_LAYER_TYPES.has(layer.type);
}

