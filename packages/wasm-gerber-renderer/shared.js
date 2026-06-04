export const DEFAULT_WASM_MODULE_URLS = [
  new URL("./wasm/wasm_gerber_processor.js", import.meta.url),
  new URL("../../wasm/pkg/wasm_gerber_processor.js", import.meta.url),
];

export const DEFAULT_COLORS = [
  [1.0, 0.0, 0.0],
  [0.0, 1.0, 0.0],
  [0.0, 0.0, 1.0],
  [1.0, 0.0, 1.0],
  [1.0, 1.0, 0.0],
  [0.0, 1.0, 1.0],
];

export const DEFAULT_BACKGROUND = null;
export const DEFAULT_GLOBAL_ALPHA = 0.7;
export const DEFAULT_MINIMUM_FEATURE_PIXELS = 1;
export const DEFAULT_ARC_TESSELLATION_QUALITY = 1;
export const LAYER_KIND_GERBER = "gerber";
export const LAYER_KIND_DRILL = "drill";

const DRILL_FILE_EXTENSIONS = new Set([".drl", ".nc", ".xnc", ".xln"]);
const CSS_NAMED_COLORS = new Map([
  ["aliceblue", [240, 248, 255, 255]],
  ["antiquewhite", [250, 235, 215, 255]],
  ["aqua", [0, 255, 255, 255]],
  ["aquamarine", [127, 255, 212, 255]],
  ["azure", [240, 255, 255, 255]],
  ["beige", [245, 245, 220, 255]],
  ["bisque", [255, 228, 196, 255]],
  ["black", [0, 0, 0, 255]],
  ["blanchedalmond", [255, 235, 205, 255]],
  ["blue", [0, 0, 255, 255]],
  ["blueviolet", [138, 43, 226, 255]],
  ["brown", [165, 42, 42, 255]],
  ["burlywood", [222, 184, 135, 255]],
  ["cadetblue", [95, 158, 160, 255]],
  ["chartreuse", [127, 255, 0, 255]],
  ["chocolate", [210, 105, 30, 255]],
  ["coral", [255, 127, 80, 255]],
  ["cornflowerblue", [100, 149, 237, 255]],
  ["cornsilk", [255, 248, 220, 255]],
  ["crimson", [220, 20, 60, 255]],
  ["cyan", [0, 255, 255, 255]],
  ["darkblue", [0, 0, 139, 255]],
  ["darkcyan", [0, 139, 139, 255]],
  ["darkgoldenrod", [184, 134, 11, 255]],
  ["darkgray", [169, 169, 169, 255]],
  ["darkgreen", [0, 100, 0, 255]],
  ["darkgrey", [169, 169, 169, 255]],
  ["darkkhaki", [189, 183, 107, 255]],
  ["darkmagenta", [139, 0, 139, 255]],
  ["darkolivegreen", [85, 107, 47, 255]],
  ["darkorange", [255, 140, 0, 255]],
  ["darkorchid", [153, 50, 204, 255]],
  ["darkred", [139, 0, 0, 255]],
  ["darksalmon", [233, 150, 122, 255]],
  ["darkseagreen", [143, 188, 143, 255]],
  ["darkslateblue", [72, 61, 139, 255]],
  ["darkslategray", [47, 79, 79, 255]],
  ["darkslategrey", [47, 79, 79, 255]],
  ["darkturquoise", [0, 206, 209, 255]],
  ["darkviolet", [148, 0, 211, 255]],
  ["deeppink", [255, 20, 147, 255]],
  ["deepskyblue", [0, 191, 255, 255]],
  ["dimgray", [105, 105, 105, 255]],
  ["dimgrey", [105, 105, 105, 255]],
  ["dodgerblue", [30, 144, 255, 255]],
  ["firebrick", [178, 34, 34, 255]],
  ["floralwhite", [255, 250, 240, 255]],
  ["forestgreen", [34, 139, 34, 255]],
  ["fuchsia", [255, 0, 255, 255]],
  ["gainsboro", [220, 220, 220, 255]],
  ["ghostwhite", [248, 248, 255, 255]],
  ["gold", [255, 215, 0, 255]],
  ["goldenrod", [218, 165, 32, 255]],
  ["gray", [128, 128, 128, 255]],
  ["green", [0, 128, 0, 255]],
  ["greenyellow", [173, 255, 47, 255]],
  ["grey", [128, 128, 128, 255]],
  ["honeydew", [240, 255, 240, 255]],
  ["hotpink", [255, 105, 180, 255]],
  ["indianred", [205, 92, 92, 255]],
  ["indigo", [75, 0, 130, 255]],
  ["ivory", [255, 255, 240, 255]],
  ["khaki", [240, 230, 140, 255]],
  ["lavender", [230, 230, 250, 255]],
  ["lavenderblush", [255, 240, 245, 255]],
  ["lawngreen", [124, 252, 0, 255]],
  ["lemonchiffon", [255, 250, 205, 255]],
  ["lightblue", [173, 216, 230, 255]],
  ["lightcoral", [240, 128, 128, 255]],
  ["lightcyan", [224, 255, 255, 255]],
  ["lightgoldenrodyellow", [250, 250, 210, 255]],
  ["lightgray", [211, 211, 211, 255]],
  ["lightgreen", [144, 238, 144, 255]],
  ["lightgrey", [211, 211, 211, 255]],
  ["lightpink", [255, 182, 193, 255]],
  ["lightsalmon", [255, 160, 122, 255]],
  ["lightseagreen", [32, 178, 170, 255]],
  ["lightskyblue", [135, 206, 250, 255]],
  ["lightslategray", [119, 136, 153, 255]],
  ["lightslategrey", [119, 136, 153, 255]],
  ["lightsteelblue", [176, 196, 222, 255]],
  ["lightyellow", [255, 255, 224, 255]],
  ["lime", [0, 255, 0, 255]],
  ["limegreen", [50, 205, 50, 255]],
  ["linen", [250, 240, 230, 255]],
  ["magenta", [255, 0, 255, 255]],
  ["maroon", [128, 0, 0, 255]],
  ["mediumaquamarine", [102, 205, 170, 255]],
  ["mediumblue", [0, 0, 205, 255]],
  ["mediumorchid", [186, 85, 211, 255]],
  ["mediumpurple", [147, 112, 219, 255]],
  ["mediumseagreen", [60, 179, 113, 255]],
  ["mediumslateblue", [123, 104, 238, 255]],
  ["mediumspringgreen", [0, 250, 154, 255]],
  ["mediumturquoise", [72, 209, 204, 255]],
  ["mediumvioletred", [199, 21, 133, 255]],
  ["midnightblue", [25, 25, 112, 255]],
  ["mintcream", [245, 255, 250, 255]],
  ["mistyrose", [255, 228, 225, 255]],
  ["moccasin", [255, 228, 181, 255]],
  ["navajowhite", [255, 222, 173, 255]],
  ["navy", [0, 0, 128, 255]],
  ["oldlace", [253, 245, 230, 255]],
  ["olive", [128, 128, 0, 255]],
  ["olivedrab", [107, 142, 35, 255]],
  ["orange", [255, 165, 0, 255]],
  ["orangered", [255, 69, 0, 255]],
  ["orchid", [218, 112, 214, 255]],
  ["palegoldenrod", [238, 232, 170, 255]],
  ["palegreen", [152, 251, 152, 255]],
  ["paleturquoise", [175, 238, 238, 255]],
  ["palevioletred", [219, 112, 147, 255]],
  ["papayawhip", [255, 239, 213, 255]],
  ["peachpuff", [255, 218, 185, 255]],
  ["peru", [205, 133, 63, 255]],
  ["pink", [255, 192, 203, 255]],
  ["plum", [221, 160, 221, 255]],
  ["powderblue", [176, 224, 230, 255]],
  ["purple", [128, 0, 128, 255]],
  ["rebeccapurple", [102, 51, 153, 255]],
  ["red", [255, 0, 0, 255]],
  ["rosybrown", [188, 143, 143, 255]],
  ["royalblue", [65, 105, 225, 255]],
  ["saddlebrown", [139, 69, 19, 255]],
  ["salmon", [250, 128, 114, 255]],
  ["sandybrown", [244, 164, 96, 255]],
  ["seagreen", [46, 139, 87, 255]],
  ["seashell", [255, 245, 238, 255]],
  ["sienna", [160, 82, 45, 255]],
  ["silver", [192, 192, 192, 255]],
  ["skyblue", [135, 206, 235, 255]],
  ["slateblue", [106, 90, 205, 255]],
  ["slategray", [112, 128, 144, 255]],
  ["slategrey", [112, 128, 144, 255]],
  ["snow", [255, 250, 250, 255]],
  ["springgreen", [0, 255, 127, 255]],
  ["steelblue", [70, 130, 180, 255]],
  ["tan", [210, 180, 140, 255]],
  ["teal", [0, 128, 128, 255]],
  ["thistle", [216, 191, 216, 255]],
  ["tomato", [255, 99, 71, 255]],
  ["transparent", [0, 0, 0, 0]],
  ["turquoise", [64, 224, 208, 255]],
  ["violet", [238, 130, 238, 255]],
  ["wheat", [245, 222, 179, 255]],
  ["white", [255, 255, 255, 255]],
  ["whitesmoke", [245, 245, 245, 255]],
  ["yellow", [255, 255, 0, 255]],
  ["yellowgreen", [154, 205, 50, 255]],
]);

