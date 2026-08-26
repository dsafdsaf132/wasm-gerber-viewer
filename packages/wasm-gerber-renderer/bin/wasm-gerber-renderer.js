#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { gunzipSync } from "node:zlib";
import { createNodeGerberRenderer, fileLayer } from "../node.js";
import {
  createCompositeVisibleBitset,
  isBoardOutlineLayerName,
  isDrillLayerKind,
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_ARCHIVE_ENTRY_COUNT,
  MAX_ARCHIVE_METADATA_SIZE_BYTES,
  MAX_ARCHIVE_PATH_SIZE_BYTES,
  MAX_ARCHIVE_TOTAL_SIZE_BYTES,
  MAX_COMPOSITE_CONFIG_SIZE_BYTES,
  MAX_SOURCE_FILE_SIZE_BYTES,
  MAX_TAR_EXPANDED_SIZE_BYTES,
  normalizeLayerKind,
  parseColor,
  validateCompositeSourceCount,
} from "../shared.js";

const USAGE = `Usage:
  gerber-renderer <input.gbr|input.tar.gz...> [options]

Options:
  -o, --output <path>              PNG output path (required for multiple inputs)
  --width <px>                     Output width (default: 1200)
  --height <px>                    Output height (default: 800)
  --padding <px>                   Fit padding in pixels (default: 0)
  --background <color>             Background color, e.g. #05070c (default: transparent)
  --alpha <0-1>                    Blend-mode Gerber alpha (default: 0.7)
  --composite-mode <blend|stack>   blend=additive, stack=ordered source-over
  --minimum-feature-pixels <px>    Minimum line/arc display width (default: 1)
  --max-render-target-bytes <size> Per-render target memory cap, e.g. 2g, 512m
  --max-band-bytes <size>          Streamed PNG row-buffer cap, e.g. 512m
  --max-full-frame-bytes <size>    Full-frame PNG memory cap, e.g. 512m
  --framebuffer-memory-safety-factor <n>
                                  Full-frame memory estimate safety factor
  --render-strategy <strategy>     PNG strategy: auto, full-frame, or stream
  --approx-region-arcs             Approximate region arcs before rendering (default: false)
  --arc-quality <0|1|2>            Approx arc quality: low, normal, high (default: 1)
  --invert-layer <selector>        Invert by 1-based index, exact name, or basename (repeatable)
  --outline-layer <selector>       Outline: auto, bounds, index, exact name, or basename
  --composite-config <path>        Composite layers and hidden sources JSON config
  --flip-x                         Mirror the output horizontally
  --flip-y                         Mirror the output vertically
  --no-drill                       Skip NC drill layers
  --no-fit                         Use identity view instead of fit view (default: fit enabled)
  --skill                          Print AI usage notes
  -h, --help                       Show this help

Input limits:
  Gerber/drill or compressed archive: 300 MiB per file
  Composite JSON: 16 MiB; TAR: 1000 headers, 300 MiB source data

AI guide: run \`gerber-renderer --skill\` for usage notes.
`;

const TAR_GZ_EXTENSIONS = [".tar.gz", ".tgz"];
const GENERIC_GERBER_EXTENSIONS = [".art", ".gbr", ".gdo", ".ger", ".pho"];
const SKILL_URL = new URL("../SKILL.md", import.meta.url);
const CLI_LAYER_SELECTOR_PREFIX = "__wasmGerberRendererCliLayer:";
const COMPOSITE_CONFIG_ROOT_FIELDS = new Set(["hiddenSources", "composites"]);
const COMPOSITE_CONFIG_LAYER_FIELDS = new Set([
  "name",
  "sources",
  "preset",
  "visibleAreas",
  "color",
  "alpha",
  "inverted",
  "outline",
]);

