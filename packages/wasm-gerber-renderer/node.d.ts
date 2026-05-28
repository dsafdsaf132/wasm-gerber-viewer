export type GerberNodeSource =
  | File
  | string
  | Blob
  | ArrayBuffer
  | Uint8Array
  | URL
  | { path: string };

export type GerberNodeLayer =
  | GerberNodeSource
  | GerberNodePreparedLayer
  | {
      source: GerberNodeSource;
      name?: string;
      color?: RGBColor | string;
      alpha?: number;
      offsetX?: number;
      offsetY?: number;
    }
  | {
      path: string;
      name?: string;
      color?: RGBColor | string;
      alpha?: number;
      offsetX?: number;
      offsetY?: number;
    };

export type NodeLayerBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

declare const preparedLayerBrand: unique symbol;

export type GerberNodePreparedLayer = {
  readonly [preparedLayerBrand]: true;
  readonly name: string;
  readonly sourceName: string;
  readonly bounds: NodeLayerBounds;
  readonly offsetX: number;
  readonly offsetY: number;
};

export type RGBColor = [number, number, number];
export type RGBAColor = [number, number, number, number];
export type PngRenderStrategy = "auto" | "full-frame" | "stream";

export type NodeRendererOptions = {
  wasmModule?: unknown;
  wasmModuleUrl?: string | URL;
  wasmBinaryUrl?: string | URL;
  wasmInitInput?: unknown;
  glesModule?: unknown;
  glesModuleName?: string;
  gl?: unknown;
  contextAttributes?: Record<string, unknown>;
  releaseContext?: boolean;
};

export type NodeFrameOptions = {
  width?: number;
  height?: number;
  clear?: true;
  background?: null | string | RGBAColor;
  fit?: boolean;
  padding?: number;
  flipX?: boolean;
  flipY?: boolean;
  view?: {
    zoomX: number;
    zoomY: number;
    offsetX: number;
    offsetY: number;
  };
  preserveArcRegions?: boolean;
  arcTessellationQuality?: 0 | 1 | 2;
  minimumFeaturePixels?: number;
  globalAlpha?: number;
  maxBandBytes?: number;
  maxFullFrameBytes?: number;
  maxRenderTargetBytes?: number;
  framebufferMemorySafetyFactor?: number;
  strategy?: PngRenderStrategy;
  onLayerError?: (failure: NodeLayerFailure) => void;
  layerErrorMode?: LayerErrorMode;
};

export type LayerErrorMode = "skip" | "throw";

export type NodeLayerFailure = {
  layer: GerberNodeLayer;
  name: string;
  error: unknown;
};

export type NodeLayerOptions = {
  name?: string;
  color?: RGBColor | string;
  alpha?: number;
  offsetX?: number;
  offsetY?: number;
};

export type NodeLayerLoadOptions = NodeLayerOptions & {
  preserveArcRegions?: boolean;
  arcTessellationQuality?: 0 | 1 | 2;
};

export type NodeExportOptions = {
  background?: null | string | RGBAColor;
  maxBandBytes?: number;
  maxFullFrameBytes?: number;
  maxRenderTargetBytes?: number;
  framebufferMemorySafetyFactor?: number;
  strategy?: PngRenderStrategy;
};

export type NodePngWritable = {
  write(
    chunk: Uint8Array,
    callback?: (error?: Error | null) => void,
  ): boolean | void | Promise<void>;
};

export declare function createNodeGerberRenderer(
  rendererOptions?: NodeRendererOptions,
): Promise<NodeGerberRenderer>;

export declare function renderGerberToPngBuffer(
  layers: GerberNodeLayer | GerberNodeLayer[],
  frameOptions?: NodeFrameOptions,
  exportOptions?: NodeExportOptions,
  rendererOptions?: NodeRendererOptions,
): Promise<Uint8Array>;

export declare function renderGerberToPngFile(
  outputPath: string,
  layers: GerberNodeLayer | GerberNodeLayer[],
  frameOptions?: NodeFrameOptions,
  exportOptions?: NodeExportOptions,
  rendererOptions?: NodeRendererOptions,
): Promise<void>;

export declare function renderGerberToPngStream(
  writable: NodePngWritable,
  layers: GerberNodeLayer | GerberNodeLayer[],
  frameOptions?: NodeFrameOptions,
  exportOptions?: NodeExportOptions,
  rendererOptions?: NodeRendererOptions,
): Promise<void>;

export declare function fileLayer(
  path: string,
  options?: Omit<NodeLayerOptions, "path"> & { name?: string },
): GerberNodeLayer;

export declare function packageRoot(): string;

export declare class NodeGerberRenderer {
  withFrame(
    frameOptions: NodeFrameOptions,
    callback: () => void | Promise<void>,
  ): Promise<void>;

  renderLayer(
    layer: GerberNodeLayer,
    layerOptions?: NodeLayerOptions,
  ): Promise<number>;

  renderLayers(
    layers: GerberNodeLayer | GerberNodeLayer[],
    options?: Pick<NodeFrameOptions, "onLayerError" | "layerErrorMode">,
  ): Promise<{ renderedCount: number; failures: NodeLayerFailure[] }>;

  loadLayer(
    layer: GerberNodeLayer,
    layerOptions?: NodeLayerLoadOptions,
  ): Promise<GerberNodePreparedLayer>;

  loadLayers(
    layers: GerberNodeLayer | GerberNodeLayer[],
    options?: NodeLayerLoadOptions &
      Pick<NodeFrameOptions, "onLayerError" | "layerErrorMode">,
  ): Promise<{
    layers: GerberNodePreparedLayer[];
    loadedCount: number;
    failures: NodeLayerFailure[];
  }>;

  exportPng(exportOptions?: NodeExportOptions): Promise<Uint8Array>;

  exportPngStream(
    writable: NodePngWritable,
    exportOptions?: NodeExportOptions,
  ): Promise<void>;

  exportPngFile(outputPath: string, exportOptions?: NodeExportOptions): Promise<void>;

  dispose(): void;
}