export class FrameState {
  constructor(options, extra = {}) {
    Object.assign(this, extra);
    this.options = options;
    this.layers = [];
    this.bounds = null;
    this.nextColorIndex = 0;
  }

  addLayer(layer) {
    this.layers.push(layer);
    this.bounds = mergeBounds(this.bounds, layer.bounds);
  }

  nextColor() {
    const color = this.options.colors[
      this.nextColorIndex % this.options.colors.length
    ];
    this.nextColorIndex += 1;
    return [...color];
  }

  toResult(view) {
    const globalAlpha = clamp01(numberOrDefault(this.options.globalAlpha, 1));
    return {
      width: this.options.width,
      height: this.options.height,
      background: this.options.background,
      bounds: this.bounds,
      view,
      layers: this.layers.map((layer) => ({
        id: layer.layerId,
        name: layer.name,
        bounds: layer.bounds,
        color: layer.color,
        alpha: resolveLayerAlpha(
          layer.alpha,
          isDrillLayerKind(layer.kind) ? 1 : globalAlpha,
        ),
      })),
    };
  }
}

export function createBaseFrameOptions(frameOptions = {}) {
  return {
    background:
      "background" in frameOptions ? frameOptions.background : DEFAULT_BACKGROUND,
    fit: frameOptions.fit !== false,
    padding: numberOrDefault(frameOptions.padding, 0),
    view: frameOptions.view || null,
    flipX: frameOptions.flipX === true,
    flipY: frameOptions.flipY === true,
    preserveArcRegions: frameOptions.preserveArcRegions !== false,
    arcTessellationQuality: numberOrDefault(
      frameOptions.arcTessellationQuality,
      DEFAULT_ARC_TESSELLATION_QUALITY,
    ),
    minimumFeaturePixels: numberOrDefault(
      frameOptions.minimumFeaturePixels,
      DEFAULT_MINIMUM_FEATURE_PIXELS,
    ),
    renderDrills: frameOptions.renderDrills !== false,
    globalAlpha: numberOrDefault(frameOptions.globalAlpha, DEFAULT_GLOBAL_ALPHA),
    colors: DEFAULT_COLORS.map((color) => [...color]),
  };
}

