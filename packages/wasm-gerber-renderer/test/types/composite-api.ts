import { createWriteStream } from "node:fs";
import {
  createGerberRenderer,
  type CompositeLayerOptions,
  type GerberRenderer,
} from "../../index.js";
import {
  createNodeGerberRenderer,
  type GerberNodePreparedLayer,
  type NodeGerberRenderer,
  type NodePngWritable,
} from "../../node.js";

declare const canvas: HTMLCanvasElement;
declare const firstGerber: string;
declare const secondGerber: string;
declare const outputPath: string;

const nativeWritable: NodePngWritable = createWriteStream(outputPath);
const structuralWritable: NodePngWritable = {
  async write(_chunk: Uint8Array): Promise<void> {},
};

function requireLayerId(value: number | null): number {
  if (value === null) throw new Error("Layer did not render");
  return value;
}

const explicitAreas: CompositeLayerOptions = {
  color: "#00a81c",
  alpha: 0.7,
  visible: true,
  inverted: false,
  visibleAreas: ["10", "11", "00"],
};

async function renderBrowser(renderer: GerberRenderer): Promise<void> {
  await renderer.withFrame({ compositeMode: "stack" }, async () => {
    const first = requireLayerId(
      await renderer.renderLayer(firstGerber, { visible: false }),
    );
    const second = requireLayerId(
      await renderer.renderLayer(secondGerber, { visible: false }),
    );
    await renderer.renderCompositeLayer([first, second], explicitAreas);
    await renderer.renderCompositeLayer([first, second], {
      preset: "difference",
      outlineLayerId: first,
    });
  });
}

async function renderNode(renderer: NodeGerberRenderer): Promise<void> {
  const prepared: GerberNodePreparedLayer = await renderer.loadLayer(firstGerber);
  const skippedDrill: GerberNodePreparedLayer | null = await renderer.loadLayer(
    { source: firstGerber, kind: "drill" },
    { renderDrills: false },
  );
  declareBooleanLoadResult(
    await renderer.loadLayer(firstGerber, {
      renderDrills: Boolean(firstGerber.length),
    }),
  );
  void prepared;
  void skippedDrill;
  await renderer.withFrame({ compositeMode: "blend" }, async () => {
    const first = requireLayerId(
      await renderer.renderLayer(firstGerber, { visible: false }),
    );
    const second = requireLayerId(
      await renderer.renderLayer(secondGerber, { visible: false }),
    );
    await renderer.renderCompositeLayer([first, second], explicitAreas);
  });
  await renderer.exportPngStream(nativeWritable);
  await renderer.exportPngStream(structuralWritable);
}

function declareBooleanLoadResult(
  _value: GerberNodePreparedLayer | null,
): void {}

void createGerberRenderer(canvas).then(renderBrowser);
void createNodeGerberRenderer().then(renderNode);
