import { parseNumber, parseStructuredText } from "./structured-text.js";

/**
 * Parse `steps/<step>/stephdr`. STEP-REPEAT blocks are parsed so panel steps
 * can be recognized; expanding them is not part of the current import.
 */
export function parseStepHeader(text) {
  const { values, blocks } = parseStructuredText(text);
  const stepRepeats = blocks
    .filter((block) => block.name === "STEP-REPEAT")
    .map((block) => ({
      name: block.values.get("NAME") ?? "",
      x: parseNumber(block.values.get("X")),
      y: parseNumber(block.values.get("Y")),
      dx: parseNumber(block.values.get("DX")),
      dy: parseNumber(block.values.get("DY")),
      nx: parseNumber(block.values.get("NX"), 1),
      ny: parseNumber(block.values.get("NY"), 1),
      angle: parseNumber(block.values.get("ANGLE")),
      flip: (block.values.get("FLIP") ?? "NO").toUpperCase() === "YES",
      mirror: (block.values.get("MIRROR") ?? "NO").toUpperCase() === "YES",
    }));

  return {
    xDatum: parseNumber(values.get("X_DATUM")),
    yDatum: parseNumber(values.get("Y_DATUM")),
    xOrigin: parseNumber(values.get("X_ORIGIN")),
    yOrigin: parseNumber(values.get("Y_ORIGIN")),
    stepRepeats,
  };
}