export async function loadWasmJsModule(rendererOptions, options = {}) {
  const {
    normalizeUrl = (value) => value,
    hint = "Run npm run build:wasm before using the package.",
  } = options;

  if (rendererOptions.wasmModule) {
    return {
      wasmModule: rendererOptions.wasmModule,
      wasmModuleUrl: rendererOptions.wasmModuleUrl
        ? normalizeUrl(rendererOptions.wasmModuleUrl)
        : null,
    };
  }

  const wasmModuleUrls = rendererOptions.wasmModuleUrl
    ? [normalizeUrl(rendererOptions.wasmModuleUrl)]
    : DEFAULT_WASM_MODULE_URLS;
  const errors = [];

  for (const wasmModuleUrl of wasmModuleUrls) {
    try {
      return {
        wasmModule: await import(String(wasmModuleUrl)),
        wasmModuleUrl,
      };
    } catch (error) {
      errors.push({ wasmModuleUrl, error });
    }
  }

  const attemptedUrls = wasmModuleUrls.map(String).join(", ");
  throw new Error(
    `Failed to load wasm-gerber renderer module from ${attemptedUrls}. ${hint}`,
    { cause: errors[0]?.error },
  );
}

export function applyProcessorOptions(processor, frameOptions) {
  if (typeof processor.set_preserve_arc_regions === "function") {
    processor.set_preserve_arc_regions(frameOptions.preserveArcRegions !== false);
  }
  if (
    typeof processor.set_arc_tessellation_quality === "function" &&
    frameOptions.arcTessellationQuality != null
  ) {
    processor.set_arc_tessellation_quality(frameOptions.arcTessellationQuality);
  }
  if (
    typeof processor.set_minimum_feature_pixels === "function" &&
    frameOptions.minimumFeaturePixels != null
  ) {
    processor.set_minimum_feature_pixels(frameOptions.minimumFeaturePixels);
  }
}

export function addLayerToProcessor(processor, content, offsetX, offsetY) {
  if (offsetX !== 0 || offsetY !== 0) {
    if (typeof processor.add_layer_with_offset !== "function") {
      throw new Error("Layer offsets require an updated WASM renderer.");
    }
    return processor.add_layer_with_offset(content, offsetX, offsetY);
  }
  return processor.add_layer(content);
}

export function addDrillLayerToProcessor(processor, content, offsetX, offsetY) {
  if (offsetX !== 0 || offsetY !== 0) {
    if (typeof processor.add_drill_layer_with_offset !== "function") {
      throw new Error("Drill layer offsets require an updated WASM renderer.");
    }
    return processor.add_drill_layer_with_offset(content, offsetX, offsetY);
  }
  if (typeof processor.add_drill_layer !== "function") {
    throw new Error("Drill rendering requires an updated WASM renderer.");
  }
  return processor.add_drill_layer(content);
}

export function normalizeParseOptions(options = {}) {
  return {
    preserveArcRegions: options.preserveArcRegions !== false,
    arcTessellationQuality: numberOrDefault(
      options.arcTessellationQuality,
      DEFAULT_ARC_TESSELLATION_QUALITY,
    ),
  };
}

