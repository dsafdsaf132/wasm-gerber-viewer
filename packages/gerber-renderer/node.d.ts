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

export type RGBColor = [number, number, number];
export type RGBAColor = [number, number, number, number];

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
};

export type NodeLayerOptions = {
  color?: RGBColor | string;
  alpha?: number;
  offsetX?: number;
  offsetY?: number;
};

export type NodeExportOptions = {
  background?: null | string | RGBAColor;
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

  exportPng(exportOptions?: NodeExportOptions): Promise<Uint8Array>;

  dispose(): void;
}
