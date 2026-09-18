import { decodeText } from "./archive/job-tree.js";
import { PROFILE_FILE_NAME, assignLayerFileNames } from "./layer-naming.js";
import { DRILL_LAYER_TYPES, isImportableBoardLayer, parseMatrix } from "./matrix.js";
import { parseStepHeader } from "./step-header.js";
import { parseStructuredText, unitsFromValue } from "./structured-text.js";
import { isNonPlatedTool, parseTools } from "./tools.js";

/**
 * Layer text handed to WASM: the layer's original ODB++ files wrapped in a
 * small header. The Rust `odb` module parses it straight into render
 * geometry; no Gerber or Excellon text is generated. ODB++ text files never
 * start a line with `%`, so the markers cannot collide with file content.
 */
export const ODB_ENVELOPE_MAGIC = "%ODB++LAYER%";

/**
 * Read the job-level files of an ODB++ tree.
 */
export async function loadOdbJob(tree, { jobName = "job", onStage = () => {} } = {}) {
  if (!tree.has("matrix/matrix")) {
    throw new Error(`${jobName} is not an ODB++ job (matrix/matrix not found)`);
  }
  onStage("Reading ODB++ job");
  const matrix = parseMatrix(await tree.readText("matrix/matrix"));
  if (matrix.steps.length === 0) {
    throw new Error(`${jobName} has no steps in matrix/matrix`);
  }

  let units = "inch";
  let name = jobName;
  if (tree.has("misc/info")) {
    const info = parseStructuredText(await tree.readText("misc/info")).values;
    units = unitsFromValue(info.get("UNITS") ?? info.get("ODB_UNITS"), units);
    name = info.get("JOB_NAME") || info.get("ODB_JOB_NAME") || name;
  }

  return { name, units, matrix, tree };
}

/**
 * Pick the step to import: an explicit request, a step named like "pcb", the
 * first step that is not a panel (no STEP-REPEAT), else the first step.
 */
export async function selectDefaultStep(job, preferredName = null) {
  const steps = job.matrix.steps;
  if (preferredName) {
    const match = steps.find((step) => step.name.toLowerCase() === String(preferredName).toLowerCase());
    if (match) return match.name;
  }
  if (steps.length === 1) return steps[0].name;

  const pcbLike = steps.find((step) => /pcb/i.test(step.name));
  if (pcbLike) return pcbLike.name;

  for (const step of steps) {
    const headerPath = `steps/${step.name}/stephdr`;
    if (!job.tree.has(headerPath)) return step.name;
    const header = parseStepHeader(await job.tree.readText(headerPath));
    if (header.stepRepeats.length === 0) return step.name;
  }
  return steps[0].name;
}

/**
 * Build viewer layer sources for one step. Layer files are read up front (so
 * the archive byte budget applies); the envelope handed to WASM is assembled
 * lazily inside `readText`, exactly once per source.
 */