export function normalizeLayerList(layers) {
  if (layers == null) {
    return [];
  }
  if (typeof FileList !== "undefined" && layers instanceof FileList) {
    return Array.from(layers);
  }
  return Array.isArray(layers) ? layers : [layers];
}

export async function renderLayersBestEffort(renderer, layers, options = {}) {
  const layerErrorMode = options.layerErrorMode || "skip";
  if (layerErrorMode !== "skip" && layerErrorMode !== "throw") {
    throw new TypeError("layerErrorMode must be 'skip' or 'throw'.");
  }

  const failures = [];
  let renderedCount = 0;

  for (const layer of layers) {
    try {
      const layerId = await renderer.renderLayer(layer);
      if (layerId != null) {
        renderedCount += 1;
      }
    } catch (error) {
      const failure = {
        layer,
        name: getLayerFailureName(layer),
        error,
      };
      failures.push(failure);
      if (typeof options.onLayerError === "function") {
        options.onLayerError(failure);
      }
      if (layerErrorMode === "throw") {
        throw error;
      }
    }
  }

  if (renderedCount === 0 && failures.length > 0) {
    throw failures[0].error;
  }

  return { renderedCount, failures };
}

export async function loadLayersBestEffort(renderer, layers, options = {}) {
  const layerErrorMode = options.layerErrorMode || "skip";
  if (layerErrorMode !== "skip" && layerErrorMode !== "throw") {
    throw new TypeError("layerErrorMode must be 'skip' or 'throw'.");
  }

  const { layerErrorMode: _mode, onLayerError, ...layerOptions } = options;
  const failures = [];
  const preparedLayers = [];

  for (const layer of layers) {
    try {
      const preparedLayer = await renderer.loadLayer(layer, layerOptions);
      if (preparedLayer) {
        preparedLayers.push(preparedLayer);
      }
    } catch (error) {
      const failure = {
        layer,
        name: getLayerFailureName(layer),
        error,
      };
      failures.push(failure);
      if (typeof onLayerError === "function") {
        onLayerError(failure);
      }
      if (layerErrorMode === "throw") {
        throw error;
      }
    }
  }

  if (preparedLayers.length === 0 && failures.length > 0) {
    throw failures[0].error;
  }

  return {
    layers: preparedLayers,
    loadedCount: preparedLayers.length,
    failures,
  };
}

export function normalizeLayer(layer, layerOptions = {}, options = {}) {
  if (options.allowPathConfig && isPathLayerConfig(layer)) {
    const { path, ...inlineOptions } = layer;
    return {
      source: { path },
      options: { ...inlineOptions, ...layerOptions },
    };
  }
  if (isLayerConfig(layer)) {
    const { source, ...inlineOptions } = layer;
    if (source == null) {
      throw new TypeError("Layer config requires a source.");
    }
    return {
      source,
      options: { ...inlineOptions, ...layerOptions },
    };
  }

  return {
    source: layer,
    options: { ...layerOptions },
  };
}

export function normalizeLayerKind(kind, source, name = "", content = "") {
  if (kind == null || kind === "") {
    return isDrillSource(source, name, content) ? LAYER_KIND_DRILL : LAYER_KIND_GERBER;
  }

  const normalized = String(kind).toLowerCase();
  if (normalized === LAYER_KIND_GERBER || normalized === LAYER_KIND_DRILL) {
    return normalized;
  }
  throw new TypeError("Layer kind must be 'gerber' or 'drill'.");
}

export function isDrillLayerKind(kind) {
  return kind === LAYER_KIND_DRILL;
}

export function isDrillSource(source, name = "", content = "") {
  const sourceName = getSourceName(source);
  const hasDrillPath = (name && isDrillPath(name)) || (sourceName && isDrillPath(sourceName));
  const hasAmbiguousDrdPath =
    (name && isAmbiguousDrdPath(name)) || (sourceName && isAmbiguousDrdPath(sourceName));
  const hasSourcePath = Boolean(sourceName || (name && hasFileExtension(name)));
  return Boolean(
    hasDrillPath || ((!hasSourcePath || hasAmbiguousDrdPath) && looksLikeDrillContent(content)),
  );
}

export function isDrillPath(path) {
  const normalized = String(path).toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex >= 0 && DRILL_FILE_EXTENSIONS.has(normalized.slice(dotIndex));
}

function isAmbiguousDrdPath(path) {
  const normalized = String(path).toLowerCase();
  return normalized.endsWith(".drd");
}

function hasFileExtension(path) {
  const fileName = fileBasename(String(path));
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 && dotIndex < fileName.length - 1;
}

export function looksLikeDrillContent(content) {
  const lines = String(content ?? "")
    .split(/\r?\n/, 80)
    .map((line) => line.trim().toUpperCase());
  if (lines.some((line) => line === "M48")) {
    return true;
  }
  const hasToolDeclaration = lines.some((line) => /^T\d+C[+\-.\d]+/.test(line));
  const hasDrillCommand = lines.some((line) =>
    /^(METRIC|INCH|M71|M72|G05|G90|G91|ICI,ON|ICI,OFF)\b/.test(line),
  );
  return hasToolDeclaration && hasDrillCommand;
}

