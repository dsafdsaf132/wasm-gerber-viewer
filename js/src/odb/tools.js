import {
  parseNumber,
  parseStructuredText,
  symbolScale,
  unitsFromValue,
} from "./structured-text.js";

/**
 * Parse a drill/rout layer `tools` file. Sizes are given in thousandths of the
 * file unit (mils or microns) and are returned in millimeters.
 */
export function parseTools(text, { defaultUnits = "inch" } = {}) {
  const { values, blocks } = parseStructuredText(text);
  const units = unitsFromValue(values.get("UNITS"), defaultUnits);
  const scale = symbolScale(units);
  const tools = [];

  for (const block of blocks) {
    if (block.name !== "TOOLS") continue;
    const num = Number.parseInt(block.values.get("NUM") ?? "", 10);
    if (!Number.isSafeInteger(num)) continue;
    const finishSize = parseNumber(block.values.get("FINISH_SIZE"), NaN);
    const drillSize = parseNumber(block.values.get("DRILL_SIZE"), finishSize);
    tools.push({
      num,
      type: (block.values.get("TYPE") ?? "").toUpperCase(),
      finishSize: Number.isFinite(finishSize) ? finishSize * scale : null,
      drillSize: Number.isFinite(drillSize) ? drillSize * scale : null,
    });
  }

  return { units, tools };
}

export function isNonPlatedTool(tool) {
  return tool?.type === "NON_PLATED";
}

