import { test, expect } from "@playwright/test";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rename,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { Library } from "../src/main/library";
import { hashBytes } from "../src/main/project";
import type { PhotoDocument } from "../src/editor/model/document";
import { History } from "../src/editor/commands/history";
import {
  crop,
  canvasSize,
  resize,
  rotate,
  flip,
} from "../src/editor/commands/geometry";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "photo-library-"));
  const bytes = await sharp({
    create: { width: 80, height: 40, channels: 4, background: "#cc5544" },
  })
    .png()
    .toBuffer();
  const hash = hashBytes(bytes);
  const doc: PhotoDocument = {
    schemaVersion: 1,
    id: randomUUID(),
    name: "Synthetic project",
    width: 80,
    height: 40,
    colourSpace: "srgb",
    layers: [
      {
        kind: "raster",
        id: randomUUID(),
        name: "Photo",
        original: hash,
        asset: hash,
        visible: true,
        opacity: 1,
        transform: [1, 0, 0, 1, 0, 0],
      },
    ],
  };
  return { root, doc, assets: { [hash]: bytes } };
}
for (const phase of ["assets", "manifest", "head"] as const)
  test(`interruption at ${phase} leaves previous verified revision readable`, async () => {
    const { root, doc, assets } = await fixture();
    const library = new Library(root);
    await library.save(doc, assets);
    const originalHead = await readFile(
      join(root, doc.id, "head.json"),
      "utf8",
    );
    const failing = new Library(root, async (p) => {
      if (p === phase)
        throw Object.assign(Error("Injected disk full"), { code: "ENOSPC" });
    });
    await expect(
      failing.save({ ...doc, name: "Must not become current" }, assets),
    ).rejects.toThrow("disk full");
    expect((await library.load(doc.id)).document).toEqual(doc);
    expect(await readFile(join(root, doc.id, "head.json"), "utf8")).toBe(
      originalHead,
    );
    await library.save({ ...doc, name: "Retry succeeded" }, assets);
    expect((await library.load(doc.id)).document.name).toBe("Retry succeeded");
  });
test("corrupt current manifest falls back; retry and checkpoints preserve later work", async () => {
  const { root, doc, assets } = await fixture();
  const library = new Library(root);
  await library.save(doc, assets);
  const checkpoint = await library.checkpoint(doc.id, "Before edits");
  const later = { ...doc, name: "Later work" };
  const head = await library.save(later, assets);
  await writeFile(
    join(root, doc.id, "revisions", head.revision + ".json"),
    "{broken",
  );
  const recovered = await library.load(doc.id);
  expect(recovered.recovered).toBe(true);
  expect(recovered.document).toEqual(doc);
  await library.save(later, assets);
  await library.checkpoint(doc.id, "Keep later");
  await library.restore(doc.id, checkpoint.id);
  expect((await library.load(doc.id)).document).toEqual(doc);
  expect((await library.checkpoints(doc.id)).map((c) => c.name)).toContain(
    "Keep later",
  );
  expect((await library.recent())[0].id).toBe(doc.id);
  expect((await readdir(join(root, doc.id, "assets"))).length).toBe(1);
});
test("real Windows head replacement failure leaves fallback intact", async () => {
  const { root, doc, assets } = await fixture();
  const library = new Library(root);
  await library.save(doc, assets);
  await library.save({ ...doc, name: "Second" }, assets);
  const head = join(root, doc.id, "head.json");
  await rename(head, head + ".held");
  await mkdir(head);
  await expect(
    library.save({ ...doc, name: "Cannot commit" }, assets),
  ).rejects.toThrow();
  expect((await library.load(doc.id)).document).toEqual(doc);
});
test("bounded undo and geometry retain originals with distinct crop/resize/canvas semantics", async () => {
  const { doc } = await fixture();
  const history = new History(3);
  let current = doc;
  for (let i = 1; i <= 5; i++) {
    history.push(current);
    current = { ...doc, name: String(i) };
  }
  expect(history.undo(current)?.name).toBe("4");
  current = { ...doc, name: "4" };
  expect(history.undo(current)?.name).toBe("3");
  expect(history.undo({ ...doc, name: "3" })?.name).toBe("2");
  expect(history.undo(doc)).toBeUndefined();
  expect(history.redo(doc)?.name).toBe("3");
  expect(crop(doc, 10, 5, 40, 20).layers[0].transform).toEqual([
    1, 0, 0, 1, -10, -5,
  ]);
  expect(canvasSize(doc, 100, 60, 4).layers[0].transform).toEqual([
    1, 0, 0, 1, 10, 10,
  ]);
  expect(resize(doc, 160, 80, "stretch").layers[0].transform).toEqual([
    2, 0, 0, 2, 0, 0,
  ]);
  expect(resize(doc, 100, 100, "fit").layers[0].transform).toEqual([
    1.25, 0, 0, 1.25, 0, 25,
  ]);
  expect(rotate(rotate(rotate(rotate(doc))))).toEqual(doc);
  expect(flip(flip(doc, "horizontal"), "horizontal")).toEqual(doc);
  expect(() => crop(doc, 70, 0, 20, 20)).toThrow();
});

test("a failed fallback replacement never advances the head", async () => {
  const { root, doc, assets } = await fixture();
  const library = new Library(root);
  await library.save(doc, assets);
  const before = await readFile(join(root, doc.id, "head.json"), "utf8");
  await mkdir(join(root, doc.id, "previous.json"));
  await expect(
    library.save({ ...doc, name: "Failed" }, assets),
  ).rejects.toThrow();
  expect(await readFile(join(root, doc.id, "head.json"), "utf8")).toBe(before);
  expect((await library.load(doc.id)).document).toEqual(doc);
});