export function resolveDrillRenderColors(background) {
  const { fill, hasBackground } = normalizeDrillFillColor(background);
  return {
    fill,
    outline: [1 - fill[0], 1 - fill[1], 1 - fill[2]],
    hasBackground,
  };
}

export function parseDrillLayerPayload(wasmModule, content, offsetX, offsetY) {
  if (typeof wasmModule.parse_drill_layer !== "function") {
    throw new Error("Drill parsing requires an updated WASM renderer.");
  }
  const payload = wasmModule.parse_drill_layer(content, offsetX, offsetY);
  const outlineLayer = payload?.outlineLayer;
  const fillLayer = payload?.fillLayer;
  if (!outlineLayer || !fillLayer) {
    throw new Error("Drill parsing did not return renderable layers.");
  }
  const bounds = mergeBounds(
    payloadBounds(outlineLayer),
    payloadBounds(fillLayer),
  );
  if (!bounds) {
    throw new Error("File does not contain valid drill data (no holes found)");
  }
  return {
    outlineLayer,
    fillLayer,
    metadata: payload.metadata ?? null,
    bounds,
  };
}

export async function sourceToText(source, options = {}) {
  const {
    fileUrlToPath,
    readPathText,
    sourceDescription = "a string, File, Blob, ArrayBuffer, or Uint8Array",
  } = options;

  if (typeof source === "string") {
    return source;
  }
  if (source instanceof URL && typeof readPathText === "function") {
    return readPathText(fileUrlToPath ? fileUrlToPath(source) : source.pathname);
  }
  if (
    source &&
    typeof source === "object" &&
    "path" in source &&
    typeof readPathText === "function"
  ) {
    return readPathText(String(source.path));
  }
  if (isBlob(source)) {
    return source.text();
  }
  if (source instanceof ArrayBuffer) {
    return new TextDecoder().decode(source);
  }
  if (ArrayBuffer.isView(source)) {
    return new TextDecoder().decode(
      source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength),
    );
  }

  throw new TypeError(`Layer source must be ${sourceDescription}.`);
}

export function getSourceName(source) {
  if (source && typeof source === "object" && "name" in source) {
    return String(source.name);
  }
  if (source && typeof source === "object" && "path" in source) {
    return fileBasename(String(source.path));
  }
  if (source instanceof URL && source.protocol === "file:") {
    return fileBasename(source.pathname);
  }
  return "";
}

export function getLayerFailureName(layer) {
  if (layer && typeof layer === "object") {
    if ("name" in layer && layer.name) {
      return String(layer.name);
    }
    if ("path" in layer) {
      return fileBasename(String(layer.path));
    }
    if ("source" in layer) {
      return getSourceName(layer.source);
    }
  }
  return getSourceName(layer) || "Layer";
}

export function payloadBounds(payload) {
  const sublayers = Array.from(payload?.sublayers ?? []);
  let bounds = null;
  for (const sublayer of sublayers) {
    bounds = mergeBounds(bounds, boundaryToPlainObject(sublayer.boundary));
  }
  return bounds;
}

export function resolveFrameView(frameOptions, bounds, width, height) {
  let view;
  if (frameOptions.view) {
    view = {
      zoomX: finiteOrThrow(frameOptions.view.zoomX, "view.zoomX"),
      zoomY: finiteOrThrow(frameOptions.view.zoomY, "view.zoomY"),
      offsetX: finiteOrThrow(frameOptions.view.offsetX, "view.offsetX"),
      offsetY: finiteOrThrow(frameOptions.view.offsetY, "view.offsetY"),
    };
    return applyFrameFlip(view, frameOptions);
  }

  if (frameOptions.fit === false) {
    view = { zoomX: 1, zoomY: 1, offsetX: 0, offsetY: 0 };
    return applyFrameFlip(view, frameOptions);
  }

  if (!bounds) {
    throw new Error("Cannot fit an empty Gerber frame.");
  }

  view = calculateFitView(bounds, width, height, frameOptions.padding);
  return applyFrameFlip(view, frameOptions);
}

export function boundaryToPlainObject(boundary) {
  return {
    minX: readBoundaryNumber(boundary, "min_x", "minX"),
    maxX: readBoundaryNumber(boundary, "max_x", "maxX"),
    minY: readBoundaryNumber(boundary, "min_y", "minY"),
    maxY: readBoundaryNumber(boundary, "max_y", "maxY"),
  };
}

export function readBoundaryNumber(boundary, snakeName, camelName) {
  const value = boundary[snakeName] ?? boundary[camelName];
  return Number(typeof value === "function" ? value.call(boundary) : value);
}

