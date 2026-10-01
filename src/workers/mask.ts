import { parentPort } from "node:worker_threads";
import sharp from "sharp";
import { MAX_PIXELS } from "../editor/model/document";
import {
  selectionSchema,
  maskEditSchema,
  type MaskSelection,
  type MaskEdit,
  type TrimBounds,
} from "../editor/model/mask";

async function decode(bytes: Uint8Array) {
  if (bytes.length > 128 * 1024 * 1024) throw Error("Image exceeds 128 MB");
  const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" });
  const meta = await image.metadata();
  if (
    meta.format !== "png" ||
    !meta.width ||
    !meta.height ||
    meta.width > 12000 ||
    meta.height > 12000 ||
    (meta.pages ?? 1) !== 1
  )
    throw Error("Expected a bounded PNG image");
  return image
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}
async function alpha(bytes: Uint8Array, width: number, height: number) {
  const { data, info } = await decode(bytes);
  if (info.width !== width || info.height !== height)
    throw Error("Mask dimensions do not match the image");
  const result = Buffer.alloc(width * height);
  for (let i = 0; i < result.length; i++) result[i] = data[i * 4 + 3];
  return result;
}
async function encode(a: Uint8Array, width: number, height: number) {
  const rgba = Buffer.alloc(a.length * 4, 255);
  for (let i = 0; i < a.length; i++) rgba[i * 4 + 3] = a[i];
  return {
    bytes: await sharp(rgba, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer(),
    width,
    height,
  };
}
async function soften(
  a: Buffer,
  width: number,
  height: number,
  radius: number,
) {
  if (!radius) return a;
  // Mask edges use libvips' edge extension, so a fully restored mask stays opaque.
  return sharp(a, { raw: { width, height, channels: 1 } })
    .blur(Math.max(0.3, radius))
    .greyscale()
    .raw()
    .toBuffer();
}
export async function createSelection(
  source: Uint8Array,
  input: MaskSelection,
) {
  const selection = selectionSchema.parse(input);
  const {
    data,
    info: { width, height },
  } = await decode(source);
  let a = Buffer.alloc(width * height);
  if (selection.kind === "wand") {
    const x = Math.floor(selection.point.x),
      y = Math.floor(selection.point.y);
    if (x < 0 || y < 0 || x >= width || y >= height)
      throw Error("Click inside the image");
    const seed = y * width + x,
      at = seed * 4;
    // Compare premultiplied colour plus alpha; hidden RGB does not affect selection.
    const sample = [0, 1, 2].map((c) => (data[at + c] * data[at + 3]) / 255);
    const match = (i: number) => {
      const offset = i * 4,
        opacity = data[offset + 3];
      return (
        Math.abs(opacity - data[at + 3]) <= selection.tolerance &&
        sample.every(
          (value, c) =>
            Math.abs((data[offset + c] * opacity) / 255 - value) <=
            selection.tolerance,
        )
      );
    };
    if (!selection.contiguous) {
      for (let i = 0; i < a.length; i++) if (match(i)) a[i] = 255;
    } else {
      const seen = new Uint8Array(a.length),
        queue = new Int32Array(a.length);
      let read = 0,
        write = 1;
      queue[0] = seed;
      seen[seed] = 1;
      const visit = (i: number) => {
        if (!seen[i]) {
          seen[i] = 1;
          if (match(i)) queue[write++] = i;
        }
      };
      while (read < write) {
        const i = queue[read++];
        a[i] = 255;
        if (i % width) visit(i - 1);
        if (i % width < width - 1) visit(i + 1);
        if (i >= width) visit(i - width);
        if (i < a.length - width) visit(i + width);
      }
    }
  } else {
    let shape: string;
    if (selection.kind === "rectangle" || selection.kind === "ellipse") {
      const x = Math.min(selection.start.x, selection.end.x),
        y = Math.min(selection.start.y, selection.end.y);
      const w = Math.abs(selection.end.x - selection.start.x),
        h = Math.abs(selection.end.y - selection.start.y);
      if (w < 0.01 || h < 0.01)
        throw Error("Drag a selection with width and height");
      shape =
        selection.kind === "rectangle"
          ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/>`
          : `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="white"/>`;
    } else if (selection.kind === "polygon") {
      shape = `<polygon points="${selection.points.map((p) => `${p.x},${p.y}`).join(" ")}" fill="white" fill-rule="evenodd"/>`;
    } else if (selection.kind === "brush") {
      const points = selection.points;
      shape =
        points.length === 1
          ? `<circle cx="${points[0].x}" cy="${points[0].y}" r="${selection.diameter / 2}" fill="white"/>`
          : `<polyline points="${points.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="white" stroke-width="${selection.diameter}" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else throw Error("Unsupported selection");
    // Only validated numeric geometry is inserted. No external/user SVG is accepted.
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shape}</svg>`,
    );
    const pixels = await sharp(svg, { limitInputPixels: MAX_PIXELS })
      .ensureAlpha()
      .raw()
      .toBuffer();
    for (let i = 0; i < a.length; i++) a[i] = pixels[i * 4 + 3];
  }
  return encode(a, width, height);
}
export async function editMask(
  source: Uint8Array,
  mask: Uint8Array | undefined,
  selection: Uint8Array | undefined,
  input: MaskEdit,
) {
  const edit = maskEditSchema.parse(input);
  const {
    info: { width, height },
  } = await decode(source);
  let a: Buffer = mask
    ? await alpha(mask, width, height)
    : Buffer.alloc(width * height, 255);
  if (edit.action === "reset") a.fill(255);
  else if (edit.action === "invert")
    for (let i = 0; i < a.length; i++) a[i] = 255 - a[i];
  else if (edit.action === "feather")
    a = await soften(a, width, height, edit.feather);
  else {
    if (!selection) throw Error("Selection is unavailable");
    let selected: Buffer = await alpha(selection, width, height);
    if (edit.inverted)
      for (let i = 0; i < selected.length; i++) selected[i] = 255 - selected[i];
    selected = await soften(selected, width, height, edit.feather);
    for (let i = 0; i < a.length; i++) {
      if (edit.action === "remove")
        a[i] = Math.round((a[i] * (255 - selected[i])) / 255);
      else if (edit.action === "restore") a[i] = Math.max(a[i], selected[i]);
      else a[i] = Math.min(a[i], selected[i]);
    }
  }
  return encode(a, width, height);
}
export async function trimBounds(
  bytes: Uint8Array,
): Promise<TrimBounds | null> {
  const {
    data,
    info: { width, height },
  } = await decode(bytes);
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3]) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  return right < 0
    ? null
    : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
parentPort?.on(
  "message",
  async ({ id, kind, source, mask, selection, input }) => {
    try {
      const result =
        kind === "selection"
          ? await createSelection(source, input)
          : kind === "edit"
            ? await editMask(source, mask, selection, input)
            : kind === "trim"
              ? await trimBounds(source)
              : (() => {
                  throw Error("Unknown mask job");
                })();
      parentPort!.postMessage({ id, result });
    } catch (e) {
      parentPort!.postMessage({ id, error: (e as Error).message });
    }
  },
);
