export type GerberSource =
  | File
  | string
  | Blob
  | ArrayBuffer
  | Uint8Array;

export type GerberLayer =
  | GerberSource
  | {
      source: GerberSource;
      name?: string;
      color?: RGBColor;
      alpha?: number;
      offsetX?: number;
      offsetY?: number;
    };

export type RGBColor = [number, number, number];
export type RGBAColor = [number, number, number, number];

export type RendererOptions = {
  wasmModule?: unknown;
  wasmModuleUrl?: string | URL;
  wasmInitInput?: unknown;
  contextAttributes?: WebGLContextAttributes;
  releaseContext?: boolean;
};

export type FrameOptions = {
  width?: number;
  height?: number;
  clear?: boolean;
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
  rendererOptions?: RendererOptions;
};

export type LayerOptions = {
  color?: RGBColor;
  alpha?: number;
  offsetX?: number;
  offsetY?: number;
};

export type ExportOptions = {
  type?: "image/png" | string;
  quality?: number;
  background?: null | string | RGBAColor;
};

export type GerberCanvas = HTMLCanvasElement;

export declare function createGerberRenderer(
  canvas: GerberCanvas,
  rendererOptions?: RendererOptions,
): Promise<GerberRenderer>;

export declare function renderGerberToCanvas(
  canvas: GerberCanvas,
  layers: GerberLayer | GerberLayer[] | FileList,
  frameOptions?: FrameOptions,
): Promise<void>;

export declare function renderGerberToPng(
  canvas: GerberCanvas,
  layers: GerberLayer | GerberLayer[] | FileList,
  frameOptions?: FrameOptions,
  exportOptions?: ExportOptions,
): Promise<Blob>;

export declare class GerberRenderer {
  withFrame(
    frameOptions: FrameOptions,
    callback: () => void | Promise<void>,
  ): Promise<void>;

  renderLayer(layer: GerberLayer, layerOptions?: LayerOptions): Promise<number>;

  exportPng(exportOptions?: ExportOptions): Promise<Blob>;

  dispose(): void;
}
