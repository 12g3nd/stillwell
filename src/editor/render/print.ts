import { StaticCanvas, FabricImage } from "fabric";
import { composite, project, type Assets } from "./adapter";
import { flattenLayers, type PhotoDocument } from "../model/document";
import { fontAlias } from "./fonts";

export function vectorPrintSupported(doc: PhotoDocument) {
  return flattenLayers(doc.layers).every(
    (l) =>
      l.kind !== "group" &&
      (!l.blend || l.blend === "source-over") &&
      (l.kind !== "text" || (!l.shadow && !l.curve && !l.warp?.amount)),
  );
}
export async function printSvg(doc: PhotoDocument, assets: Assets) {
  const canvas = new StaticCanvas(undefined, {
    width: doc.width,
    height: doc.height,
    enableRetinaScaling: false,
  });
  try {
    let printDoc = doc,
      printAssets = assets;
    if (!vectorPrintSupported(doc)) {
      const bytes = await composite({ ...doc, border: undefined }, assets);
      printAssets = { ...assets, print: bytes };
      printDoc = {
        ...doc,
        layers: [
          {
            id: "print",
            name: "Print",
            kind: "raster",
            original: "print",
            asset: "print",
            visible: true,
            opacity: 1,
            transform: [1, 0, 0, 1, 0, 0],
          },
        ],
      };
    }
    await project(canvas, printDoc, printAssets);
    for (const object of canvas.getObjects()) {
      if (!(object instanceof FabricImage)) continue;
      const image = document.createElement("canvas");
      image.width = object.width;
      image.height = object.height;
      image.getContext("2d")!.drawImage(object.getElement(), 0, 0);
      const data = image.toDataURL("image/png");
      object.getSrc = () => data;
    }
    const svg = new DOMParser().parseFromString(
      canvas.toSVG({ suppressPreamble: true }),
      "image/svg+xml",
    );
    const style = svg.createElementNS("http://www.w3.org/2000/svg", "style");
    for (const layer of flattenLayers(printDoc.layers)) {
      if (layer.kind !== "text") continue;
      let source: string;
      if (layer.fontAsset) {
        const bytes = assets[layer.fontAsset];
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        source = `url("data:font/ttf;base64,${btoa(binary)}")`;
      } else
        source = `local(${JSON.stringify(layer.fontPostscript ?? layer.fontFamily)})`;
      style.textContent += `@font-face { font-family: "${fontAlias(layer)}"; src: ${source}; }\n`;
    }
    svg.documentElement.prepend(style);
    return new XMLSerializer().serializeToString(svg);
  } finally {
    await canvas.dispose();
  }
}
