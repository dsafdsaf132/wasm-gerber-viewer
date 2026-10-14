import { MIL_THRESHOLD_INCHES, MILS_PER_INCH, MM_PER_INCH } from "./measurements.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRID_SPACING_MANTISSAS = [1, 2, 5, 10];
// Inch spacings below one inch are written in mils: 1 in = 10^3 mil.
const MIL_EXPONENT = Math.round(Math.log10(MILS_PER_INCH));

// The minor spacing is the smallest 1-2-5 step that is at least this many CSS
// pixels on screen. Neighbouring steps differ by at most 2.5x, so a minor cell
// stays between 8 and 20 pixels wide.
export const GRID_MIN_MINOR_PIXELS = 8;
export const GRID_MAJOR_EVERY = 5;

/**
 * Picks the minor grid spacing for the current zoom.
 * @param {number} pixelsPerMm CSS pixels per world millimetre.
 * @param {"mm"|"inch"} unit Unit the spacing steps through.
 * @returns {{mantissa: number, exponent: number, unit: "mm"|"inch", stepMm: number} | null}
 */
export function chooseGridSpacing(pixelsPerMm, unit) {
  if (!Number.isFinite(pixelsPerMm) || pixelsPerMm <= 0) {
    return null;
  }

  const unitMm = unit === "inch" ? MM_PER_INCH : 1;
  const target = GRID_MIN_MINOR_PIXELS / pixelsPerMm / unitMm;
  let exponent = Math.floor(Math.log10(target));
  let mantissa = GRID_SPACING_MANTISSAS.find(
    (candidate) => candidate * 10 ** exponent * (1 + 1e-9) >= target,
  );
  if (mantissa === 10) {
    mantissa = 1;
    exponent += 1;
  }

  return {
    mantissa,
    exponent,
    unit: unit === "inch" ? "inch" : "mm",
    stepMm: mantissa * 10 ** exponent * unitMm,
  };
}

/**
 * Formats a spacing from chooseGridSpacing, e.g. "0.5 mm", "50 mil", "2 in".
 * Inch spacings below one inch use mils, as the measurement labels do.
 */
export function formatGridSpacing(spacing) {
  if (spacing.unit === "inch") {
    const inches = spacing.mantissa * 10 ** spacing.exponent;
    if (inches < MIL_THRESHOLD_INCHES) {
      return `${formatScaledNumber(spacing.mantissa, spacing.exponent + MIL_EXPONENT)} mil`;
    }
    return `${formatScaledNumber(spacing.mantissa, spacing.exponent)} in`;
  }
  return `${formatScaledNumber(spacing.mantissa, spacing.exponent)} mm`;
}

function formatScaledNumber(mantissa, exponent) {
  const value = mantissa * 10 ** exponent;
  return exponent >= 0 ? String(Math.round(value)) : value.toFixed(-exponent);
}

/**
 * Draws the grid into the overlay as one minor and one major path. The two
 * paths are created on the first draw and reused afterwards, so panning and
 * zooming only rewrite their path data.
 * @param {object} options
 * @param {SVGSVGElement} options.overlay
 * @param {{width: number, height: number}} options.rect Overlay size in CSS pixels.
 * @param {{minX: number, maxX: number, minY: number, maxY: number}} options.bounds
 *   World area covered by the overlay, in millimetres.
 * @param {"mm"|"inch"} options.unit
 * @param {(point: {x: number, y: number}) => ({x: number, y: number} | null)} options.worldToCanvasPoint
 * @returns The spacing that was drawn, or null when nothing was drawn.
 */
export function renderGridOverlay({ overlay, rect, bounds, unit, worldToCanvasPoint }) {
  const paths = buildGridPaths({ rect, bounds, unit, worldToCanvasPoint });
  if (!paths) {
    overlay.replaceChildren();
    return null;
  }

  if (overlay.childElementCount !== 2) {
    overlay.replaceChildren(createGridPath("grid-minor"), createGridPath("grid-major"));
  }
  overlay.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  overlay.children[0].setAttribute("d", paths.minor);
  overlay.children[1].setAttribute("d", paths.major);
  return paths.spacing;
}

/**
 * Builds the path data for renderGridOverlay without touching the DOM.
 * @returns {{spacing: object, minor: string, major: string} | null}
 */
export function buildGridPaths({ rect, bounds, unit, worldToCanvasPoint }) {
  const worldWidth = bounds.maxX - bounds.minX;
  if (rect.width === 0 || rect.height === 0 || !(worldWidth > 0)) {
    return null;
  }

  const spacing = chooseGridSpacing(rect.width / worldWidth, unit);
  if (!spacing) {
    return null;
  }

  const step = spacing.stepMm;
  const columns = gridLineRange(bounds.minX, bounds.maxX, step, rect.width);
  const rows = gridLineRange(bounds.minY, bounds.maxY, step, rect.height);
  if (!columns || !rows) {
    return null;
  }

  // The view has no rotation, so screen x depends only on world x and screen
  // y only on world y. Map the first line and the one after it, then step in
  // screen space. Both points are inside the view, so this stays exact far
  // from the world origin, where mapping the origin itself would not.
  const first = worldToCanvasPoint({ x: columns.first * step, y: rows.first * step });
  const next = worldToCanvasPoint({ x: (columns.first + 1) * step, y: (rows.first + 1) * step });
  if (!first || !next) {
    return null;
  }
  const pixelsPerStepX = next.x - first.x;
  const pixelsPerStepY = next.y - first.y;

  // Lines are counted from the world origin, so major lines stay on
  // multiples of five minor steps while panning.
  const minor = [];
  const major = [];
  for (let k = columns.first; k <= columns.last; k++) {
    const x = first.x + pixelsPerStepX * (k - columns.first);
    (k % GRID_MAJOR_EVERY === 0 ? major : minor).push(`M${x.toFixed(1)} 0V${rect.height}`);
  }
  for (let k = rows.first; k <= rows.last; k++) {
    const y = first.y + pixelsPerStepY * (k - rows.first);
    (k % GRID_MAJOR_EVERY === 0 ? major : minor).push(`M0 ${y.toFixed(1)}H${rect.width}`);
  }

  return { spacing, minor: minor.join(""), major: major.join("") };
}

// Line indices from min to max. Null when the indices are too large to step
// through exactly (a view far from the origin at a high zoom), or when there
// would be more lines than the minimum cell size allows on screen.
function gridLineRange(min, max, step, screenPixels) {
  const first = Math.ceil(min / step);
  const last = Math.floor(max / step);
  const maxLines = Math.ceil(screenPixels / GRID_MIN_MINOR_PIXELS) + 2;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first > maxLines) {
    return null;
  }
  return { first, last };
}

function createGridPath(className) {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("class", className);
  return path;
}