async function main() {
  const { inputs, output, frameOptions, showSkill, compositeConfigPath } = parseArgs(
    process.argv.slice(2),
  );
  if (showSkill) {
    process.stdout.write(await readFile(SKILL_URL, "utf8"));
    return;
  }

  if (inputs.length === 0) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }

  const outputPath = output || inferOutputPath(inputs);

  const layers = await collectInputLayers(inputs);
  if (layers.length === 0) {
    throw new Error("No Gerber layers found in input files.");
  }
  const compositeConfig = compositeConfigPath
    ? await readCompositeConfig(compositeConfigPath)
    : { hiddenSources: [], composites: [] };
  if (compositeConfigPath) {
    await classifyAmbiguousDrdLayers(layers);
  }
  const cliOutlineSelection = applyLayerSelectionOptions(layers, frameOptions);
  const normalizedCompositeConfig = normalizeCompositeConfig(
    compositeConfig,
    layers,
    cliOutlineSelection,
  );

  frameOptions.onLayerError = ({ name, error }) => {
    process.stderr.write(`Skipped ${name}: ${errorMessage(error)}\n`);
  };
  const renderer = await createNodeGerberRenderer({
    __continueOnCompositeError: true,
    __onCompositeError: ({ name, error }) => {
      process.stderr.write(`Skipped ${name}: ${error}\n`);
    },
  });
  let renderResult = { renderedCount: 0, failures: [] };
  try {
    await renderer.withFrame(frameOptions, async () => {
      const rendererLayerIds = new Map();
      for (const layer of layers) {
        try {
          const layerId = await renderer.renderLayer(layer);
          if (layerId != null) {
            rendererLayerIds.set(layer, layerId);
            renderResult.renderedCount += 1;
          }
        } catch (error) {
          const failure = { layer, name: layer.name || "Layer", error };
          renderResult.failures.push(failure);
          frameOptions.onLayerError(failure);
        }
      }

      for (const composite of normalizedCompositeConfig.composites) {
        const sourceLayerIds = composite.sourceLayers.map((layer) =>
          rendererLayerIds.get(layer),
        );
        if (sourceLayerIds.some((layerId) => layerId == null)) {
          process.stderr.write(
            `Skipped ${composite.options.name}: a source layer failed to load\n`,
          );
          continue;
        }
        let outlineLayerId = null;
        if (composite.outlineLayer) {
          outlineLayerId = rendererLayerIds.get(composite.outlineLayer) ?? null;
          if (outlineLayerId == null && composite.outlineRequired) {
            process.stderr.write(
              `Skipped ${composite.options.name}: the outline layer failed to load\n`,
            );
            continue;
          }
        }
        try {
          const compositeId = await renderer.renderCompositeLayer(sourceLayerIds, {
            ...composite.options,
            ...(outlineLayerId == null ? {} : { outlineLayerId }),
            ...(composite.outlineBoundsFallbackAllowed
              ? { __allowOutlineBoundsFallback: true }
              : {}),
          });
          if (compositeId != null) {
            renderResult.renderedCount += 1;
          }
        } catch (error) {
          process.stderr.write(
            `Skipped ${composite.options.name}: ${errorMessage(error)}\n`,
          );
        }
      }
    });
    if (renderResult.renderedCount === 0 && renderResult.failures.length > 0) {
      throw renderResult.failures[0].error;
    }
    await renderer.exportPngFile(outputPath, { background: frameOptions.background });
    renderResult.renderedCount = Math.max(
      0,
      renderResult.renderedCount - renderer.__lastCompositeErrors.length,
    );
    for (const layer of renderer.lastRenderPlan?.layers ?? []) {
      if (layer.kind === "composite" && layer.outlineFallbackUsed) {
        process.stderr.write(
          `Composite ${layer.name}: automatic outline fill failed; used Bounds fallback (${layer.outlineFallbackError})\n`,
        );
      }
    }
  } finally {
    renderer.dispose();
  }
  process.stdout.write(
    `Rendered ${renderResult.renderedCount}/${layers.length + normalizedCompositeConfig.composites.length} layer(s) to ${outputPath}\n`,
  );
}

