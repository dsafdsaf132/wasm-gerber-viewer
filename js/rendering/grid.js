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

// Coordinate labels sit on the bottom and right edges, away from the HUD in
// the top-left corner. The bottom row clears the canvas status bar
// (--status-height, 34 px). Label widths are estimated from the character
// count of the 11 px tabular-number font, so placing them reads no layout.
export const GRID_LABEL_BOTTOM_INSET = 40;
export const GRID_LABEL_RIGHT_INSET = 6;
export const GRID_LABEL_CHAR_PIXELS = 7;
export const GRID_LABEL_HEIGHT_PIXELS = 12;
export const GRID_LABEL_GAP_PIXELS = 12;
const GRID_ORIGIN_RADIUS = 6;

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
 * Formats the coordinate of grid line k (in minor steps from the origin) in
 * the unit of the spacing label, without the unit: "-12.5", "2500".
 */
export function formatGridCoordinate(k, spacing) {
  let exponent = spacing.exponent;
  if (spacing.unit === "inch" && spacing.mantissa * 10 ** exponent < MIL_THRESHOLD_INCHES) {
    exponent += MIL_EXPONENT;
  }
  return formatScaledNumber(k * spacing.mantissa, exponent);
}

/**
 * Draws the grid into the overlay: minor, major and axis paths, the origin
 * marker, and a group of coordinate labels for each axis. The elements are
 * created on the first draw and reused afterwards, so panning and zooming
 * only rewrite path data and label text and positions.
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

  if (overlay.childElementCount !== 6) {
    overlay.replaceChildren(
      createGridElement("path", "grid-minor"),
      createGridElement("path", "grid-major"),
      createGridElement("path", "grid-axis"),
      createGridElement("path", "grid-origin"),
      createGridElement("g", "grid-labels grid-x-labels"),
      createGridElement("g", "grid-labels grid-y-labels"),
    );
  }
  overlay.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  overlay.children[0].setAttribute("d", paths.minor);
  overlay.children[1].setAttribute("d", paths.major);
  overlay.children[2].setAttribute("d", paths.axes);
  overlay.children[3].setAttribute("d", paths.origin);
  syncGridLabels(overlay.children[4], paths.xLabels);
  syncGridLabels(overlay.children[5], paths.yLabels);
  return paths.spacing;
}

/**
 * Builds the path data and labels for renderGridOverlay without touching the
 * DOM. The lines through the world origin go to `axes` instead of `major`, and
 * `origin` is empty when the origin is outside the overlay.
 * @returns {{spacing: object, minor: string, major: string, axes: string, origin: string,
 *   xLabels: {x: number, y: number, text: string}[],
 *   yLabels: {x: number, y: number, text: string}[]} | null}
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
  const axes = [];
  for (let k = columns.first; k <= columns.last; k++) {
    const x = first.x + pixelsPerStepX * (k - columns.first);
    gridLineBucket(k, minor, major, axes).push(`M${x.toFixed(1)} 0V${rect.height}`);
  }
  for (let k = rows.first; k <= rows.last; k++) {
    const y = first.y + pixelsPerStepY * (k - rows.first);
    gridLineBucket(k, minor, major, axes).push(`M0 ${y.toFixed(1)}H${rect.width}`);
  }

  let origin = "";
  if (columns.first <= 0 && columns.last >= 0 && rows.first <= 0 && rows.last >= 0) {
    const x = (first.x - pixelsPerStepX * columns.first).toFixed(1);
    const y = (first.y - pixelsPerStepY * rows.first).toFixed(1);
    const r = GRID_ORIGIN_RADIUS;
    // A ring drawn as two half arcs, with a cross through it.
    origin =
      `M${x} ${y}m${-r} 0a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0` +
      `M${x} ${y}m${-2 * r} 0h${4 * r}M${x} ${y}m0 ${-2 * r}v${4 * r}`;
  }

  const paths = {
    spacing,
    minor: minor.join(""),
    major: major.join(""),
    axes: axes.join(""),
    origin,
    xLabels: [],
    yLabels: [],
  };

  // Y labels are right-aligned on the right edge; X labels stay clear of
  // that column, and Y labels stay above the X label row. An overlay too
  // short for the X row gets no labels.
  const xLabelY = rect.height - GRID_LABEL_BOTTOM_INSET;
  const yLabelX = rect.width - GRID_LABEL_RIGHT_INSET;
  if (xLabelY < GRID_LABEL_HEIGHT_PIXELS) {
    return paths;
  }
  paths.xLabels = gridLabels({
    lines: columns,
    spacing,
    firstPixel: first.x,
    pixelsPerStep: pixelsPerStepX,
    extent: labelPixels(columns, spacing),
    min: 0,
    max: yLabelX - labelPixels(rows, spacing) - GRID_LABEL_GAP_PIXELS,
    place: (x, text) => ({ x: round1(x), y: xLabelY, text }),
  });
  paths.yLabels = gridLabels({
    lines: rows,
    spacing,
    firstPixel: first.y,
    pixelsPerStep: pixelsPerStepY,
    extent: GRID_LABEL_HEIGHT_PIXELS,
    min: 0,
    max: xLabelY - GRID_LABEL_HEIGHT_PIXELS,
    // Shift the baseline so the text is centred on its line.
    place: (y, text) => ({ x: yLabelX, y: round1(y + GRID_LABEL_HEIGHT_PIXELS / 3), text }),
  });
  return paths;
}

function gridLineBucket(k, minor, major, axes) {
  if (k === 0) return axes;
  return k % GRID_MAJOR_EVERY === 0 ? major : minor;
}

// Estimated on-screen width of the widest label in the range of lines. It
// always allows for a minus sign, so panning changes it only when the range
// crosses a power of ten, not each time an edge line gains a sign.
function labelPixels(lines, spacing) {
  const largest = Math.max(Math.abs(lines.first), Math.abs(lines.last));
  return (formatGridCoordinate(largest, spacing).length + 1) * GRID_LABEL_CHAR_PIXELS;
}

// Labels every `stride` major lines, so that neighbouring labels do not
// overlap. The stride is a 1-2-5 step and labels sit on lines whose index is
// a multiple of it, so they stay put while panning. A label is dropped when
// it would reach past [min, max].
function gridLabels({ lines, spacing, firstPixel, pixelsPerStep, extent, min, max, place }) {
  const stride = labelStride(Math.abs(pixelsPerStep) * GRID_MAJOR_EVERY, extent + GRID_LABEL_GAP_PIXELS);
  if (!stride) {
    return [];
  }

  const every = stride * GRID_MAJOR_EVERY;
  const labels = [];
  const half = extent / 2;
  for (let k = Math.ceil(lines.first / every) * every; k <= lines.last; k += every) {
    const pixel = firstPixel + pixelsPerStep * (k - lines.first);
    if (pixel - half >= min && pixel + half <= max) {
      labels.push(place(pixel, formatGridCoordinate(k, spacing)));
    }
  }
  return labels;
}

// The smallest 1-2-5 number of major cells that spans at least `needed`
// pixels. Major cells are at least 40 pixels, so this is 1 or 2 for labels of
// a few characters. Null when the lines have collapsed onto one pixel.
function labelStride(majorPixels, needed) {
  if (!(majorPixels > 0)) {
    return null;
  }
  // needed / majorPixels < 10^(exponent + 1), so the mantissa 10 always fits.
  const exponent = Math.max(0, Math.floor(Math.log10(needed / majorPixels)));
  const mantissa = GRID_SPACING_MANTISSAS.find(
    (candidate) => candidate * 10 ** exponent * majorPixels >= needed,
  );
  return mantissa * 10 ** exponent;
}

// Rounds as the path data does, so a label lands on its line's coordinate.
function round1(value) {
  return Number(value.toFixed(1));
}

// Updates a label group in place: text elements are added or removed only
// when the number of labels changes. Setting textContent replaces the text
// node, so it is written only when the label changes.
function syncGridLabels(group, labels) {
  while (group.childElementCount > labels.length) {
    group.lastElementChild.remove();
  }
  while (group.childElementCount < labels.length) {
    group.appendChild(document.createElementNS(SVG_NS, "text"));
  }
  for (let index = 0; index < labels.length; index++) {
    const node = group.children[index];
    const label = labels[index];
    node.setAttribute("x", label.x);
    node.setAttribute("y", label.y);
    if (node.textContent !== label.text) {
      node.textContent = label.text;
    }
  }
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

function createGridElement(tagName, className) {
  const element = document.createElementNS(SVG_NS, tagName);
  element.setAttribute("class", className);
  return element;
}
