// A symbol gallery job (mm) that flashes every standard symbol family of
// appendix A of the ODB++Design Format Specification 8.1 Update 4 on an
// 8-column grid, committed as `demo/odb-symbol-gallery.tgz` and used by the
// Playwright ODB spec. The same job was opened in the Siemens ODB++ Viewer
// (2604.0001) and every cell was compared with this viewer's rendering.
//
// Each cell carries a short +x tick to the right of the pad and a +y dot
// above it so orientation can be read from a screenshot. Rows (bottom up):
//   1-5   `oval_h` in all eight orient codes, butterflies and an asymmetric
//         user symbol (`lshape`) in orient 0/1/4/9, thermals at 30 degrees in
//         orient 0 and 4, rounded donuts and open-corner thermals, oval thermals
//   6-7   half ovals: w = h/2 in every orient code; very wide and square ones; `bfs`
//   8     tall oval thermal, two-spoke open-corner thermals, eight-spoke thermal
//   9-12  r, s, rect variants, oval, di, oct, donuts, hexagons, tri, el, moire,
//         line thermal, rounded square / rectangle thermals, oblong thermals
//   13-14 stencil symbols: hplate, rhplate, radhplate, dshape, cross, dogbone, dpack
// Only names the official viewer accepts are used: thermals with a gap wider
// than the inner diameter, and `oval_h` taller than twice its width, are left
// out (the viewer rejects the former as illegal and draws nothing for the
// latter); `fhplate` is left out because the viewer does not draw it either.
// Coordinates in mm, symbol dimensions in microns. No real design data.
import { featuresFile, matrixFile } from "./odb-fixture.mjs";

const COLUMNS = 8;
const PITCH = 5;

/** [symbol name, orient] per cell; `null` pads a row so a group starts on a new row. */
const GROUPS = [
  [
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((o) => ["oval_h2800x1400", `${o}`]),
    ["bfr2400", "0"], ["bfr2400", "1"], ["bfr2400", "4"], ["bfr2400", "8 30"],
    ["lshape", "0"], ["lshape", "1"], ["lshape", "4"], ["lshape", "9 30"],
    ["thr2400x1400x30x4x300", "0"], ["thr2400x1400x30x4x300", "4"],
    ["ths2400x1400x30x3x300", "0"], ["ths2400x1400x30x3x300", "4"],
    ["s_ths2400x1400x30x4x300", "0"], ["s_ths2400x1400x30x4x300", "4"],
    ["rc_ths2800x1600x45x4x300x300", "0"], ["rc_ths2800x1600x45x4x300x300", "4"],
    ["donut_s2400x1200xr400", "0"], ["donut_s2400x1200xr400x13", "0"],
    ["donut_rc2800x1600x400xr400", "0"], ["donut_rc2800x1600x400xr400x2", "0"],
    ["s_tho2400x1400x0x4x300", "0"], ["s_tho2400x1400x45x4x300", "0"],
    ["rc_tho2800x1600x0x4x300x300", "0"], ["rc_tho2800x1600x45x4x300x300", "0"],
    ["o_ths2800x1600x0x4x300x300", "0"], ["o_ths2800x1600x45x4x300x300", "0"],
    ["o_ths2800x1600x90x2x300x300", "0"], ["o_ths2800x1600x0x4x300x300", "4"],
  ],
  [...[0, 1, 2, 3, 4, 5, 6, 7].map((o) => ["oval_h1400x2800", `${o}`])],
  [
    ["oval_h2800x600", "0"], ["oval_h2800x600", "1"], ["oval_h2000x2000", "0"], ["oval_h2000x2000", "4"],
    ["bfs2400", "0"], ["bfs2400", "1"], ["bfs2400", "4"], ["bfs2400", "8 30"],
  ],
  [
    ["o_ths1600x2800x0x4x300x300", "0"], ["s_tho2400x1400x45x2x300", "0"],
    ["rc_tho2800x1600x45x2x300x300", "0"], ["s_ths2400x1400x30x8x200", "0"],
  ],
  [
    ["r2400", "0"], ["s2400", "0"], ["rect2400x1200", "0"], ["rect2400x1200xr400", "0"],
    ["rect2400x1200xr400x13", "0"], ["rect2400x1200xc400", "0"], ["rect2400x1200xc400x2", "0"], ["oval2400x1200", "0"],
    ["di2400x1200", "0"], ["oct2400x2400x600", "0"], ["donut_r2400x1600", "0"], ["donut_sr2400x1600", "0"],
    ["donut_o2400x1200x400", "0"], ["hex_l2400x1200x600", "0"], ["hex_s1200x2400x600", "0"], ["tri1200x2400", "0"],
    ["el2400x1200", "0"], ["moire200x300x3x100x2600x0", "0"], ["moire200x300x3x100x2600x45", "0"], ["s_thr2400x1600x45x4x400", "0"],
    ["s_ths1600x1200x90x4x160xr160", "0"], ["s_ths2200x1800x45x4x280xr280", "0"], ["rc_ths2000x1400x90x4x400x200xr400", "0"], ["rc_ths2000x1400x90x4x400x200xr400x13", "0"],
    ["oblong_ths2800x1600x0x4x300x300xr", "0"], ["oblong_ths2800x1600x45x4x300x300xs", "0"], ["oblong_ths2800x1600x90x2x300x300xr", "0"], ["sr_ths2400x1400x0x4x300", "0"],
  ],
  [
    ["hplate2400x1600x800", "0"], ["hplate2400x1600x800x200x200", "0"], ["rhplate2400x1600x800", "0"], ["radhplate2400x1600x1200", "0"],
    ["dshape2400x1600x800", "0"], ["cross2400x2400x400x400x50x50xr", "0"], ["cross2400x2400x400x400x50x50xs", "0"], ["dogbone2400x1600x400x400x50xr", "0"],
    ["dogbone2400x1600x400x400x50xs", "0"], ["dpack2400x2400x200x200x2x2", "0"], ["dpack2400x2400x200x200x3x2x100", "0"],
  ],
];

