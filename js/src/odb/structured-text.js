/**
 * Parse ODB++ "structured text" files (matrix, stephdr, tools, misc/info):
 * top-level `KEY=VALUE` lines plus `NAME { KEY=VALUE ... }` blocks.
 */
export function parseStructuredText(text) {
  const values = new Map();
  const blocks = [];
  let current = null;

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line.endsWith("{")) {
      current = { name: line.slice(0, -1).trim().toUpperCase(), values: new Map() };
      blocks.push(current);
      continue;
    }
    if (line === "}") {
      current = null;
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim().toUpperCase();
    const value = line.slice(equalsIndex + 1).trim();
    (current ? current.values : values).set(key, value);
  }

  return { values, blocks };
}

export function parseNumber(value, fallback = 0) {
  const number = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) ? number : fallback;
}

/** Units declared by a `UNITS=` line; ODB++ defaults to inch when absent. */
export function unitsFromValue(value, fallback = "inch") {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "MM") return "mm";
  if (normalized === "INCH" || normalized === "IN") return "inch";
  return fallback;
}

/** Millimeters per file unit. */
export function unitScale(units) {
  return units === "mm" ? 1 : 25.4;
}

/** Symbol and tool dimensions are thousandths of the file unit (mils or microns). */
export function symbolScale(units) {
  return 0.001 * unitScale(units);
}

