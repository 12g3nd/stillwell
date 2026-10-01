import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  documentSchema,
  flattenLayers,
  type ImportResult,
} from "../editor/model/document";
import { hashBytes, references } from "./project";
import type { Library } from "./library";
const MAGIC = Buffer.from("STILLWL1");
// Read pre-release archives without changing their contents.
const LEGACY_MAGIC = Buffer.from("SJPHOTO1");
export const PORTABLE_LIMIT = 512 * 1024 * 1024;
const headerSchema = z.object({
  document: documentSchema,
  checkpoints: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        document: documentSchema,
        created: z.string().datetime().optional(),
        kind: z.enum(["named", "rolling"]).optional(),
      }),
    )
    .max(100),
  blobs: z
    .array(
      z.object({
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        size: z
          .number()
          .int()
          .min(1)
          .max(128 * 1024 * 1024),
      }),
    )
    .max(512),
});
export async function pack(library: Library, id: string) {
  const current = await library.load(id),
    assets = { ...current.assets };
  const checkpoints = [];
  for (const c of await library.checkpoints(id)) {
    if (checkpoints.length >= 100)
      throw Error("Portable projects support up to 100 checkpoints.");
    const saved = await library.preview(id, c.id);
    Object.assign(assets, saved.assets);
    checkpoints.push({
      name: c.name,
      created: c.created,
      kind: c.kind,
      document: saved.document,
    });
  }
  const blobs = Object.entries(assets).map(([hash, bytes]) => ({
    hash,
    size: bytes.length,
  }));
  const header = Buffer.from(
    JSON.stringify(
      headerSchema.parse({ document: current.document, checkpoints, blobs }),
    ),
  );
  const size = 12 + header.length + blobs.reduce((n, b) => n + b.size, 0);
  if (header.length > 16 * 1024 * 1024 || size > PORTABLE_LIMIT)
    throw Error("Portable project exceeds the 512 MB limit.");
  const prefix = Buffer.alloc(12);
  MAGIC.copy(prefix);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat(
    [prefix, header, ...blobs.map((b) => Buffer.from(assets[b.hash]))],
    size,
  );
}
export function unpack(bytes: Uint8Array) {
  const input = Buffer.from(bytes);
  if (
    input.length < 12 ||
    input.length > PORTABLE_LIMIT ||
    (!input.subarray(0, 8).equals(MAGIC) &&
      !input.subarray(0, 8).equals(LEGACY_MAGIC))
  )
    throw Error("Invalid portable project.");
  const size = input.readUInt32LE(8);
  if (size > 16 * 1024 * 1024 || size > input.length - 12)
    throw Error("Invalid portable metadata size.");
  const header = headerSchema.parse(
    JSON.parse(input.subarray(12, 12 + size).toString("utf8")),
  );
  const assets: Record<string, Uint8Array> = {};
  let offset = 12 + size;
  for (const blob of header.blobs) {
    if (assets[blob.hash] || offset + blob.size > input.length)
      throw Error("Invalid portable asset table.");
    const data = input.subarray(offset, offset + blob.size);
    offset += blob.size;
    if (hashBytes(data) !== blob.hash)
      throw Error("Portable asset checksum mismatch.");
    assets[blob.hash] = data;
  }
  if (offset !== input.length) throw Error("Unexpected portable project data.");
  for (const doc of [
    header.document,
    ...header.checkpoints.map((c) => c.document),
  ])
    for (const hash of references(doc))
      if (!assets[hash]) throw Error("Portable project is missing an asset.");
  return { ...header, assets };
}
export async function importPortable(
  library: Library,
  bytes: Uint8Array,
  decode: (bytes: Uint8Array) => Promise<{ width: number; height: number }>,
): Promise<ImportResult> {
  // Validate the complete container before writing. A fresh identity can never
  // replace an existing project, including when opening the same file twice.
  const parsed = unpack(bytes),
    id = randomUUID();
  const checked = new Map<string, { width: number; height: number }>();
  async function image(hash: string) {
    if (!checked.has(hash))
      checked.set(hash, await decode(parsed.assets[hash]));
    return checked.get(hash)!;
  }
  for (const doc of [
    parsed.document,
    ...parsed.checkpoints.map((c) => c.document),
  ]) {
    const fonts = [
      ...(doc.fontFavourites ?? []),
      ...(doc.textPresets ?? []).map((p) => p.style),
    ];
    for (const layer of flattenLayers(doc.layers)) {
      if (layer.kind === "text") fonts.push(layer);
      if (layer.kind !== "raster") continue;
      await image(layer.original);
      const size = await image(layer.asset);
      if (layer.mask) {
        const mask = await image(layer.mask);
        if (mask.width !== size.width || mask.height !== size.height)
          throw Error("Portable mask dimensions do not match its image.");
      }
    }
    for (const font of fonts)
      if (font.fontAsset) {
        const data = Buffer.from(parsed.assets[font.fontAsset]);
        if (
          data.length < 12 ||
          data.length > 20 * 1024 * 1024 ||
          !["\u0000\u0001\u0000\u0000", "OTTO", "wOFF", "wOF2"].includes(
            data.subarray(0, 4).toString("latin1"),
          )
        )
          throw Error("Invalid portable font container.");
      }
  }
  for (const c of parsed.checkpoints) {
    await library.save({ ...c.document, id }, parsed.assets, false);
    await library.checkpoint(id, c.name, { created: c.created, kind: c.kind });
  }
  const document = { ...parsed.document, id };
  await library.save(document, parsed.assets, false);
  return { document, assets: parsed.assets };
}