function parseArgs(args) {
  const inputs = [];
  const frameOptions = {};
  const invertLayerSelectors = [];
  let output = "";
  let showSkill = false;
  let compositeConfigPath = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === "--skill") {
      showSkill = true;
    } else if (arg === "-o" || arg === "--output") {
      output = readOptionValue(args, ++index, arg);
    } else if (arg === "--width") {
      frameOptions.width = readPositiveInteger(args, ++index, arg);
    } else if (arg === "--height") {
      frameOptions.height = readPositiveInteger(args, ++index, arg);
    } else if (arg === "--padding") {
      frameOptions.padding = readNumber(args, ++index, arg);
    } else if (arg === "--background") {
      frameOptions.background = readOptionValue(args, ++index, arg);
    } else if (arg === "--alpha") {
      frameOptions.globalAlpha = readNumber(args, ++index, arg);
    } else if (arg === "--composite-mode") {
      frameOptions.compositeMode = readCompositeMode(args, ++index, arg);
    } else if (arg === "--minimum-feature-pixels") {
      frameOptions.minimumFeaturePixels = readNumber(args, ++index, arg);
    } else if (arg === "--max-render-target-bytes") {
      frameOptions.maxRenderTargetBytes = readByteSize(args, ++index, arg);
    } else if (arg === "--max-band-bytes") {
      frameOptions.maxBandBytes = readByteSize(args, ++index, arg);
    } else if (arg === "--max-full-frame-bytes") {
      frameOptions.maxFullFrameBytes = readByteSize(args, ++index, arg);
    } else if (arg === "--framebuffer-memory-safety-factor") {
      frameOptions.framebufferMemorySafetyFactor = readNumber(args, ++index, arg);
    } else if (arg === "--render-strategy") {
      frameOptions.strategy = readRenderStrategy(args, ++index, arg);
    } else if (arg === "--approx-region-arcs") {
      frameOptions.preserveArcRegions = false;
    } else if (arg === "--arc-quality") {
      frameOptions.arcTessellationQuality = readNonNegativeInteger(args, ++index, arg);
    } else if (arg === "--invert-layer") {
      invertLayerSelectors.push(readOptionValue(args, ++index, arg));
    } else if (arg === "--outline-layer") {
      frameOptions.invertedOutline = readOptionValue(args, ++index, arg);
    } else if (arg === "--composite-config") {
      compositeConfigPath = readOptionValue(args, ++index, arg);
    } else if (arg === "--flip-x") {
      frameOptions.flipX = true;
    } else if (arg === "--flip-y") {
      frameOptions.flipY = true;
    } else if (arg === "--no-drill") {
      frameOptions.renderDrills = false;
    } else if (arg === "--no-fit") {
      frameOptions.fit = false;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      inputs.push(arg);
    }
  }

  frameOptions.invertLayerSelectors = invertLayerSelectors;
  return { inputs, output, frameOptions, showSkill, compositeConfigPath };
}

function readCompositeMode(args, index, flag) {
  const value = readOptionValue(args, index, flag);
  if (value === "blend" || value === "stack") {
    return value;
  }
  throw new Error(`${flag} must be blend or stack.`);
}

function readRenderStrategy(args, index, flag) {
  const value = readOptionValue(args, index, flag);
  if (value === "auto" || value === "full-frame" || value === "stream") {
    return value;
  }
  throw new Error(`${flag} must be auto, full-frame, or stream.`);
}

function inferOutputPath(inputs) {
  if (inputs.length !== 1) {
    throw new Error("Multiple inputs require --output.");
  }

  const input = inputs[0];
  const lowerInput = input.toLowerCase();
  const archiveExtension = TAR_GZ_EXTENSIONS.find((extension) =>
    lowerInput.endsWith(extension),
  );
  if (archiveExtension) {
    return `${input.slice(0, -archiveExtension.length)}.png`;
  }

  const dotIndex = input.lastIndexOf(".");
  if (dotIndex < 0) {
    return `${input}.png`;
  }

  const extension = input.slice(dotIndex).toLowerCase();
  if (GENERIC_GERBER_EXTENSIONS.includes(extension)) {
    return `${input.slice(0, dotIndex)}.png`;
  }

  return `${input}.png`;
}

function readOptionValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function readPositiveInteger(args, index, option) {
  const value = Number(readOptionValue(args, index, option));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${option} requires a positive integer.`);
  }
  return value;
}

function readNonNegativeInteger(args, index, option) {
  const value = Number(readOptionValue(args, index, option));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${option} requires a non-negative integer.`);
  }
  return value;
}

function readNumber(args, index, option) {
  const value = Number(readOptionValue(args, index, option));
  if (!Number.isFinite(value)) {
    throw new Error(`${option} requires a finite number.`);
  }
  return value;
}

function readByteSize(args, index, option) {
  const rawValue = readOptionValue(args, index, option).trim();
  const match = rawValue.match(/^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?|bytes?)?$/i);
  if (!match) {
    throw new Error(`${option} requires a byte size such as 2147483648, 512m, or 2g.`);
  }

  const value = Number(match[1]);
  const unit = (match[2] || "b").toLowerCase();
  const multipliers = {
    b: 1,
    byte: 1,
    bytes: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  const multiplier = multipliers[unit];
  const bytes = value * multiplier;
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isSafeInteger(Math.round(bytes))) {
    throw new Error(`${option} requires a positive safe byte size.`);
  }
  return Math.round(bytes);
}

