import { BrowserWindow } from "electron";
import { join } from "node:path";
import { SaxesParser } from "saxes";
import type { PhotoDocument } from "../editor/model/document";

export async function printPdf(
  svg: unknown,
  doc: PhotoDocument,
): Promise<Buffer> {
  if (typeof svg !== "string" || Buffer.byteLength(svg) > 192 * 1024 * 1024)
    throw Error("Invalid or oversized print artwork");
  const parser = new SaxesParser();
  const allowed = new Set([
    "svg",
    "g",
    "defs",
    "style",
    "desc",
    "rect",
    "path",
    "image",
    "text",
    "tspan",
    "clipPath",
  ]);
  let count = 0;
  parser.on("doctype", () => {
    throw Error("Invalid print artwork");
  });
  parser.on("processinginstruction", () => {
    throw Error("Invalid print artwork");
  });
  parser.on("opentag", (tag) => {
    if (
      ++count > 50000 ||
      !allowed.has(tag.name) ||
      (count === 1 && tag.name !== "svg")
    )
      throw Error("Unsupported print artwork");
    for (const [key, value] of Object.entries(tag.attributes)) {
      if (
        /^on/i.test(key) ||
        ((key === "href" || key === "xlink:href") &&
          !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value as string))
      )
        throw Error("External print resources are forbidden");
    }
  });
  parser.write(svg).close();
  if (!count) throw Error("Empty print artwork");
  const dpi = doc.dpi ?? 300;
  if (
    doc.width / dpi < 0.1 ||
    doc.height / dpi < 0.1 ||
    doc.width / dpi > 200 ||
    doc.height / dpi > 200
  )
    throw Error(
      "PDF page sides must be between 0.1 and 200 inches. Adjust print resolution or canvas size.",
    );
  const print = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  print.setMenu(null);
  print.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  print.webContents.on("will-navigate", (e) => e.preventDefault());
  const deadline = setTimeout(() => {
    if (!print.isDestroyed()) print.destroy();
  }, 60000);
  try {
    await print.loadFile(join(__dirname, "print.html"));
    await print.webContents.executeJavaScript(`(async () => {
      const svg = new DOMParser().parseFromString(${JSON.stringify(svg)}, 'image/svg+xml').documentElement;
      svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
      document.body.append(svg);
      const style = document.createElement('style');
      style.textContent = '@page { size: ${doc.width / dpi}in ${doc.height / dpi}in; margin: 0 } html, body { margin: 0; padding: 0; width: ${doc.width / dpi}in; height: ${doc.height / dpi}in; overflow: hidden } svg { display: block }';
      document.head.append(style);
      await document.fonts.ready;
      for (const face of document.fonts) if (face.status === 'error') throw Error('Print font failed to load');
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`);
    if (print.isVisible()) throw Error("Print window must stay hidden");
    return await print.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
  } finally {
    clearTimeout(deadline);
    if (!print.isDestroyed()) print.destroy();
  }
}
