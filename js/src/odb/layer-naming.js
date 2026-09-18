import { COPPER_LAYER_TYPES, DRILL_LAYER_TYPES } from "./matrix.js";

const TOP_TOKENS = /(^|[^a-z])(top|t|front|f|smt|sst|spt|comp)([^a-z]|$)/i;
const BOTTOM_TOKENS = /(^|[^a-z])(bot|bottom|b|back|smb|ssb|spb|sold|solder)([^a-z]|$)/i;

const EXTENSIONS = {
  SOLDER_MASK: { top: ".gts", bottom: ".gbs" },
  SILK_SCREEN: { top: ".gto", bottom: ".gbo" },
  SOLDER_PASTE: { top: ".gtp", bottom: ".gbp" },
};

/**
 * Give each matrix layer a Gerber-style file name so the viewer's name-based
 * heuristics (top/bottom filters, drill colors, outline detection) keep
 * working on imported ODB++ layers.
 */
export function assignLayerFileNames(layers) {
  const result = new Map();
  // MISC-context layers (CAM scratch copies such as `I_2.ORG`) share the
  // SIGNAL type but are not part of the stack-up, so only BOARD layers take
  // part in the outer-copper decision.
  const boardLayers = layers.filter((layer) => (layer.context ?? "BOARD") === "BOARD");
  const copper = boardLayers.filter((layer) => COPPER_LAYER_TYPES.has(layer.type));
  const { topCopper, bottomCopper } = identifyOuterCopper(boardLayers, copper);
  const firstCopperRow = topCopper?.row ?? null;
  const lastCopperRow = bottomCopper?.row ?? null;

  let innerIndex = 0;
  for (const layer of layers) {
    const base = layer.name.toLowerCase();
    let side = null;
    let fileName;

    if (boardLayers.includes(layer) && COPPER_LAYER_TYPES.has(layer.type)) {
      if (layer === topCopper) {
        side = "top";
        fileName = `${base}.gtl`;
      } else if (layer === bottomCopper) {
        side = "bottom";
        fileName = `${base}.gbl`;
      } else {
        side = "inner";
        innerIndex += 1;
        fileName = `${base}-inner${innerIndex}.gbr`;
      }
    } else if (DRILL_LAYER_TYPES.has(layer.type)) {
      fileName = `${base}.drl`;
    } else {
      side = sideFromTokens(base);
      if (!side && firstCopperRow !== null) {
        if (layer.row < firstCopperRow) side = "top";
        else if (layer.row > lastCopperRow) side = "bottom";
      }
      const extension = EXTENSIONS[layer.type]?.[side] ?? ".gbr";
      const needsSideToken = side && side !== "inner" && !sideFromTokens(base);
      fileName = `${needsSideToken ? `${side === "top" ? "top_" : "bot_"}` : ""}${base}${extension}`;
    }

    result.set(layer.name, {
      fileName,
      kind: DRILL_LAYER_TYPES.has(layer.type) ? "drill" : "gerber",
      side,
    });
  }
  return result;
}

/**
 * Outer copper layers: prefer the span of a through-hole DRILL layer
 * (START_NAME/END_NAME), then explicit top/bottom tokens in copper names, then
 * matrix ROW order. Some exporters (Altium) list inner layers after the
 * bottom layer, so ROW order alone is not reliable.
 */
function identifyOuterCopper(layers, copper) {
  if (copper.length === 0) return { topCopper: null, bottomCopper: null };
  if (copper.length === 1) return { topCopper: copper[0], bottomCopper: copper[0] };

  const byName = new Map(copper.map((layer) => [layer.name.toLowerCase(), layer]));
  for (const layer of layers) {
    if (!DRILL_LAYER_TYPES.has(layer.type) || layer.type !== "DRILL") continue;
    const start = byName.get(layer.startName.toLowerCase());
    const end = byName.get(layer.endName.toLowerCase());
    if (start && end && start !== end) {
      return start.row <= end.row
        ? { topCopper: start, bottomCopper: end }
        : { topCopper: end, bottomCopper: start };
    }
  }

  const tokenTop = copper.filter((layer) => sideFromTokens(layer.name) === "top");
  const tokenBottom = copper.filter((layer) => sideFromTokens(layer.name) === "bottom");
  if (tokenTop.length === 1 && tokenBottom.length === 1) {
    return { topCopper: tokenTop[0], bottomCopper: tokenBottom[0] };
  }

  return { topCopper: copper[0], bottomCopper: copper[copper.length - 1] };
}

export function sideFromTokens(name) {
  const value = String(name ?? "").replace(/\+/g, " ");
  if (TOP_TOKENS.test(value)) return "top";
  if (BOTTOM_TOKENS.test(value)) return "bottom";
  return null;
}

export const PROFILE_FILE_NAME = "profile.gko";