async function collectInputLayers(inputs) {
  const layers = [];

  for (const input of inputs) {
    if (isTarGzPath(input)) {
      const archiveLayers = await readTarGzLayers(input);
      if (archiveLayers.length === 0) {
        process.stderr.write(`Skipped ${input}: no regular files found in archive\n`);
      }
      layers.push(...archiveLayers);
    } else {
      layers.push(fileLayer(input, { name: basename(input) }));
    }
  }

  return layers;
}

async function classifyAmbiguousDrdLayers(layers) {
  for (const layer of layers) {
    if (layer?.kind != null || !hasAmbiguousDrdName(layer)) continue;
    let content;
    if (typeof layer.source === "string") {
      content = layer.source;
    } else if (typeof layer.source?.path === "string") {
      try {
        content = (
          await readStableRegularFile(
            layer.source.path,
            MAX_SOURCE_FILE_SIZE_BYTES,
            "Gerber/drill input",
          )
        ).toString("utf8");
      } catch (_error) {
        // Preserve best-effort source loading: an unreadable source is
        // diagnosed by renderLayer and only its dependent composites skip.
        continue;
      }
    } else {
      continue;
    }
    layer.kind = normalizeLayerKind(undefined, layer.source, layer.name, content);
  }
}

function hasAmbiguousDrdName(layer) {
  return [
    layer?.name,
    layer?.source?.path,
    layer?.__archiveEntryPath,
  ].some((value) => String(value ?? "").toLowerCase().endsWith(".drd"));
}

function applyLayerSelectionOptions(layers, frameOptions) {
  for (const [index, layer] of layers.entries()) {
    layer.__selectorKey = `${CLI_LAYER_SELECTOR_PREFIX}${index + 1}`;
  }

  const selectors = frameOptions.invertLayerSelectors ?? [];
  delete frameOptions.invertLayerSelectors;

  for (const selector of selectors) {
    const layer = resolveLayerSelector(layers, selector, "--invert-layer");
    layer.inverted = true;
  }

  if (selectors.length > 0) {
    frameOptions.retainSourceContentForInversion = true;
  }

  if (
    frameOptions.invertedOutline != null &&
    !isInvertedOutlineKeyword(frameOptions.invertedOutline)
  ) {
    const outlineLayer = resolveLayerSelector(
      layers,
      frameOptions.invertedOutline,
      "--outline-layer",
    );
    frameOptions.invertedOutline = outlineLayer.__selectorKey;
    if (selectors.length > 0) {
      frameOptions.retainSourceContentForInversion = true;
    }
    return { type: "layer", layer: outlineLayer, required: true };
  }

  return {
    type: String(frameOptions.invertedOutline ?? "auto").toLowerCase(),
    layer: null,
    required: false,
  };
}

async function readCompositeConfig(path) {
  let text;
  try {
    text = (
      await readStableRegularFile(
        path,
        MAX_COMPOSITE_CONFIG_SIZE_BYTES,
        "Composite config",
      )
    ).toString("utf8");
  } catch (error) {
    throw new Error(`Failed to read composite config ${path}: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse composite config ${path}: ${errorMessage(error)}`);
  }
}

