import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { createSelection, editMask, trimBounds } from "../src/workers/mask";
import { selectionSchema, maskEditSchema } from "../src/editor/model/mask";
const source = (width = 32, height = 24) =>
  sharp({ create: { width, height, channels: 4, background: "#cd5428" } })
    .png()
    .toBuffer();
async function pixels(bytes: Uint8Array) {
  return sharp(bytes).ensureAlpha().raw().toBuffer();
}
const opacity = (bytes: Buffer, x: number, y: number, width = 32) =>
  bytes[(y * width + x) * 4 + 3];
test("mask shapes, brush restore and inversion preserve source bytes", async () => {
  const image = await source(),
    original = Buffer.from(image);
  const rect = await createSelection(image, {
    kind: "rectangle",
    start: { x: 8, y: 6 },
    end: { x: 24, y: 18 },
  });
  let result = await editMask(image, undefined, rect.bytes, {
    action: "keep",
    selection: "a".repeat(64),
  });
  let raw = await pixels(result.bytes);
  expect(opacity(raw, 8, 6)).toBe(255);
  expect(opacity(raw, 7, 6)).toBe(0);
  const brush = await createSelection(image, {
    kind: "brush",
    points: [
      { x: 2, y: 12 },
      { x: 12, y: 12 },
    ],
    diameter: 4,
  });
  result = await editMask(image, result.bytes, brush.bytes, {
    action: "restore",
    selection: "a".repeat(64),
  });
  raw = await pixels(result.bytes);
  expect(opacity(raw, 3, 12)).toBe(255);
  expect(opacity(raw, 3, 3)).toBe(0);
  const inverted = await editMask(image, result.bytes, undefined, {
    action: "invert",
  });
  expect(opacity(await pixels(inverted.bytes), 3, 12)).toBe(0);
  const reset = await editMask(image, inverted.bytes, undefined, {
    action: "reset",
  });
  expect(
    (await pixels(reset.bytes)).every((v, i) => i % 4 !== 3 || v === 255),
  ).toBe(true);
  expect(image).toEqual(original);
});
test("ellipse and freehand/polygon selections have correct coverage and antialiasing", async () => {
  const image = await source();
  const ellipse = await createSelection(image, {
    kind: "ellipse",
    start: { x: 4, y: 4 },
    end: { x: 28, y: 20 },
  });
  const raw = await pixels(ellipse.bytes);
  expect(opacity(raw, 16, 12)).toBe(255);
  expect(opacity(raw, 4, 4)).toBe(0);
  expect(raw.some((v, i) => i % 4 === 3 && v > 0 && v < 255)).toBe(true);
  const polygon = await createSelection(image, {
    kind: "polygon",
    points: [
      { x: 4, y: 4 },
      { x: 28, y: 4 },
      { x: 4, y: 20 },
    ],
  });
  const poly = await pixels(polygon.bytes);
  expect(opacity(poly, 6, 6)).toBe(255);
  expect(opacity(poly, 26, 18)).toBe(0);
});
test("feather produces one-channel soft mask coverage; remove and inverted selection use correct alpha", async () => {
  const image = await source();
  const rect = await createSelection(image, {
    kind: "rectangle",
    start: { x: 8, y: 6 },
    end: { x: 24, y: 18 },
  });
  const soft = await editMask(image, undefined, rect.bytes, {
    action: "keep",
    selection: "a".repeat(64),
    feather: 2,
  });
  const raw = await pixels(soft.bytes);
  expect(opacity(raw, 8, 12)).toBeGreaterThan(100);
  expect(opacity(raw, 8, 12)).toBeLessThan(200);
  expect(opacity(raw, 7, 12)).toBeGreaterThan(0);
  expect(opacity(raw, 16, 12)).toBeGreaterThan(250);
  const removed = await editMask(image, undefined, rect.bytes, {
    action: "remove",
    selection: "a".repeat(64),
    feather: 2,
  });
  const opposite = await pixels(removed.bytes);
  for (let i = 3; i < raw.length; i += 4)
    expect(raw[i] + opposite[i]).toBe(255);
  const outside = await editMask(image, undefined, rect.bytes, {
    action: "keep",
    selection: "a".repeat(64),
    inverted: true,
  });
  expect(opacity(await pixels(outside.bytes), 16, 12)).toBe(0);
  const whole = await editMask(image, undefined, undefined, {
    action: "feather",
    feather: 3,
  });
  expect(
    (await pixels(whole.bytes)).every((v, i) => i % 4 !== 3 || v === 255),
  ).toBe(true);
});
test("wand respects tolerance, four-connected regions and source alpha", async () => {
  const raw = Buffer.from([
    255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 245, 0, 0,
    255, 255, 0, 0, 0,
  ]);
  const image = await sharp(raw, { raw: { width: 6, height: 1, channels: 4 } })
    .png()
    .toBuffer();
  const wand = {
    kind: "wand" as const,
    point: { x: 0, y: 0 },
    tolerance: 0,
    contiguous: true,
  };
  const alphas = async (contiguous: boolean, tolerance: number) =>
    Array.from(
      await pixels(
        (await createSelection(image, { ...wand, contiguous, tolerance }))
          .bytes,
      ),
    ).filter((_, i) => i % 4 === 3);
  expect(await alphas(true, 0)).toEqual([255, 255, 0, 0, 0, 0]);
  expect(await alphas(false, 0)).toEqual([255, 255, 0, 255, 0, 0]);
  expect(await alphas(false, 10)).toEqual([255, 255, 0, 255, 255, 0]);
  await expect(
    createSelection(image, { ...wand, point: { x: -1, y: 0 } }),
  ).rejects.toThrow("inside");
});
test("trim keeps alpha 1 edges and reports fully transparent content", async () => {
  const raw = Buffer.alloc(10 * 8 * 4);
  raw[(2 * 10 + 3) * 4 + 3] = 1;
  raw[(5 * 10 + 7) * 4 + 3] = 255;
  const image = await sharp(raw, { raw: { width: 10, height: 8, channels: 4 } })
    .png()
    .toBuffer();
  expect(await trimBounds(image)).toEqual({ x: 3, y: 2, width: 5, height: 4 });
  const empty = await editMask(await source(), undefined, undefined, {
    action: "invert",
  });
  expect(await trimBounds(empty.bytes)).toBeNull();
});
test("mask jobs reject invalid geometry, mismatched masks and unsupported input", async () => {
  expect(
    selectionSchema.safeParse({
      kind: "brush",
      points: [{ x: NaN, y: 0 }],
      diameter: 10,
    }).success,
  ).toBe(false);
  expect(
    selectionSchema.safeParse({
      kind: "polygon",
      points: Array(4097).fill({ x: 0, y: 0 }),
    }).success,
  ).toBe(false);
  expect(maskEditSchema.safeParse({ action: "keep" }).success).toBe(false);
  await expect(
    editMask(await source(), await source(3, 3), undefined, {
      action: "invert",
    }),
  ).rejects.toThrow("dimensions");
  await expect(
    createSelection(Buffer.from("not an image"), {
      kind: "wand",
      point: { x: 0, y: 0 },
      tolerance: 0,
      contiguous: true,
    }),
  ).rejects.toThrow();
});