export async function createOdbLayerSources(
  job,
  { stepName, onWarning = () => {}, onInfo = () => {}, onStage = () => {} } = {},
) {
  const sources = [];
  const stepPrefix = `steps/${stepName}`;
  const symbolLibrary = new SymbolFileLibrary(job.tree);

  const profilePath = `${stepPrefix}/profile`;
  if (job.tree.has(profilePath)) {
    onStage(`Reading ${PROFILE_FILE_NAME}`);
    const bytes = await job.tree.readBytes(profilePath);
    sources.push(
      createGerberSource(PROFILE_FILE_NAME, bytes, { kind: "profile", name: "profile", symbolLibrary }),
    );
  } else {
    onWarning(job.name, `Step ${stepName} has no profile; board outline unavailable`);
  }

  const names = assignLayerFileNames(job.matrix.layers);
  const skipped = new Map();
  for (const layer of job.matrix.layers) {
    if (!isImportableBoardLayer(layer)) {
      const key = layer.context === "BOARD" ? layer.type || "UNKNOWN" : `${layer.context}/${layer.type}`;
      skipped.set(key, (skipped.get(key) ?? 0) + 1);
      continue;
    }

    const naming = names.get(layer.name);
    const layerDir = `${stepPrefix}/layers/${layer.name.toLowerCase()}`;
    const featuresPath = `${layerDir}/features`;
    if (!job.tree.has(featuresPath)) {
      onWarning(job.name, `Layer ${layer.name} has no features file; skipped`);
      continue;
    }

    onStage(`Reading ${naming.fileName}`);
    const bytes = await job.tree.readBytes(featuresPath);
    if (!hasFeatureRecords(bytes)) {
      onWarning(naming.fileName, "Layer has no features; skipped");
      continue;
    }

    if (layer.polarity === "NEGATIVE") {
      onWarning(naming.fileName, "Negative-polarity layer rendered as positive");
    }

    if (DRILL_LAYER_TYPES.has(layer.type)) {
      const toolsPath = `${layerDir}/tools`;
      const toolsText = job.tree.has(toolsPath) ? await job.tree.readText(toolsPath) : "";
      sources.push(
        ...createDrillSources(naming.fileName, bytes, toolsText, {
          kind: layer.type === "ROUT" ? "rout" : "drill",
          name: layer.name,
          defaultUnits: job.units,
        }),
      );
    } else {
      sources.push(
        createGerberSource(naming.fileName, bytes, { kind: "signal", name: layer.name, symbolLibrary }),
      );
    }
  }

  if (skipped.size > 0) {
    const summary = Array.from(skipped, ([type, count]) => `${type} x${count}`).join(", ");
    const total = Array.from(skipped.values()).reduce((sum, count) => sum + count, 0);
    onWarning(job.name, `Skipped ${total} non-board layer${total === 1 ? "" : "s"}: ${summary}`);
  }
  if (job.matrix.steps.length > 1) {
    const others = job.matrix.steps.filter((step) => step.name !== stepName).map((step) => step.name);
    onInfo(job.name, `Loaded step ${stepName}; other steps not imported: ${others.join(", ")}`);
    onWarning(job.name, `Loaded step ${stepName}; other steps not imported: ${others.join(", ")}`);
  }

  return sources;
}

const FEATURE_RECORD_PATTERN = /^[PLAST] |^B /m;

/** Cheap check for at least one feature record before handing a layer over. */
export function hasFeatureRecords(bytes) {
  return FEATURE_RECORD_PATTERN.test(decodeText(bytes));
}

/**
 * Assemble the text handed to WASM for one layer.
 * `files` is an ordered list of `[path, text]` pairs.
 */
export function buildOdbEnvelope({ kind, name, plating = null, files }) {
  const lines = [ODB_ENVELOPE_MAGIC, `kind=${kind}`, `name=${sanitizeHeaderValue(name)}`];
  if (plating) lines.push(`plating=${plating}`);
  let text = `${lines.join("\n")}\n`;
  for (const [path, content] of files) {
    text += `%ODB++FILE ${path}%\n${content}\n`;
  }
  return `${text}%ODB++END%\n`;
}

function sanitizeHeaderValue(value) {
  return String(value ?? "").replace(/[\r\n%]/g, "_");
}

/**
 * Standard symbol families are resolved by name inside WASM; anything else
 * that has a `symbols/<name>/features` file is a user-defined symbol whose
 * definition travels with the layer. A name is standard only when the whole
 * name follows the standard grammar (`<family><number>(x([rcs]?<number>|r|s))*`,
 * where a bare `r`/`s` is the round/square style flag of `dogbone`, `cross` and
 * `oblong_ths`, or `hole<number>(x<token>)*`), so `r10_tp` or `rect_custom`
 * are user symbols.
 * Keep in sync with `parse_standard_symbol` in `wasm/src/odb/symbols.rs`.
 */
const STANDARD_SYMBOL_PATTERN =
  /^(?:hole[0-9.]+(?:x[a-z0-9.]+)*|(?:oblong_ths|radhplate|donut_sr|donut_rc|donut_r|donut_s|donut_o|fhplate|rhplate|dogbone|oval_h|sr_ths|rc_tho|rc_ths|dshape|hplate|cross|dpack|o_ths|s_tho|s_thr|s_ths|hex_l|hex_s|moire|null|rect|oval|ths|thr|tri|oct|bfr|bfs|el|di|r|s)[0-9.]+(?:x(?:[rcs]?[0-9.]+|[rs]))*)$/i;

export function isStandardSymbolName(name) {
  return STANDARD_SYMBOL_PATTERN.test(String(name ?? "").trim());
}