function normalizeCompositeConfig(config, layers, cliOutlineSelection) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Composite config root must be a JSON object.");
  }
  assertCompositeConfigFields(config, COMPOSITE_CONFIG_ROOT_FIELDS, "Composite config");
  const hiddenSources = config.hiddenSources ?? [];
  const composites = config.composites ?? [];
  if (!Array.isArray(hiddenSources)) {
    throw new Error("Composite config hiddenSources must be an array.");
  }
  if (!Array.isArray(composites)) {
    throw new Error("Composite config composites must be an array.");
  }

  for (const selector of hiddenSources) {
    validateCompositeSelector(selector, "hiddenSources");
    resolveLayerSelector(layers, selector, "hiddenSources").visible = false;
  }

  const normalizedComposites = composites.map((definition, index) => {
    const label = `composites[${index}]`;
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error(`${label} must be an object.`);
    }
    assertCompositeConfigFields(
      definition,
      COMPOSITE_CONFIG_LAYER_FIELDS,
      label,
    );
    if (!Array.isArray(definition.sources)) {
      throw new Error(`${label}.sources must be an array.`);
    }
    validateCompositeSourceCount(definition.sources.length);
    const sourceLayers = definition.sources.map((selector) => {
      validateCompositeSelector(selector, `${label}.sources`);
      const layer = resolveLayerSelector(layers, selector, `${label}.sources`);
      if (!isCompositeGerberLayer(layer)) {
        throw new Error(`${label}.sources must reference ordinary Gerber layers.`);
      }
      return layer;
    });
    if (new Set(sourceLayers).size !== sourceLayers.length) {
      throw new Error(`${label}.sources resolves to duplicate layers.`);
    }
    createCompositeVisibleBitset(sourceLayers.length, definition);
    if (definition.name != null && typeof definition.name !== "string") {
      throw new Error(`${label}.name must be a string.`);
    }
    if (
      definition.alpha != null &&
      (!Number.isFinite(definition.alpha) ||
        definition.alpha < 0 ||
        definition.alpha > 1)
    ) {
      throw new Error(`${label}.alpha must be a finite number from 0 to 1.`);
    }
    if (definition.inverted != null && typeof definition.inverted !== "boolean") {
      throw new Error(`${label}.inverted must be a boolean.`);
    }
    if (definition.color != null) {
      try {
        parseColor(definition.color);
      } catch (error) {
        throw new Error(`${label}.color is invalid: ${errorMessage(error)}`);
      }
    }

    const outline = resolveCompositeConfigOutline(
      definition.outline,
      layers,
      cliOutlineSelection,
      label,
    );
    const options = {
      ...(definition.name == null ? {} : { name: definition.name }),
      ...(definition.preset == null ? {} : { preset: definition.preset }),
      ...(definition.visibleAreas == null
        ? {}
        : { visibleAreas: definition.visibleAreas }),
      ...(definition.color == null ? {} : { color: definition.color }),
      ...(definition.alpha == null ? {} : { alpha: definition.alpha }),
      ...(definition.inverted == null
        ? {}
        : { inverted: definition.inverted }),
    };
    return {
      sourceLayers,
      outlineLayer: outline.layer,
      outlineRequired: outline.required,
      outlineBoundsFallbackAllowed: outline.allowBoundsFallback,
      options: {
        ...options,
        name: options.name?.trim() || `Composite ${index + 1}`,
      },
    };
  });

  return { composites: normalizedComposites };
}

function assertCompositeConfigFields(value, allowedFields, label) {
  const unknownFields = Object.keys(value).filter(
    (field) => !allowedFields.has(field),
  );
  if (unknownFields.length === 0) return;
  throw new Error(
    `${label} contains unsupported field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}.`,
  );
}

function resolveCompositeConfigOutline(
  configuredOutline,
  layers,
  cliOutlineSelection,
  label,
) {
  if (configuredOutline != null) {
    validateCompositeSelector(configuredOutline, `${label}.outline`);
    const normalized = String(configuredOutline).toLowerCase();
    if (normalized === "bounds") {
      return { layer: null, required: false, allowBoundsFallback: false };
    }
    if (normalized === "auto") {
      return {
        layer: findAutomaticCompositeOutline(layers),
        required: false,
        allowBoundsFallback: true,
      };
    }
    const layer = resolveLayerSelector(layers, configuredOutline, `${label}.outline`);
    if (!isCompositeGerberLayer(layer)) {
      throw new Error(`${label}.outline must reference an ordinary Gerber layer.`);
    }
    return { layer, required: true, allowBoundsFallback: false };
  }

  if (cliOutlineSelection?.type === "layer") {
    if (!isCompositeGerberLayer(cliOutlineSelection.layer)) {
      throw new Error(`${label}.outline must reference an ordinary Gerber layer.`);
    }
    return {
      layer: cliOutlineSelection.layer,
      required: cliOutlineSelection.required,
      allowBoundsFallback: false,
    };
  }
  if (cliOutlineSelection?.type === "bounds") {
    return { layer: null, required: false, allowBoundsFallback: false };
  }
  return {
    layer: findAutomaticCompositeOutline(layers),
    required: false,
    allowBoundsFallback: true,
  };
}

function validateCompositeSelector(selector, label) {
  if (typeof selector !== "string" && typeof selector !== "number") {
    throw new Error(`${label} selectors must be strings or 1-based numeric indices.`);
  }
  if (typeof selector === "number" && !Number.isInteger(selector)) {
    throw new Error(`${label} numeric selectors must be integers.`);
  }
}