export function mergeBounds(first, second) {
  if (!second) return first;
  if (!first) return { ...second };
  return {
    minX: Math.min(first.minX, second.minX),
    maxX: Math.max(first.maxX, second.maxX),
    minY: Math.min(first.minY, second.minY),
    maxY: Math.max(first.maxY, second.maxY),
  };
}

export function normalizeColor(color, fallback = DEFAULT_COLORS[0], options = {}) {
  const input = color == null ? fallback : color;
  if (typeof input === "string" && options.allowString) {
    return parseColor(input).slice(0, 3).map((value) => value / 255);
  }
  if (!input || (!Array.isArray(input) && !ArrayBuffer.isView(input))) {
    return fallback == null ? null : [...fallback];
  }
  if (input.length < 3) {
    return fallback == null ? null : [...fallback];
  }
  const fallbackColor = fallback || DEFAULT_COLORS[0];
  return [
    clamp01(numberOrDefault(input[0], fallbackColor[0])),
    clamp01(numberOrDefault(input[1], fallbackColor[1])),
    clamp01(numberOrDefault(input[2], fallbackColor[2])),
  ];
}

export function parseColor(color, allowAlpha = false) {
  if (Array.isArray(color) || ArrayBuffer.isView(color)) {
    if (color.length < 3) {
      throw new TypeError("Color arrays must have at least three channels.");
    }
    return [
      Math.round(clamp01(color[0]) * 255),
      Math.round(clamp01(color[1]) * 255),
      Math.round(clamp01(color[2]) * 255),
      Math.round(clamp01(color.length >= 4 ? color[3] : 1) * 255),
    ];
  }

  if (typeof color !== "string") {
    throw new TypeError("Color must be a CSS hex/rgb string or RGBA array.");
  }

  const namedColor = CSS_NAMED_COLORS.get(color.trim().toLowerCase());
  if (namedColor) {
    return [
      namedColor[0],
      namedColor[1],
      namedColor[2],
      allowAlpha ? namedColor[3] : 255,
    ];
  }

  const hex = color.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const value = hex[1];
    if (value.length === 3 || value.length === 4) {
      return [
        parseInt(value[0] + value[0], 16),
        parseInt(value[1] + value[1], 16),
        parseInt(value[2] + value[2], 16),
        value.length === 4 && allowAlpha ? parseInt(value[3] + value[3], 16) : 255,
      ];
    }
    if (value.length === 6 || value.length === 8) {
      return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
        value.length === 8 && allowAlpha ? parseInt(value.slice(6, 8), 16) : 255,
      ];
    }
  }

  const rgb = color
    .trim()
    .match(/^rgba?\(([^,]+),([^,]+),([^,]+)(?:,([^,]+))?\)$/i);
  if (rgb) {
    return [
      parseCssChannel(rgb[1]),
      parseCssChannel(rgb[2]),
      parseCssChannel(rgb[3]),
      rgb[4] && allowAlpha ? Math.round(clamp01(Number(rgb[4])) * 255) : 255,
    ];
  }

  throw new TypeError(`Unsupported color format: ${color}`);
}

export function positiveIntegerOrDefault(value, fallback) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return Math.max(1, Math.round(number));
  }
  return Math.max(1, Math.round(Number(fallback) || 1));
}

export function positiveNumberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function optionalAlpha(value) {
  return value == null ? null : clamp01(value);
}

export function resolveLayerAlpha(layerAlpha, globalAlpha) {
  return layerAlpha == null ? globalAlpha : layerAlpha;
}

export function clamp01(value) {
  return Math.min(1, Math.max(0, numberOrDefault(value, 0)));
}

export function toByte(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

export const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function createPngHeader(width, height, colorType) {
  const header = new Uint8Array(13);
  writeUint32(header, 0, width);
  writeUint32(header, 4, height);
  header[8] = 8;
  header[9] = colorType;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return header;
}

export function pngChunk(type, data) {
  const typeBuffer = asciiBytes(type);
  const payload = data instanceof Uint8Array ? data : new Uint8Array(data);
  const chunk = new Uint8Array(12 + payload.length);
  writeUint32(chunk, 0, payload.length);
  chunk.set(typeBuffer, 4);
  chunk.set(payload, 8);
  writeUint32(chunk, 8 + payload.length, crc32Bytes(typeBuffer, payload));
  return chunk;
}

export function getPngColorType(background) {
  return background && background[3] === 255 ? 2 : 6;
}

export function getPngChannelCount(colorType) {
  return colorType === 2 ? 3 : 4;
}

export function getPngRowStride(width, channels = 4) {
  return 1 + width * channels;
}

export async function writeBlankPngRows(
  writeRow,
  width,
  height,
  tileHeight,
  background,
  channels,
) {
  const rowStride = getPngRowStride(width, channels);
  const band = new Uint8Array(rowStride * tileHeight);
  if (background) {
    fillBandBackground(band, width, tileHeight, rowStride, background, channels);
  }
  for (let y = 0; y < height; y += tileHeight) {
    const currentTileHeight = Math.min(tileHeight, height - y);
    await writeRow(band.subarray(0, currentTileHeight * rowStride));
  }
}

export async function writePixelRowsToPngRows(
  writeRow,
  pixels,
  width,
  rowCount,
  rowStride,
  background,
  channels,
) {
  const band = new Uint8Array(rowStride * rowCount);
  const sourceRowBytes = width * 4;
  for (let y = 0; y < rowCount; y += 1) {
    const rowStart = y * rowStride;
    band[rowStart] = 0;
    const sourceStart = (rowCount - 1 - y) * sourceRowBytes;
    if (background) {
      if (channels === 3) {
        writeOpaqueBackgroundRgbRow(
          band,
          rowStart + 1,
          pixels,
          sourceStart,
          sourceRowBytes,
          background,
        );
      } else {
        writeOpaqueBackgroundRgbaRow(
          band,
          rowStart + 1,
          pixels,
          sourceStart,
          sourceRowBytes,
          background,
        );
      }
    } else {
      copyPremultipliedRowToPng(band, rowStart + 1, pixels, sourceStart, sourceRowBytes);
    }
  }
  await writeRow(band);
}

export function fillBandBackground(band, width, height, rowStride, background, channels) {
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowStride;
    band[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * channels;
      band[offset] = background[0];
      band[offset + 1] = background[1];
      band[offset + 2] = background[2];
      if (channels === 4) {
        band[offset + 3] = background[3];
      }
    }
  }
}

