import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
  documentSchema,
  flattenLayers,
  type PhotoDocument,
  type Layer,
} from "../src/editor/model/document";
import {
  groupLayers,
  ungroup,
  patchLayer,
  duplicate,
  reorder,
  moveBefore,
  translateWorld,
  align,
  distribute,
  snapDelta,
  locate,
} from "../src/editor/commands/layers";
import { History } from "../src/editor/commands/history";
import { crop, rotate, resize, flip } from "../src/editor/commands/geometry";
import { Library } from "../src/main/library";
import { hashBytes, references } from "../src/main/project";
const raster = (id: string, x = 0): Layer => ({
  kind: "raster",
  id,
  name: id,
  visible: true,
  opacity: 1,
  transform: [1, 0, 0, 1, x, 0],
  asset: "a".repeat(64),
  original: "a".repeat(64),
});
const doc = (): PhotoDocument => ({
  schemaVersion: 2,
  id: randomUUID(),
  name: "Layer proof",
  width: 128,
  height: 96,
  colourSpace: "srgb",
  layers: [raster("a"), raster("b", 20), raster("c", 60)],
});
test("nested grouping, copy, order, locks and history preserve structure without mutating input", () => {
  const original = doc();
  const history = new History();
  history.push(original);
  const grouped = groupLayers(original, ["a", "b"]);
  expect(grouped.layers.map((l) => l.kind)).toEqual(["group", "raster"]);
  const group = grouped.layers[0];
  expect(group.kind === "group" && group.children.map((l) => l.id)).toEqual([
    "a",
    "b",
  ]);
  expect(original.layers.map((l) => l.id)).toEqual(["a", "b", "c"]);
  expect(history.undo(grouped)).toEqual(original);
  expect(history.redo(original)).toEqual(grouped);
  const nested = groupLayers(grouped, [group.id, "c"]);
  expect(flattenLayers(nested.layers).length).toBe(5);
  const copy = duplicate(nested, [nested.layers[0].id]);
  expect(new Set(flattenLayers(copy.layers).map((l) => l.id)).size).toBe(10);
  expect(references(copy)).toEqual(["a".repeat(64)]);
  const locked = patchLayer(nested, nested.layers[0].id, { locked: true });
  expect(() => translateWorld(locked, ["a"], 1, 1)).toThrow("Unlock");
  expect(() => patchLayer(locked, "a", { visible: false })).toThrow("Unlock");
  expect(reorder(original, "a", 1).layers.map((l) => l.id)).toEqual([
    "b",
    "a",
    "c",
  ]);
  expect(moveBefore(original, "a", "c").layers.map((l) => l.id)).toEqual([
    "b",
    "c",
    "a",
  ]);
  expect(() => moveBefore(grouped, "a", "c")).toThrow("same group");
});
test("ungroup preserves transforms and rejects opacity/blend changes that cannot be flattened into children", () => {
  const original = doc();
  let next = groupLayers(original, ["a", "b"]);
  const id = next.layers[0].id;
  next = patchLayer(next, id, { transform: [2, 0, 0, 2, 10, 20] });
  const restored = ungroup(next, id);
  expect(restored.layers[0].transform).toEqual([2, 0, 0, 2, 10, 20]);
  expect(restored.layers[1].transform).toEqual([2, 0, 0, 2, 50, 20]);
  expect(() => ungroup(patchLayer(next, id, { opacity: 0.5 }), id)).toThrow(
    "opacity",
  );
  expect(() =>
    ungroup(patchLayer(next, id, { blend: "multiply" }), id),
  ).toThrow("blend");
  expect(() =>
    ungroup(patchLayer(next, "a", { blend: "multiply" }), id),
  ).toThrow("direct children");
  const childMoved = translateWorld(next, ["b"], 10, 20);
  expect(locate(childMoved, "b")!.layer.transform.slice(4)).toEqual([25, 10]);
});
test("alignment, equal spacing and snapping are document-space operations independent of overlay visibility", () => {
  const d = doc(),
    bounds = {
      a: { left: 0, top: 0, width: 10, height: 10 },
      b: { left: 20, top: 4, width: 10, height: 10 },
      c: { left: 60, top: 9, width: 10, height: 10 },
    };
  expect(
    locate(align(d, ["b"], bounds, "centerX"), "b")!.layer.transform[4],
  ).toBe(59);
  expect(
    align(d, ["a", "b", "c"], bounds, "top").layers.map((l) => l.transform[5]),
  ).toEqual([0, -4, -9]);
  expect(
    distribute(d, ["a", "b", "c"], bounds, "x").layers.map(
      (l) => l.transform[4],
    ),
  ).toEqual([0, 30, 60]);
  const options = {
    grid: false,
    guides: false,
    layers: false,
    step: 32,
    zoom: 2,
  };
  const moving = { left: 30, top: 31, width: 10, height: 10 };
  expect(snapDelta(moving, [], [], options)).toEqual({ dx: 0, dy: 0 });
  expect(snapDelta(moving, [], [], { ...options, grid: true })).toEqual({
    dx: 2,
    dy: 1,
  });
  expect(
    snapDelta(moving, [], [{ axis: "x", position: 42 }], {
      ...options,
      guides: true,
    }),
  ).toEqual({ dx: 2, dy: 0 });
  expect(
    snapDelta(moving, [{ left: 42, top: 100, width: 10, height: 10 }], [], {
      ...options,
      layers: true,
    }),
  ).toEqual({ dx: 2, dy: 0 });
  expect(
    snapDelta(moving, [], [{ axis: "x", position: 44 }], {
      ...options,
      guides: true,
    }),
  ).toEqual({ dx: 0, dy: 0 });
});
test("schema rejects duplicate IDs, cycles, excessive nesting and unsupported blends", () => {
  const d = doc();
  expect(
    documentSchema.safeParse({ ...d, layers: [d.layers[0], d.layers[0]] })
      .success,
  ).toBe(false);
  expect(
    documentSchema.safeParse({
      ...d,
      layers: [{ ...d.layers[0], blend: "overlay" }],
    }).success,
  ).toBe(false);
  const cycle: any = { ...raster("cycle"), kind: "group", children: [] };
  cycle.children.push(cycle);
  expect(documentSchema.safeParse({ ...d, layers: [cycle] }).success).toBe(
    false,
  );
  let layer: Layer = raster("leaf");
  for (let i = 0; i < 5; i++)
    layer = {
      id: "group" + i,
      kind: "group",
      name: "Group",
      visible: true,
      opacity: 1,
      transform: [1, 0, 0, 1, 0, 0],
      children: [layer],
    };
  expect(documentSchema.safeParse({ ...d, layers: [layer] }).success).toBe(
    false,
  );
});
test("mixed nested image/text composition and guides survive persistent save, load and checkpoint restore", async () => {
  const bytes = await sharp({
      create: { width: 16, height: 16, channels: 4, background: "#557799" },
    })
      .png()
      .toBuffer(),
    hash = hashBytes(bytes);
  const d = doc();
  d.layers = d.layers.map(
    (l) => ({ ...l, kind: "raster", asset: hash, original: hash }) as Layer,
  );
  d.layers.push({
    kind: "text",
    id: "title",
    name: "Title",
    text: "Editable\nText",
    fontFamily: "Arial",
    fontSize: 18,
    fill: "#24262a",
    visible: true,
    opacity: 1,
    transform: [1, 0, 0, 1, 4, 50],
  });
  let next = groupLayers(d, ["a", "b"]);
  next = groupLayers(next, [next.layers[0].id, "title"]);
  next.guides = [{ id: "guide", axis: "x", position: 32 }];
  const library = new Library(
    await mkdtemp(join(tmpdir(), "photo-layer-library-")),
  );
  await library.save(next, { [hash]: bytes });
  const checkpoint = await library.checkpoint(next.id, "Nested");
  expect((await library.load(next.id)).document).toEqual(next);
  await library.save({ ...next, name: "Later" }, {});
  await library.restore(next.id, checkpoint.id);
  expect((await library.load(next.id)).document).toEqual(next);
  expect(
    flattenLayers(next.layers).filter((l) => l.kind === "text")[0],
  ).toMatchObject({ text: "Editable\nText" });
});

test("guides follow crop, resize, rotation and flip with stable IDs", () => {
  const d = doc();
  d.guides = [
    { id: "vertical", axis: "x", position: 20 },
    { id: "horizontal", axis: "y", position: 30 },
  ];
  expect(crop(d, 10, 10, 80, 60).guides?.map((g) => g.position)).toEqual([
    10, 20,
  ]);
  expect(resize(d, 256, 192, "stretch").guides?.map((g) => g.position)).toEqual(
    [40, 60],
  );
  expect(rotate(d).guides).toEqual([
    { id: "vertical", axis: "y", position: 20 },
    { id: "horizontal", axis: "x", position: 66 },
  ]);
  expect(flip(d, "horizontal").guides?.map((g) => g.position)).toEqual([
    108, 30,
  ]);
});