function findAutomaticCompositeOutline(layers) {
  return layers.find((layer) => {
    if (!isCompositeGerberLayer(layer)) return false;
    const sourcePath = layer.source?.path || "";
    return (
      isBoardOutlineLayerName(layer.name) ||
      isBoardOutlineLayerName(sourcePath) ||
      isBoardOutlineLayerName(portableBasename(sourcePath)) ||
      isBoardOutlineLayerName(layer.__archiveEntryPath || "") ||
      isBoardOutlineLayerName(
        portableBasename(layer.__archiveEntryPath || ""),
      )
    );
  }) ?? null;
}

function isCompositeGerberLayer(layer) {
  const content = typeof layer?.source === "string" ? layer.source : "";
  return !isDrillLayerKind(
    normalizeLayerKind(layer?.kind, layer?.source, layer?.name, content),
  );
}

function isInvertedOutlineKeyword(value) {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "auto" || normalized === "bounds";
}

function resolveLayerSelector(layers, selector, optionName) {
  const normalized = String(selector ?? "").trim();
  if (!normalized) {
    throw new Error(`${optionName} requires a non-empty selector.`);
  }

  const numericIndex = Number(normalized);
  if (typeof selector === "number") {
    if (
      Number.isInteger(selector) &&
      selector >= 1 &&
      selector <= layers.length
    ) {
      return layers[selector - 1];
    }
    throw new Error(
      `${optionName} numeric selector is out of range: ${normalized}`,
    );
  }
  const indexedLayer =
    Number.isInteger(numericIndex) &&
    numericIndex >= 1 &&
    numericIndex <= layers.length
      ? layers[numericIndex - 1]
      : null;

  const selectorNames = new Set([
    normalized,
    normalizePortablePath(normalized),
  ]);
  const matches = layers.filter((layer) => {
    const rawNames = [
      layer.name,
      layer.source?.path,
      layer.__archiveEntryPath,
    ].filter(Boolean);
    const names = new Set(
      rawNames.flatMap((name) => [
        String(name),
        normalizePortablePath(name),
        portableBasename(name),
      ]),
    );
    return [...selectorNames].some((name) => names.has(name));
  });

  if (matches.length === 1) {
    if (indexedLayer && matches[0] !== indexedLayer) {
      throw new Error(
        `${optionName} selector is ambiguous between index and name: ${normalized}`,
      );
    }
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`${optionName} selector is ambiguous: ${normalized}`);
  }
  if (indexedLayer) {
    return indexedLayer;
  }
  throw new Error(`${optionName} selector did not match any layer: ${normalized}`);
}

function normalizePortablePath(value) {
  return String(value).replaceAll("\\", "/");
}