export function writeOpaqueBackgroundRgbaRow(
  output,
  outputOffset,
  source,
  sourceOffset,
  byteLength,
  background,
) {
  if (background[3] !== 255) {
    compositePremultipliedRowBackground(
      output,
      outputOffset,
      source,
      sourceOffset,
      byteLength,
      background,
    );
    return;
  }

  const bgR = background[0];
  const bgG = background[1];
  const bgB = background[2];
  if (bgR === 0 && bgG === 0 && bgB === 0) {
    for (let offset = 0; offset < byteLength; offset += 4) {
      const target = outputOffset + offset;
      output[target] = source[sourceOffset + offset];
      output[target + 1] = source[sourceOffset + offset + 1];
      output[target + 2] = source[sourceOffset + offset + 2];
      output[target + 3] = 255;
    }
    return;
  }

  for (let offset = 0; offset < byteLength; offset += 4) {
    const srcA = source[sourceOffset + offset + 3];
    const inverseA = 255 - srcA;
    const target = outputOffset + offset;
    output[target] = source[sourceOffset + offset] + Math.round((bgR * inverseA) / 255);
    output[target + 1] = source[sourceOffset + offset + 1] + Math.round((bgG * inverseA) / 255);
    output[target + 2] = source[sourceOffset + offset + 2] + Math.round((bgB * inverseA) / 255);
    output[target + 3] = 255;
  }
}

export function writeOpaqueBackgroundRgbRow(
  output,
  outputOffset,
  source,
  sourceOffset,
  byteLength,
  background,
) {
  const bgR = background[0];
  const bgG = background[1];
  const bgB = background[2];
  if (bgR === 0 && bgG === 0 && bgB === 0) {
    for (let offset = 0, target = outputOffset; offset < byteLength; offset += 4, target += 3) {
      output[target] = source[sourceOffset + offset];
      output[target + 1] = source[sourceOffset + offset + 1];
      output[target + 2] = source[sourceOffset + offset + 2];
    }
    return;
  }

  for (let offset = 0, target = outputOffset; offset < byteLength; offset += 4, target += 3) {
    const srcA = source[sourceOffset + offset + 3];
    const inverseA = 255 - srcA;
    output[target] = source[sourceOffset + offset] + Math.round((bgR * inverseA) / 255);
    output[target + 1] = source[sourceOffset + offset + 1] + Math.round((bgG * inverseA) / 255);
    output[target + 2] = source[sourceOffset + offset + 2] + Math.round((bgB * inverseA) / 255);
  }
}

export function copyPremultipliedRowToPng(
  output,
  outputOffset,
  source,
  sourceOffset,
  byteLength,
) {
  for (let offset = 0; offset < byteLength; offset += 4) {
    const srcA = source[sourceOffset + offset + 3];
    const target = outputOffset + offset;
    output[target + 3] = srcA;
    if (srcA === 0) {
      output[target] = 0;
      output[target + 1] = 0;
      output[target + 2] = 0;
    } else if (srcA === 255) {
      output[target] = source[sourceOffset + offset];
      output[target + 1] = source[sourceOffset + offset + 1];
      output[target + 2] = source[sourceOffset + offset + 2];
    } else {
      const scale = 255 / srcA;
      output[target] = toByte(source[sourceOffset + offset] * scale);
      output[target + 1] = toByte(source[sourceOffset + offset + 1] * scale);
      output[target + 2] = toByte(source[sourceOffset + offset + 2] * scale);
    }
  }
}

