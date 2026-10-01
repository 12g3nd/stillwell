import { SaxesParser } from "saxes";
import { initializeCanvas, readPsd } from "ag-psd";
import sharp from "sharp";
import { MAX_PIXELS } from "../editor/model/document";

// Geometry only. Reject unsupported constructs instead of silently stripping them.
export function validateSvg(input: Uint8Array) {
  if (input.length > 2 * 1024 * 1024) throw Error("SVG exceeds the 2 MB limit");
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(input);
  const tags = new Set([
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "title",
    "desc",
  ]);
  const attrs = new Set([
    "xmlns",
    "width",
    "height",
    "viewBox",
    "preserveAspectRatio",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "d",
    "points",
    "transform",
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "fill-rule",
    "clip-rule",
    "opacity",
    "fill-opacity",
    "stroke-opacity",
    "id",
    "version",
  ]);
  let count = 0,
    depth = 0;
  const parser = new SaxesParser();
  const reject = () => {
    throw Error(
      "SVG supports geometry only: no scripts, links, styles, images, text, filters or external resources",
    );
  };
  parser.on("doctype", reject);
  parser.on("processinginstruction", reject);
  parser.on("opentag", (tag) => {
    if (++count > 20000 || ++depth > 32 || !tags.has(tag.name)) reject();
    if (count === 1 && tag.name !== "svg") reject();
    for (const [name, value] of Object.entries(tag.attributes)) {
      if (!attrs.has(name) || /url|[\\<>]/i.test(value as string)) reject();
      if (name === "xmlns" && value !== "http://www.w3.org/2000/svg") reject();
      if (
        (name === "fill" || name === "stroke") &&
        !/^(#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\))$/i.test(value as string)
      )
        reject();
    }
  });
  parser.on("closetag", () => {
    depth--;
  });
  parser.write(xml).close();
  if (!count) reject();
}

export async function compatibleInput(input: Buffer): Promise<Buffer> {
  if (input.subarray(0, 4).toString() === "8BPS") {
    if (
      input.length < 26 ||
      input.readUInt16BE(4) !== 1 ||
      input.readUInt16BE(22) !== 8 ||
      input.readUInt16BE(24) !== 3
    )
      throw Error(
        "PSD import supports flattened 8-bit RGB PSD files only; PSB, CMYK and higher bit depths are unsupported",
      );
    const height = input.readUInt32BE(14),
      width = input.readUInt32BE(18);
    if (
      !width ||
      !height ||
      width > 12000 ||
      height > 12000 ||
      width * height > MAX_PIXELS
    )
      throw Error("PSD exceeds the 12,000-side / 24 megapixel limit");
    initializeCanvas(
      () => {
        throw Error("PSD canvas allocation is unsupported");
      },
      (w, h) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
        colorSpace: "srgb",
      }),
    );
    const psd = readPsd(input, {
      useImageData: true,
      skipLayerImageData: true,
      skipThumbnail: true,
    });
    const data = psd.imageData;
    if (
      !data ||
      !(data.data instanceof Uint8ClampedArray) ||
      data.width !== width ||
      data.height !== height
    )
      throw Error(
        "PSD needs an 8-bit saved composite; save with Maximize Compatibility enabled",
      );
    return sharp(data.data, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
  }
  // SVG must pass validation before any native decoder sees it. Other XML and
  // compressed SVG are rejected by the explicit format check in the worker.
  const lead = input
    .subarray(0, 1024)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (lead.startsWith("<")) {
    validateSvg(input);
    return input;
  }
  if (input.length >= 12 && input.subarray(4, 8).toString() === "ftyp")
    throw Error(
      "HEIC/HEIF and AVIF are not enabled. Convert a copy to PNG, JPEG or TIFF first; keep your original.",
    );
  const signature = input.subarray(0, 4).toString("hex");
  if (!(
    signature === "89504e47" ||
    signature.startsWith("ffd8ff") ||
    signature === "49492a00" ||
    signature === "4d4d002a" ||
    (input.subarray(0, 4).toString() === "RIFF" &&
      input.subarray(8, 12).toString() === "WEBP")
  ))
    throw Error(
      "Choose PNG, JPEG, WebP, static TIFF, geometry SVG or flattened RGB PSD",
    );
  return input;
}