function portableBasename(value) {
  const normalized = normalizePortablePath(value);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

async function readTarGzLayers(path) {
  const compressed = await readStableRegularFile(
    path,
    MAX_SOURCE_FILE_SIZE_BYTES,
    "Compressed archive",
  );
  if (compressed.length === 0) {
    throw new Error(`Failed to read archive ${path}: the compressed file is empty.`);
  }
  const expansionLimit = Math.min(
    MAX_TAR_EXPANDED_SIZE_BYTES,
    compressed.length * MAX_ARCHIVE_COMPRESSION_RATIO,
  );
  let archive;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: expansionLimit });
  } catch (error) {
    throw new Error(
      `Failed to read archive ${path}: invalid gzip data or expanded-size/compression-ratio limit exceeded (${errorMessage(error)}).`,
    );
  }
  if (archive.length / compressed.length > MAX_ARCHIVE_COMPRESSION_RATIO) {
    throw new RangeError(
      `${path} exceeds the supported archive compression ratio of ${MAX_ARCHIVE_COMPRESSION_RATIO}:1.`,
    );
  }

  const layers = [];
  let offset = 0;
  let nextLongName = null;
  let nextPaxHeaders = null;
  let entryCount = 0;
  let sourceBytes = 0;
  let foundEndMarker = false;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      if (!isZeroBlock(archive.subarray(offset))) {
        throw new Error(`${path} contains non-zero data after its TAR end marker.`);
      }
      foundEndMarker = true;
      break;
    }

    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRY_COUNT) {
      throw new RangeError(
        `${path} contains more than ${MAX_ARCHIVE_ENTRY_COUNT} TAR entries.`,
      );
    }
    validateTarHeaderChecksum(header, path, entryCount);

    const headerSize = readTarSize(header, 124, 12, path, entryCount);
    const typeFlag = String.fromCharCode(header[156] || 0);
    const isExtensionHeader = typeFlag === "L" || typeFlag === "x" || typeFlag === "g";
    const size =
      !isExtensionHeader && nextPaxHeaders?.size != null
        ? readPaxSize(nextPaxHeaders.size, path, entryCount)
        : headerSize;
    if (isExtensionHeader && size > MAX_ARCHIVE_METADATA_SIZE_BYTES) {
      throw new RangeError(
        `${path} TAR entry ${entryCount} metadata exceeds ${MAX_ARCHIVE_METADATA_SIZE_BYTES} bytes.`,
      );
    }
    if (
      (typeFlag === "0" || typeFlag === "\0") &&
      size > MAX_SOURCE_FILE_SIZE_BYTES
    ) {
      throw new RangeError(
        `${path} TAR entry ${entryCount} is ${size} bytes; the per-entry limit is ${MAX_SOURCE_FILE_SIZE_BYTES} bytes.`,
      );
    }
    const dataOffset = offset + 512;
    const paddedSize = Math.ceil(size / 512) * 512;
    const dataEnd = dataOffset + size;
    const nextOffset = dataOffset + paddedSize;
    if (
      !Number.isSafeInteger(dataEnd) ||
      !Number.isSafeInteger(nextOffset) ||
      dataEnd > archive.length ||
      nextOffset > archive.length
    ) {
      throw new Error(
        `${path} TAR entry ${entryCount} is truncated (declares ${size} data bytes).`,
      );
    }
    const data = archive.subarray(dataOffset, dataEnd);
    offset = nextOffset;

    if (typeFlag === "L") {
      assertTarMetadataSize(data, path, entryCount, "GNU long-name");
      nextLongName = validateArchivePath(
        trimNulls(data.toString("utf8")).replace(/\n$/, ""),
        path,
        entryCount,
      );
      continue;
    }
    if (typeFlag === "x") {
      assertTarMetadataSize(data, path, entryCount, "PAX");
      nextPaxHeaders = readPaxHeaders(data, path, entryCount);
      if (nextPaxHeaders.path != null) {
        nextPaxHeaders.path = validateArchivePath(
          nextPaxHeaders.path,
          path,
          entryCount,
        );
      }
      continue;
    }
    if (typeFlag === "g") {
      assertTarMetadataSize(data, path, entryCount, "global PAX");
      readPaxHeaders(data, path, entryCount);
      continue;
    }

    const name = validateArchivePath(
      nextPaxHeaders?.path || nextLongName || readTarPath(header),
      path,
      entryCount,
    );
    nextLongName = null;
    nextPaxHeaders = null;

    if (typeFlag !== "0" && typeFlag !== "\0") continue;
    sourceBytes += size;
    if (
      !Number.isSafeInteger(sourceBytes) ||
      sourceBytes > MAX_ARCHIVE_TOTAL_SIZE_BYTES
    ) {
      throw new RangeError(
        `${path} source data exceeds the ${MAX_ARCHIVE_TOTAL_SIZE_BYTES}-byte archive limit.`,
      );
    }

    const entryPath = normalizeArchivePath(name);
    if (entryPath && !isArchiveMetadataPath(entryPath)) {
      layers.push({
        source: data.toString("utf8"),
        name: `${basename(path)}:${entryPath}`,
        __archiveEntryPath: entryPath,
      });
    }
  }

  if (!foundEndMarker) {
    const trailingBytes = archive.length - offset;
    throw new Error(
      `${path} is a truncated TAR archive (missing end marker${trailingBytes ? `; ${trailingBytes} trailing bytes` : ""}).`,
    );
  }
  if (nextLongName != null || nextPaxHeaders != null) {
    throw new Error(`${path} ends with TAR metadata that has no following entry.`);
  }

  return layers;
}

function isTarGzPath(path) {
  const lowerPath = path.toLowerCase();
  return TAR_GZ_EXTENSIONS.some((extension) => lowerPath.endsWith(extension));
}

function isArchiveMetadataPath(path) {
  const normalizedPath = normalizeArchivePath(path);
  const fileName = normalizedPath.split("/").pop() ?? normalizedPath;
  return normalizedPath.startsWith("__MACOSX/") || fileName.startsWith("._");
}

