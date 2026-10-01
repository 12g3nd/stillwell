import { test, expect } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { Library } from "../src/main/library";
import { pack, unpack, importPortable } from "../src/main/portable";
import { hashBytes } from "../src/main/project";
import { documentSchema } from "../src/editor/model/document";
import {
  adjustPixels,
  adjustmentSchema,
  neutralAdjustments,
} from "../src/editor/model/adjustments";

test("rolling checkpoints retain 12 saves and named history; portable copy preserves independent versions and assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "photo-portable-")),
    library = new Library(join(root, "first"));
  const bytes = await sharp({
      create: { width: 4, height: 3, channels: 4, background: "#885544" },
    })
      .png()
      .toBuffer(),
    hash = hashBytes(bytes);
  const doc = documentSchema.parse({
    schemaVersion: 2,
    id: randomUUID(),
    name: "Portable fixture",
    width: 4,
    height: 3,
    colourSpace: "srgb",
    layers: [
      {
        id: "image",
        name: "Image",
        kind: "raster",
        original: hash,
        asset: hash,
        visible: true,
        opacity: 1,
        transform: [1, 0, 0, 1, 0, 0],
      },
    ],
  });
  await library.save(doc, { [hash]: bytes });
  const named = await library.checkpoint(doc.id, "First version");
  for (let i = 1; i <= 16; i++)
    await library.save({ ...doc, name: `Version ${i}` }, { [hash]: bytes });
  expect(
    (await library.checkpoints(doc.id)).filter((c) => c.kind === "rolling"),
  ).toHaveLength(12);
  expect((await library.preview(doc.id, named.id)).document.name).toBe(
    "Portable fixture",
  );
  const later = await library.checkpoint(doc.id, "Keep latest");
  await library.restore(doc.id, named.id);
  expect((await library.preview(doc.id, later.id)).document.name).toBe(
    "Version 16",
  );
  const archive = await pack(library, doc.id),
    parsed = unpack(archive);
  expect(archive.subarray(0, 8).toString()).toBe("STILLWL1");
  const legacyArchive = Buffer.from(archive);
  Buffer.from("SJPHOTO1").copy(legacyArchive);
  expect(unpack(legacyArchive).document).toEqual(doc);
  expect(parsed.document).toEqual(doc);
  expect(hashBytes(parsed.assets[hash])).toBe(hash);
  const decode = async (bytes: Uint8Array) => {
    const { info } = await sharp(bytes, {
      limitInputPixels: 24000000,
    }).toBuffer({ resolveWithObject: true });
    return info;
  };
  const second = new Library(join(root, "new-location")),
    copy = await importPortable(second, archive, decode);
  expect(copy.document.id).not.toBe(doc.id);
  expect({ ...copy.document, id: doc.id }).toEqual(doc);
  const copies = await second.checkpoints(copy.document.id);
  const latest = copies.find((c) => c.name === "Keep latest")!;
  expect(
    (await second.preview(copy.document.id, latest.id)).document.name,
  ).toBe("Version 16");
  expect((await second.load(copy.document.id)).assets[hash]).toEqual(bytes);
  expect(copies.find((c) => c.name === "First version")?.created).toBe(
    named.created,
  );
  expect(copies.filter((c) => c.kind === "rolling")).toHaveLength(12);
  const damaged = Buffer.from(archive);
  damaged[damaged.length - 1] ^= 1;
  expect(() => unpack(damaged)).toThrow("checksum");
  expect(() => unpack(archive.subarray(0, archive.length - 1))).toThrow(
    "asset table",
  );
  const badSize = Buffer.from(archive);
  badSize.writeUInt32LE(0xffffffff, 8);
  expect(() => unpack(badSize)).toThrow("metadata size");
  await expect(importPortable(second, damaged, decode)).rejects.toThrow();
  await expect(
    importPortable(second, archive, async () => {
      throw Error("Decode rejected");
    }),
  ).rejects.toThrow("Decode rejected");
  expect(await second.recent()).toHaveLength(1);
});

test("adjustments preserve alpha, neutral pixels and meaningful exposure/colour/levels responses", () => {
  const input = new Uint8Array([
    40, 60, 80, 0, 80, 100, 120, 128, 180, 140, 100, 255,
  ]);
  expect(adjustPixels(input, neutralAdjustments)).toEqual(input);
  const bright = adjustPixels(input, { ...neutralAdjustments, exposure: 1 });
  expect(bright[4]).toBe(111);
  expect(bright[5]).toBe(138);
  const mono = adjustPixels(input, { ...neutralAdjustments, saturation: -100 });
  expect(mono[4]).toBe(mono[5]);
  expect(mono[5]).toBe(mono[6]);
  const warm = adjustPixels(input, { ...neutralAdjustments, temperature: 50 });
  expect(warm[4]).toBeGreaterThan(input[4]);
  expect(warm[6]).toBeLessThan(input[6]);
  for (const key of [
    "brightness",
    "contrast",
    "tint",
    "shadows",
    "midtones",
    "highlights",
    "black",
    "white",
    "gamma",
  ] as const) {
    const value =
      key === "white"
        ? 200
        : key === "gamma"
          ? 2
          : key === "shadows"
            ? 0
            : key === "midtones"
              ? 200
              : key === "highlights"
                ? 240
                : 40;
    const out = adjustPixels(input, { ...neutralAdjustments, [key]: value });
    expect(out).not.toEqual(input);
    expect([out[3], out[7], out[11]]).toEqual([0, 128, 255]);
  }
  expect(
    adjustmentSchema.safeParse({ ...neutralAdjustments, white: 20, black: 30 })
      .success,
  ).toBe(false);
  expect(
    adjustmentSchema.safeParse({ ...neutralAdjustments, exposure: Infinity })
      .success,
  ).toBe(false);
});

test("real adjustment worker preserves dimensions and exact alpha while sharpening", async () => {
  const raw = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      raw[i] = x < 8 ? 30 : 180;
      raw[i + 1] = 90;
      raw[i + 2] = 120;
      raw[i + 3] = (x + y) * 8;
    }
  const bytes = await sharp(raw, {
    raw: { width: 16, height: 16, channels: 4 },
  })
    .png()
    .toBuffer();
  const worker = new Worker(resolve("dist/raster.cjs"));
  try {
    const result: any = await new Promise((res, rej) => {
      worker.once("message", (m) =>
        m.error ? rej(Error(m.error)) : res(m.result),
      );
      worker.once("error", rej);
      worker.postMessage({
        id: "fixture",
        kind: "adjust",
        bytes,
        options: { ...neutralAdjustments, sharpen: 1.5, exposure: 0.4 },
      });
    });
    const out = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
    expect([result.width, result.height]).toEqual([16, 16]);
    expect(out).not.toEqual(raw);
    expect(Array.from(out).filter((_, i) => i % 4 === 3)).toEqual(
      Array.from(raw).filter((_, i) => i % 4 === 3),
    );
    expect(hashBytes(bytes)).toBe(
      hashBytes(
        await sharp(raw, { raw: { width: 16, height: 16, channels: 4 } })
          .png()
          .toBuffer(),
      ),
    );
  } finally {
    await worker.terminate();
  }
});