export const SYMBOL_GALLERY_CELLS = GROUPS.flatMap((group) => {
  const cells = [...group];
  while (cells.length % COLUMNS !== 0) cells.push(null);
  return cells;
});

/** Standard symbol names flashed by the gallery (deduplicated, in order). */
export const SYMBOL_GALLERY_NAMES = [
  ...new Set(SYMBOL_GALLERY_CELLS.filter(Boolean).map(([name]) => name)),
].filter((name) => name !== "lshape");

/** Build the gallery job. Returns `{ files, width, height }` (mm). */
export function buildSymbolGalleryJobFiles({ root = "symbol_gallery" } = {}) {
  const symbols = [...new Set(SYMBOL_GALLERY_CELLS.filter(Boolean).map(([name]) => name))];
  const symbolIndex = new Map(symbols.map((name, index) => [name, index]));
  const tick = symbols.length;
  symbols.push("r120");
  const records = [];
  SYMBOL_GALLERY_CELLS.forEach((cell, index) => {
    if (!cell) return;
    const [name, orient] = cell;
    const x = 3 + (index % COLUMNS) * PITCH;
    const y = 3 + Math.floor(index / COLUMNS) * PITCH;
    records.push(`P ${x} ${y} ${symbolIndex.get(name)} P 0 ${orient}`);
    records.push(`L ${x + 1.6} ${y} ${x + 2.3} ${y} ${tick} P 0`); // +x tick, outside the pad
    records.push(`P ${x} ${y + 2.0} ${tick} P 0 0`); // +y dot
  });
  const rows = Math.ceil(SYMBOL_GALLERY_CELLS.length / COLUMNS);
  const width = COLUMNS * PITCH + 1;
  const height = rows * PITCH + 1;

  // Asymmetric user symbol: an L (long arm +x, short arm +y) with a dot at the
  // end of the long arm, so mirroring and rotation of user symbols are visible.
  const lshape = featuresFile({
    units: "MM",
    symbols: ["r300", "r500"],
    records: ["L 0 0 1.6 0 0 P 0", "L 0 0 0 0.9 0 P 0", "P 1.6 0 1 P 0 0"],
  });

  const files = {
    [`${root}/matrix/matrix`]: matrixFile({ steps: ["pcb"], layers: [{ type: "SIGNAL", name: "TOP" }] }),
    [`${root}/steps/pcb/stephdr`]: "X_DATUM=0\nY_DATUM=0\nX_ORIGIN=0\nY_ORIGIN=0\n",
    [`${root}/steps/pcb/profile`]: featuresFile({
      units: "MM",
      records: ["S P 0", "OB 0 0 I", `OS 0 ${height}`, `OS ${width} ${height}`, `OS ${width} 0`, "OS 0 0", "OE", "SE"],
    }),
    [`${root}/steps/pcb/layers/top/features`]: featuresFile({ units: "MM", symbols, records }),
    [`${root}/symbols/lshape/features`]: lshape,
  };
  return { files, width, height };
}
