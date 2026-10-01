import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  documentSchema,
  flattenLayers,
  type PhotoDocument,
} from "../editor/model/document";
export const hashBytes = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function references(doc: PhotoDocument) {
  return [
    ...new Set([
      ...flattenLayers(doc.layers).flatMap((l) =>
        l.kind === "raster"
          ? [l.original, l.asset, ...(l.mask ? [l.mask] : [])]
          : l.kind === "text" && l.fontAsset
            ? [l.fontAsset]
            : [],
      ),
      ...(doc.fontFavourites ?? []).flatMap((f) =>
        f.fontAsset ? [f.fontAsset] : [],
      ),
      ...(doc.textPresets ?? []).flatMap((p) =>
        p.style.fontAsset ? [p.style.fontAsset] : [],
      ),
    ]),
  ];
}
// Gate 0 temporary-project proof. Durable revisions/recovery belong to Gate 1.
export async function writeProject(
  dir: string,
  doc: PhotoDocument,
  assets: Record<string, Uint8Array>,
) {
  documentSchema.parse(doc);
  await mkdir(join(dir, "assets"), { recursive: true });
  for (const id of references(doc)) {
    if (!assets[id] || hashBytes(assets[id]) !== id)
      throw Error("Asset checksum mismatch");
    await writeFile(join(dir, "assets", id), assets[id], { flag: "wx" });
  }
  await writeFile(join(dir, "manifest.json"), JSON.stringify(doc, null, 2), {
    flag: "wx",
  });
}
export async function readProject(dir: string) {
  const doc = documentSchema.parse(
    JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")),
  );
  const assets: Record<string, Uint8Array> = {};
  for (const id of references(doc)) {
    assets[id] = await readFile(join(dir, "assets", id));
    if (hashBytes(assets[id]) !== id) throw Error("Asset checksum mismatch");
  }
  return { document: doc, assets };
}