export function compositePremultipliedRowBackground(
  output,
  outputOffset,
  source,
  sourceOffset,
  byteLength,
  background,
) {
  const bgA = background[3] / 255;
  for (let offset = 0; offset < byteLength; offset += 4) {
    const srcR = source[sourceOffset + offset] / 255;
    const srcG = source[sourceOffset + offset + 1] / 255;
    const srcB = source[sourceOffset + offset + 2] / 255;
    const srcAByte = source[sourceOffset + offset + 3];
    const srcA = srcAByte / 255;
    const outA = srcA + bgA * (1 - srcA);
    const target = outputOffset + offset;
    if (outA <= 0) {
      output[target] = 0;
      output[target + 1] = 0;
      output[target + 2] = 0;
      output[target + 3] = 0;
      continue;
    }
    output[target] = toByte(
      ((srcR + (background[0] / 255) * bgA * (1 - srcA)) / outA) * 255,
    );
    output[target + 1] = toByte(
      ((srcG + (background[1] / 255) * bgA * (1 - srcA)) / outA) * 255,
    );
    output[target + 2] = toByte(
      ((srcB + (background[2] / 255) * bgA * (1 - srcA)) / outA) * 255,
    );
    output[target + 3] = toByte(outA * 255);
  }
}

function writeUint32(output, offset, value) {
  output[offset] = (value >>> 24) & 0xff;
  output[offset + 1] = (value >>> 16) & 0xff;
  output[offset + 2] = (value >>> 8) & 0xff;
  output[offset + 3] = value & 0xff;
}

function asciiBytes(value) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0x7f;
  }
  return bytes;
}

let crcTable = null;

function crc32Bytes(first, second) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }

  let c = 0xffffffff;
  for (const bytes of [first, second]) {
    for (const byte of bytes) {
      c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function toUrl(value) {
  return value instanceof URL ? value : new URL(String(value), import.meta.url);
}

function isPathLayerConfig(value) {
  return (
    value &&
    typeof value === "object" &&
    "path" in value &&
    !("source" in value)
  );
}

function isLayerConfig(value) {
  return (
    value &&
    typeof value === "object" &&
    "source" in value &&
    !isBlob(value) &&
    !isArrayBufferLike(value)
  );
}

function normalizeDrillFillColor(background) {
  if (background == null) {
    return { fill: [0, 0, 0], hasBackground: false };
  }
  try {
    const color = parseColor(background, true);
    const fill = color.slice(0, 3).map((value) => value / 255);
    if (color[3] !== 255) {
      return { fill, hasBackground: false };
    }
    return { fill, hasBackground: true };
  } catch (_error) {
    return { fill: [0, 0, 0], hasBackground: false };
  }
}

function isBlob(value) {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function isArrayBufferLike(value) {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function calculateFitView(bounds, width, height, padding) {
  const minX = Number(bounds.minX);
  const maxX = Number(bounds.maxX);
  const minY = Number(bounds.minY);
  const maxY = Number(bounds.maxY);
  if (![minX, maxX, minY, maxY].every(Number.isFinite)) {
    throw new Error("Cannot fit Gerber layer because bounds are invalid.");
  }

  const boundsWidth = Math.max(0, maxX - minX);
  const boundsHeight = Math.max(0, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const aspect = width / height;
  const viewWidth = aspect > 1 ? 2 * aspect : 2;
  const viewHeight = aspect > 1 ? 2 : 2 / aspect;
  const usableWidth = viewWidth * Math.max(1, width - padding * 2) / width;
  const usableHeight = viewHeight * Math.max(1, height - padding * 2) / height;

  let zoom = 2;
  if (boundsWidth > 0 && boundsHeight > 0) {
    zoom = Math.min(usableWidth / boundsWidth, usableHeight / boundsHeight);
  } else if (boundsWidth > 0) {
    zoom = usableWidth / boundsWidth;
  } else if (boundsHeight > 0) {
    zoom = usableHeight / boundsHeight;
  }

  return {
    zoomX: zoom,
    zoomY: zoom,
    offsetX: -centerX * zoom,
    offsetY: -centerY * zoom,
  };
}

function applyFrameFlip(view, frameOptions) {
  return {
    zoomX: frameOptions.flipX ? -view.zoomX : view.zoomX,
    zoomY: frameOptions.flipY ? -view.zoomY : view.zoomY,
    offsetX: frameOptions.flipX ? -view.offsetX : view.offsetX,
    offsetY: frameOptions.flipY ? -view.offsetY : view.offsetY,
  };
}

function parseCssChannel(value) {
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) {
    return Math.round(clamp01(Number(trimmed.slice(0, -1)) / 100) * 255);
  }
  return Math.min(255, Math.max(0, Math.round(Number(trimmed))));
}

function finiteOrThrow(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${name} must be finite.`);
  }
  return number;
}

function fileBasename(path) {
  const cleanPath = String(path).replace(/\\/g, "/");
  const name = cleanPath.slice(cleanPath.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name);
  } catch (_error) {
    return name;
  }
}
