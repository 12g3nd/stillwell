import { composite, project } from "../src/editor/render/adapter";
import { StaticCanvas } from "fabric";
import type { ImportResult } from "../src/editor/model/document";
declare global {
  interface Window {
    proof: {
      render: (input: ImportResult) => Promise<number[]>;
      preview: (input: ImportResult) => Promise<number[]>;
    };
  }
}
window.proof = {
  render: async ({ document, assets }) =>
    Array.from(await composite(document, assets)),
  preview: async ({ document: doc, assets }) => {
    const el = document.createElement("canvas");
    const canvas = new StaticCanvas(el, {
      width: doc.width,
      height: doc.height,
      enableRetinaScaling: false,
    });
    await project(canvas, doc, assets);
    const pixels = Array.from(
      el.getContext("2d")!.getImageData(0, 0, doc.width, doc.height).data,
    );
    await canvas.dispose();
    return pixels;
  },
};
