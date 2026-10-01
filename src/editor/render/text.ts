import {
  IText,
  Textbox,
  Shadow,
  config,
  StaticCanvas,
  FabricImage,
  FabricObject,
} from "fabric";
import { dimensions, type Deformation } from "./deformation";
import {
  MAX_PIXELS,
  flattenLayers,
  type PhotoDocument,
  type TextLayer,
} from "../model/document";
import { fontFamily } from "./fonts";
config.disableStyleCopyPaste = true;
export async function textObject(
  layer: TextLayer,
  assets: Record<string, Uint8Array>,
) {
  const options = {
    fontFamily: await fontFamily(layer, assets),
    fontSize: layer.fontSize,
    fill: layer.fill,
    fontWeight: layer.fontWeight ?? 400,
    fontStyle: layer.fontStyle ?? "normal",
    underline: layer.underline ?? false,
    lineHeight: layer.lineHeight ?? 1.16,
    charSpacing: ((layer.letterSpacing ?? 0) / layer.fontSize) * 1000,
    textAlign: layer.textAlign ?? "left",
    textBackgroundColor: layer.backgroundColor ?? "",
    stroke: layer.stroke ?? null,
    strokeWidth: layer.stroke ? (layer.strokeWidth ?? 1) : 0,
    paintFirst: "stroke" as const,
    shadow: layer.shadow
      ? new Shadow({ ...layer.shadow, affectStroke: true })
      : undefined,
  };
  const text = layer.wrapWidth
    ? new Textbox(layer.text, { ...options, width: layer.wrapWidth })
    : new IText(layer.text, options);
  if (
    text.width > 12000 ||
    text.height > 12000 ||
    text.width * text.height > MAX_PIXELS
  ) {
    text.dispose();
    throw Error(
      "Text exceeds the supported layer dimensions. Reduce its size or split it into layers.",
    );
  }
  if (layer.curve || layer.warp?.amount) {
    return shapedText(text, layer);
  }
  return text;
}
async function shapedText(text: FabricObject, layer: TextLayer) {
  // Generous effect/italic overhang padding remains transparent and is included
  // in group bounds. Placement still uses the unpadded text's original origin.
  const padding = Math.ceil(
    layer.fontSize +
      (layer.strokeWidth ?? 0) +
      (layer.shadow
        ? layer.shadow.blur * 3 +
          Math.max(
            Math.abs(layer.shadow.offsetX),
            Math.abs(layer.shadow.offsetY),
          )
        : 0) +
      4,
  );
  const settings: Deformation = {
    width: Math.ceil(text.width + padding * 2),
    height: Math.ceil(text.height + padding * 2),
    contentWidth: text.width || 1,
    padding,
    curve: layer.curve ?? 0,
    warp: layer.warp,
  };
  const size = dimensions(settings);
  if (
    settings.width > 12000 ||
    size.height > 12000 ||
    settings.width * size.height > MAX_PIXELS
  ) {
    text.dispose();
    throw Error(
      "Shaped text exceeds the supported layer dimensions. Reduce its size or deformation.",
    );
  }
  const canvas = new StaticCanvas(undefined, {
    width: settings.width,
    height: settings.height,
    enableRetinaScaling: false,
    renderOnAddRemove: false,
  });
  try {
    text.set({
      left: padding,
      top: padding,
      originX: "left",
      originY: "top",
      objectCaching: false,
    });
    canvas.add(text);
    canvas.renderAll();
    const pixels = canvas
      .getContext()
      .getImageData(0, 0, settings.width, settings.height).data;
    const result = await new Promise<{
      width: number;
      height: number;
      left: number;
      top: number;
      pixels: Uint8ClampedArray;
    }>((resolve, reject) => {
      const worker = new Worker(new URL("text-shape.js", document.baseURI));
      const timer = setTimeout(() => {
        worker.terminate();
        reject(Error("Text shaping timed out. Reduce the text size."));
      }, 30000);
      const end = () => {
        clearTimeout(timer);
        worker.terminate();
      };
      worker.onmessage = ({ data }) => {
        end();
        data.error ? reject(Error(data.error)) : resolve(data);
      };
      worker.onerror = () => {
        end();
        reject(Error("Text shaping worker failed."));
      };
      worker.postMessage({ settings, pixels }, [pixels.buffer]);
    });
    const element = document.createElement("canvas");
    element.width = result.width;
    element.height = result.height;
    element
      .getContext("2d")!
      .putImageData(
        new ImageData(
          new Uint8ClampedArray(result.pixels),
          result.width,
          result.height,
        ),
        0,
        0,
      );
    const image = new FabricImage(element) as FabricImage & {
      textOffset: { x: number; y: number };
    };
    image.textOffset = { x: result.left - padding, y: result.top - padding };
    return image;
  } finally {
    await canvas.dispose();
  }
}
export async function validateTypography(
  doc: PhotoDocument,
  assets: Record<string, Uint8Array>,
) {
  for (const layer of flattenLayers(doc.layers))
    if (layer.kind === "text") (await textObject(layer, assets)).dispose();
}