/** Symbol names referenced by a features file's `$<n> <name>` table. */
export function referencedSymbolNames(featuresText) {
  const names = [];
  const pattern = /^\$\d+\s+(\S+)/gm;
  let match;
  while ((match = pattern.exec(featuresText)) !== null) {
    names.push(match[1]);
  }
  return names;
}

/**
 * Reads `symbols/<name>/features` files once per job and collects, for a
 * layer, every user symbol it references directly or through nested symbols.
 */
export class SymbolFileLibrary {
  constructor(tree) {
    this.tree = tree;
    this.cache = new Map();
  }

  load(name) {
    const key = String(name).toLowerCase();
    if (!this.cache.has(key)) {
      const path = `symbols/${name}/features`;
      this.cache.set(
        key,
        this.tree.has(path) ? this.tree.readText(path) : Promise.resolve(null),
      );
    }
    return this.cache.get(key);
  }

  /** `[path, text]` pairs for the envelope, keyed by lower-cased name. */
  async collect(featuresText) {
    const files = new Map();
    const queue = [featuresText];
    while (queue.length > 0) {
      const text = queue.pop();
      for (const name of referencedSymbolNames(text)) {
        const key = name.toLowerCase();
        if (files.has(key) || isStandardSymbolName(name)) continue;
        const symbolText = await this.load(name);
        if (symbolText == null) continue;
        files.set(key, [`symbols/${name}`, symbolText]);
        queue.push(symbolText);
      }
    }
    return Array.from(files.values());
  }
}

function createGerberSource(fileName, bytes, { kind, name, symbolLibrary }) {
  let promise = null;
  return {
    name: fileName,
    kind: "gerber",
    sizeBytes: bytes.byteLength,
    readText: (onProgress = () => {}) => {
      if (!promise) {
        promise = (async () => {
          const featuresText = decodeText(bytes);
          bytes = null;
          const symbolFiles = symbolLibrary ? await symbolLibrary.collect(featuresText) : [];
          return buildOdbEnvelope({
            kind,
            name,
            files: [["features", featuresText], ...symbolFiles],
          });
        })();
      }
      promise.then(
        () => onProgress(1),
        () => onProgress(1),
      );
      return promise;
    },
  };
}

/**
 * One drill source per plating class present (`-pth`, `-npth`), so
 * `getDrillType` colours them; a single class keeps the plain name unless it
 * is non-plated.
 */
function createDrillSources(fileName, bytes, toolsText, { kind, name, defaultUnits }) {
  const featuresText = decodeText(bytes);
  const toolsInfo = toolsText ? parseTools(toolsText, { defaultUnits }) : { tools: [] };
  const platings = drillPlatingsInUse(featuresText, toolsInfo.tools);
  const stem = fileName.replace(/\.drl$/i, "");
  const outputs =
    platings.size > 1
      ? [
          ["plated", "-pth"],
          ["non_plated", "-npth"],
        ]
      : [[null, platings.has("non_plated") ? "-npth" : ""]];

  return outputs.map(([plating, suffix]) => {
    const files = [["features", featuresText]];
    if (toolsText) files.push(["tools", toolsText]);
    const text = buildOdbEnvelope({ kind, name, plating, files });
    return {
      name: `${stem}${suffix}.drl`,
      kind: "drill",
      sizeBytes: text.length,
      readText: async (onProgress = () => {}) => {
        onProgress(1);
        return text;
      },
    };
  });
}

/**
 * Plating classes used by the pad, line and arc records of a drill layer.
 * A record's `dcode` names its tool; tools not in the `tools` file count as
 * plated, matching the WASM side.
 */
export function drillPlatingsInUse(featuresText, tools) {
  const nonPlated = new Set(tools.filter(isNonPlatedTool).map((tool) => tool.num));
  const platings = new Set();
  const pattern = /^([PLA]) (.*)$/gm;
  let match;
  while ((match = pattern.exec(featuresText)) !== null) {
    const tokens = match[2].split(";")[0].trim().split(/\s+/);
    let dcodeIndex;
    if (match[1] === "P") {
      dcodeIndex = tokens[2] === "-1" ? 6 : 4;
    } else if (match[1] === "L") {
      dcodeIndex = 6;
    } else {
      dcodeIndex = 8;
    }
    const dcode = Number.parseInt(tokens[dcodeIndex] ?? "", 10);
    platings.add(nonPlated.has(dcode) ? "non_plated" : "plated");
    if (platings.size === 2) break;
  }
  return platings;
}