function readTarPath(header) {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function readTarString(buffer, start, length) {
  return trimNulls(buffer.subarray(start, start + length).toString("utf8"));
}

function readTarSize(buffer, start, length, archivePath, entryCount) {
  const field = buffer.subarray(start, start + length);
  if ((field[0] & 0x80) !== 0) {
    throw new Error(
      `${archivePath} TAR entry ${entryCount} uses an unsupported base-256 size.`,
    );
  }
  const value = trimTarNumericField(field);
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) {
    throw new Error(`${archivePath} TAR entry ${entryCount} has an invalid size.`);
  }
  const size = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${archivePath} TAR entry ${entryCount} has an unsafe size.`);
  }
  return size;
}

function readPaxHeaders(data, archivePath, entryCount) {
  const headers = Object.create(null);
  let offset = 0;

  while (offset < data.length) {
    const spaceIndex = data.indexOf(0x20, offset);
    if (spaceIndex < 0) {
      throw new Error(`${archivePath} TAR entry ${entryCount} has malformed PAX data.`);
    }

    const lengthText = data.subarray(offset, spaceIndex).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) {
      throw new Error(`${archivePath} TAR entry ${entryCount} has malformed PAX data.`);
    }
    const recordLength = Number.parseInt(lengthText, 10);
    const recordEnd = offset + recordLength;
    if (
      !Number.isSafeInteger(recordLength) ||
      recordLength <= spaceIndex - offset + 2 ||
      recordEnd > data.length ||
      data[recordEnd - 1] !== 0x0a
    ) {
      throw new Error(`${archivePath} TAR entry ${entryCount} has malformed PAX data.`);
    }

    const record = data
      .subarray(spaceIndex + 1, recordEnd - 1)
      .toString("utf8");
    const equalsIndex = record.indexOf("=");
    if (equalsIndex <= 0) {
      throw new Error(`${archivePath} TAR entry ${entryCount} has malformed PAX data.`);
    }
    headers[record.slice(0, equalsIndex)] = record.slice(equalsIndex + 1);
    offset = recordEnd;
  }

  return headers;
}

function readPaxSize(value, archivePath, entryCount) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${archivePath} TAR entry ${entryCount} has an invalid PAX size.`);
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${archivePath} TAR entry ${entryCount} has an unsafe PAX size.`);
  }
  return size;
}

function validateTarHeaderChecksum(header, archivePath, entryCount) {
  const expectedText = trimTarNumericField(header.subarray(148, 156));
  if (!/^[0-7]+$/.test(expectedText)) {
    throw new Error(`${archivePath} TAR entry ${entryCount} has an invalid checksum.`);
  }
  const expected = Number.parseInt(expectedText, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) {
    throw new Error(`${archivePath} TAR entry ${entryCount} failed its checksum.`);
  }
}

function trimTarNumericField(field) {
  return field.toString("ascii").replace(/^[\0 ]+|[\0 ]+$/g, "");
}

function assertTarMetadataSize(data, archivePath, entryCount, kind) {
  if (data.length > MAX_ARCHIVE_METADATA_SIZE_BYTES) {
    throw new RangeError(
      `${archivePath} TAR entry ${entryCount} ${kind} metadata exceeds ${MAX_ARCHIVE_METADATA_SIZE_BYTES} bytes.`,
    );
  }
}

function validateArchivePath(value, archivePath, entryCount) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${archivePath} TAR entry ${entryCount} has an invalid path.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_ARCHIVE_PATH_SIZE_BYTES) {
    throw new RangeError(
      `${archivePath} TAR entry ${entryCount} path exceeds ${MAX_ARCHIVE_PATH_SIZE_BYTES} bytes.`,
    );
  }
  return value;
}

function normalizeArchivePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function trimNulls(value) {
  const nullIndex = value.indexOf("\0");
  return nullIndex >= 0 ? value.slice(0, nullIndex) : value;
}

function isZeroBlock(buffer) {
  return buffer.every((byte) => byte === 0);
}

async function readStableRegularFile(path, maxBytes, label) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new TypeError(`${label} must be a regular file: ${path}`);
    }
    if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
      throw new RangeError(`${label} has an unsupported size: ${path}`);
    }
    if (stats.size > maxBytes) {
      throw new RangeError(
        `${label} ${path} is ${stats.size} bytes; the limit is ${maxBytes} bytes.`,
      );
    }

    const bytes = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== bytes.length) {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }
    const sentinel = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytesRead } = await handle.read(sentinel, 0, 1, offset);
    if (extraBytesRead !== 0) {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }
    const finalStats = await handle.stat();
    if (
      finalStats.size !== stats.size ||
      finalStats.mtimeMs !== stats.mtimeMs ||
      finalStats.ctimeMs !== stats.ctimeMs ||
      finalStats.dev !== stats.dev ||
      finalStats.ino !== stats.ino
    ) {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
