import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { filterPixels } from "../src/workers/filters";
import { Library } from "../src/main/library";
import { strokePixels } from "../src/workers/strokes";
import type { Stroke } from "../src/editor/model/strokes";
import { documentSchema } from "../src/editor/model/document";
import { randomUUID } from "node:crypto";
import { hashBytes } from "../src/main/project";
const brush: Stroke = {
  kind: "clone",
  points: [{ x: 40, y: 40 }],
  source: { x: 12, y: 12 },
  diameter: 10,
  hardness: 1,
  opacity: 1,
  colour: "#ff0000",
};
test("Gate 7 liquify uses the same bounded inverse mapping for image and mask", () => {
  const src = new Uint8Array(80 * 80 * 4),
    mask = new Uint8Array(src.length);
  for (let y = 0; y < 80; y++)
    for (let x = 0; x < 80; x++) {
      const at = (y * 80 + x) * 4,
        alpha = x >= 25 && x < 55 && y >= 25 && y < 55 ? 255 : 0;
      src.set([255, 80, 30, alpha], at);
      mask.set([255, 255, 255, alpha], at);
    }
  for (const kind of ["pinch", "expand", "push"] as const) {
    const result = strokePixels(
      src,
      80,
      80,
      {
        ...brush,
        kind,
        diameter: 40,
        points:
          kind === "push"
            ? [
                { x: 30, y: 40 },
                { x: 42, y: 40 },
              ]
            : brush.points,
      },
      mask,
    );
    expect(result.pixels).not.toEqual(src);
    for (let i = 3; i < src.length; i += 4)
      expect(result.pixels[i]).toBe(result.mask![i]);
    const visibleColours = new Set<string>();
    for (let i = 0; i < result.pixels.length; i += 4)
      if (result.pixels[i + 3] > 0)
        visibleColours.add(
          Array.from(result.pixels.subarray(i, i + 3)).join(","),
        );
    expect([...visibleColours]).toEqual(["255,80,30"]);
    if (kind === "pinch") expect(result.pixels[(40 * 80 + 27) * 4 + 3]).toBe(0);
    if (kind === "expand")
      expect(result.pixels[(40 * 80 + 24) * 4 + 3]).toBe(255);
    expect(result.pixels[3]).toBe(0);
  }
  expect(() =>
    strokePixels(src, 80, 80, {
      ...brush,
      points: [
        { x: 1, y: 1 },
        { x: 100000, y: 100000 },
      ],
    }),
  ).toThrow(/long|much work/);
});

test("hidden Gate 7 liquify: transformed masked layer, undo/redo, source immutability and inherited lock", async () => {
  const profile = await mkdtemp(join(tmpdir(), "photo-liquify-")),
    id = randomUUID(),
    library = new Library(join(profile, "projects"));
  const raw = Buffer.alloc(80 * 80 * 4),
    maskRaw = Buffer.alloc(raw.length);
  for (let y = 0; y < 80; y++)
    for (let x = 0; x < 80; x++) {
      const at = (y * 80 + x) * 4,
        alpha = x >= 25 && x < 55 && y >= 25 && y < 55 ? 255 : 0;
      raw.set([255, 80, 30, alpha], at);
      maskRaw.set([255, 255, 255, alpha], at);
    }
  const bytes = await sharp(raw, {
      raw: { width: 80, height: 80, channels: 4 },
    })
      .png()
      .toBuffer(),
    maskBytes = await sharp(maskRaw, {
      raw: { width: 80, height: 80, channels: 4 },
    })
      .png()
      .toBuffer(),
    hash = hashBytes(bytes),
    maskHash = hashBytes(maskBytes);
  const doc = documentSchema.parse({
    schemaVersion: 2,
    id,
    name: "Liquify fixture",
    width: 160,
    height: 160,
    colourSpace: "srgb",
    layers: [
      {
        kind: "group",
        id: "group",
        name: "Group",
        visible: true,
        opacity: 1,
        transform: [1, 0, 0, 1, 10, 10],
        children: [
          {
            kind: "raster",
            id: "image",
            name: "Image",
            visible: true,
            opacity: 1,
            transform: [1.5, 0, 0, 1.5, 0, 0],
            original: hash,
            asset: hash,
            mask: maskHash,
          },
        ],
      },
    ],
  });
  await library.save(doc, { [hash]: bytes, [maskHash]: maskBytes });
  const app = await launch(profile);
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: /Liquify fixture/ }).click();
    await page
      .getByRole("button", { name: "Select Image", exact: true })
      .click();
    await page.getByRole("button", { name: "100%", exact: true }).click();
    await page.getByRole("button", { name: "Liquify", exact: true }).click();
    await page.getByLabel("Brush size", { exact: true }).fill("40");
    await page.getByLabel("Brush hardness", { exact: true }).fill("100");
    await page.getByLabel("Brush tool", { exact: true }).selectOption("pinch");
    const box = (await page.locator(".paper").boundingBox())!;
    await page.mouse.click(box.x + 70, box.y + 70);
    await expect(page.locator("footer")).toContainText("Brush applied");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    const after = await library.load(id),
      layer = (after.document.layers[0] as any).children[0];
    expect(layer.original).toBe(hash);
    expect(layer.asset).not.toBe(hash);
    expect(layer.mask).not.toBe(maskHash);
    expect(after.assets[hash]).toEqual(bytes);
    const pixels = await sharp(after.assets[layer.asset]).raw().toBuffer(),
      mask = await sharp(after.assets[layer.mask]).raw().toBuffer();
    expect(pixels[(40 * 80 + 27) * 4 + 3]).toBe(0);
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(mask[i]);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    const restored = await library.load(id);
    expect(restored.document).toEqual(doc);
    expect(restored.assets[maskHash]).toEqual(maskBytes);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    expect((await library.load(id)).document).toEqual(after.document);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    const rejected = await page.evaluate(
      async ({ doc, brush }) => {
        const locked = structuredClone(doc);
        locked.layers[0].locked = true;
        await window.photo.saveProject(locked, 100);
        try {
          await window.photo.strokeImage("image", brush);
          return "accepted";
        } catch (e) {
          return String(e);
        }
      },
      { doc, brush },
    );
    expect(rejected).toContain("Unlock");
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
  } finally {
    app.process().kill();
  }
});
test("Gate 7 paint uses source-over alpha once per stroke and leaves uncovered pixels transparent", () => {
  const data = new Uint8Array(80 * 80 * 4),
    input: Stroke = {
      ...brush,
      kind: "paint",
      opacity: 0.5,
      points: [
        { x: 40, y: 40 },
        { x: 42, y: 40 },
        { x: 40, y: 40 },
      ],
    };
  const first = strokePixels(data, 80, 80, input).pixels,
    at = (40 * 80 + 40) * 4;
  expect(Array.from(first.slice(at, at + 4))).toEqual([255, 0, 0, 128]);
  expect(first[3]).toBe(0);
  expect(strokePixels(first, 80, 80, input).pixels[at + 3]).toBe(192);
  const pencil = strokePixels(data, 80, 80, {
    ...input,
    points: [{ x: 40, y: 40 }],
    diameter: 1,
    opacity: 1,
  }).pixels;
  expect(Array.from(pencil.slice(at, at + 4))).toEqual([255, 0, 0, 255]);
  expect(pencil[at + 7]).toBe(0);
});

test("hidden Gate 7 drawing: separate layer, stroke alpha, cancel, undo and reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-draw-")),
    profile = join(dir, "profile"),
    input = join(dir, "base.png");
  await sharp({
    create: { width: 80, height: 80, channels: 4, background: "#ffffff" },
  })
    .png()
    .toFile(input);
  let app = await launch(profile);
  try {
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [input],
      });
    }, input);
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await page.getByRole("button", { name: "100%", exact: true }).click();
    await page.getByRole("button", { name: "Draw", exact: true }).click();
    await page
      .getByRole("button", { name: "New paint layer", exact: true })
      .click();
    await expect(page.locator("footer")).toContainText(
      "Transparent paint layer added",
    );
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    await page.getByLabel("Brush size", { exact: true }).fill("10");
    await page.getByLabel("Brush hardness", { exact: true }).fill("100");
    await page.getByLabel("Brush strength", { exact: true }).fill("50");
    await page.getByLabel("Brush colour", { exact: true }).fill("#ff0000");
    const library = new Library(join(profile, "projects")),
      id = (await library.recent())[0].id,
      before = (await library.load(id)).document;
    const box = (await page.locator(".paper").boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 50, box.y + 40, { steps: 5 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect((await library.load(id)).document).toEqual(before);
    await page.mouse.move(box.x + 20, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 50, box.y + 40, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator("footer")).toContainText("Brush applied");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    const after = await library.load(id),
      layer = after.document.layers[1] as any;
    expect(after.document.layers[0]).toEqual(before.layers[0]);
    expect(layer.original).toBe((before.layers[1] as any).original);
    const raw = await sharp(after.assets[layer.asset]).raw().toBuffer();
    expect(
      Array.from(raw.subarray((40 * 80 + 35) * 4, (40 * 80 + 35) * 4 + 4)),
    ).toEqual([255, 0, 0, 128]);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    expect((await library.load(id)).document).toEqual(before);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    await app.close();
    app = await launch(profile);
    page = await app.firstWindow();
    await page.getByRole("button", { name: /base.png/ }).click();
    await expect(
      page.getByRole("button", { name: "Select Paint", exact: true }),
    ).toBeVisible();
    expect((await library.load(id)).document).toEqual(after.document);
    await page
      .getByRole("button", { name: "Select Paint", exact: true })
      .click();
    await page.getByRole("button", { name: "Draw", exact: true }).click();
    await page.getByRole("button", { name: "100%", exact: true }).click();
    await page.getByLabel("Brush size", { exact: true }).fill("1");
    await page.getByLabel("Brush hardness", { exact: true }).fill("100");
    await page.getByLabel("Brush colour", { exact: true }).fill("#0000ff");
    const pencilBox = (await page.locator(".paper").boundingBox())!;
    // Target the pixel centre: Electron rounds native mouse coordinates, and
    // the centred paper can begin at a half CSS pixel.
    await page.mouse.click(pencilBox.x + 10.5, pencilBox.y + 10.5);
    await expect(page.locator("footer")).toContainText("Brush applied");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    const pencilDoc = await library.load(id),
      pencilLayer = pencilDoc.document.layers[1] as any;
    const pencilRaw = await sharp(pencilDoc.assets[pencilLayer.asset])
      .raw()
      .toBuffer();
    expect(
      Array.from(
        pencilRaw.subarray((10 * 80 + 10) * 4, (10 * 80 + 10) * 4 + 4),
      ),
    ).toEqual([0, 0, 255, 255]);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
  } finally {
    app.process().kill();
  }
});

test("Gate 7 retouch samples an immutable stroke source, preserves alpha, and heals an isolated spot", () => {
  const data = new Uint8Array(80 * 80 * 4);
  for (let y = 0; y < 80; y++)
    for (let x = 0; x < 80; x++) {
      const at = (y * 80 + x) * 4;
      data.set([x < 20 ? 220 : 60, 70, 80, 128], at);
    }
  const clone = strokePixels(data, 80, 80, brush).pixels;
  expect(clone[(40 * 80 + 40) * 4]).toBe(140);
  expect(clone[(40 * 80 + 40) * 4 + 3]).toBe(128);
  expect(data[(40 * 80 + 40) * 4]).toBe(60);
  const spot = new Uint8Array(80 * 80 * 4);
  for (let at = 0; at < spot.length; at += 4) spot.set([70, 90, 110, 255], at);
  spot.set([0, 0, 0, 255], (40 * 80 + 40) * 4);
  expect(
    Array.from(
      strokePixels(spot, 80, 80, { ...brush, kind: "heal" }).pixels.slice(
        (40 * 80 + 40) * 4,
        (40 * 80 + 40) * 4 + 4,
      ),
    ),
  ).toEqual([70, 90, 110, 255]);
  expect(() =>
    strokePixels(spot, 80, 80, { ...brush, source: undefined }),
  ).toThrow(/source/);
});

test("hidden Gate 7 retouch: clone source, stroke undo, heal and protected source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-retouch-")),
    profile = join(dir, "profile"),
    input = join(dir, "patch.png"),
    pixels = Buffer.alloc(80 * 80 * 4);
  for (let y = 0; y < 80; y++)
    for (let x = 0; x < 80; x++)
      pixels.set([x < 20 ? 220 : 60, 70, 80, 255], (y * 80 + x) * 4);
  await sharp(pixels, { raw: { width: 80, height: 80, channels: 4 } })
    .png()
    .toFile(input);
  const original = await readFile(input),
    app = await launch(profile);
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [input],
      });
    }, input);
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /Export PNG/ }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "100%", exact: true }).click();
    const library = new Library(join(profile, "projects")),
      id = (await library.recent())[0].id,
      before = (await library.load(id)).document;
    await page.getByRole("button", { name: "Retouch", exact: true }).click();
    await page.getByLabel("Brush size", { exact: true }).fill("10");
    await page.getByLabel("Brush hardness", { exact: true }).fill("100");
    const box = (await page.locator(".paper").boundingBox())!;
    await page
      .getByRole("button", { name: "Pick clone source", exact: true })
      .click();
    await page.mouse.click(box.x + 12, box.y + 12);
    await expect(
      page.getByRole("status", { name: "Clone source" }),
    ).toContainText("Source");
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 46, box.y + 40, { steps: 3 });
    await page.mouse.up();
    await expect(page.locator("footer")).toContainText("Brush applied");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    const after = await library.load(id),
      layer = after.document.layers[0] as any,
      raw = await sharp(after.assets[layer.asset]).raw().toBuffer();
    expect(raw[(40 * 80 + 40) * 4]).toBe(220);
    expect(layer.original).toBe((before.layers[0] as any).original);
    const output = join(dir, "clone-export.png");
    await app.evaluate(({ dialog }, output) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: output,
      });
    }, output);
    await page.getByRole("button", { name: /Export PNG/ }).click();
    await expect(page.locator("footer")).toContainText(
      "PNG exported successfully",
    );
    expect(await sharp(output).ensureAlpha().raw().toBuffer()).toEqual(raw);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    expect((await library.load(id)).document).toEqual(before);
    expect(await readFile(input)).toEqual(original);
    await page
      .getByRole("button", { name: "Pick clone source", exact: true })
      .click();
    await page.getByLabel("Brush tool", { exact: true }).selectOption("heal");
    await page.mouse.click(box.x + 45, box.y + 45);
    await expect(page.locator("footer")).toContainText("Brush applied");
    await expect(
      page.getByRole("button", { name: /Export PNG/ }),
    ).toBeEnabled();
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
  } finally {
    app.process().kill();
  }
});

test("Gate 7 filters preserve alpha, neutral input and known colour/blur/block results", async () => {
  const source = new Uint8Array([
    255, 0, 0, 255, 0, 0, 255, 128, 50, 70, 90, 0, 255, 255, 255, 255,
  ]);
  for (const kind of [
    "mono",
    "sepia",
    "blur",
    "pixelate",
    "vignette",
  ] as const) {
    expect(
      await filterPixels(source, 2, 2, { kind, amount: 0, radius: 2 }),
    ).toEqual(source);
    const result = await filterPixels(source, 2, 2, {
      kind,
      amount: 100,
      radius: 2,
    });
    expect([result[3], result[7], result[11], result[15]]).toEqual([
      255, 128, 0, 255,
    ]);
  }
  expect(
    Array.from(
      (
        await filterPixels(source, 2, 2, {
          kind: "mono",
          amount: 100,
          radius: 2,
        })
      ).slice(0, 4),
    ),
  ).toEqual([54, 54, 54, 255]);
  const blocked = await filterPixels(source, 2, 2, {
    kind: "pixelate",
    amount: 100,
    radius: 2,
  });
  expect(blocked[0]).toBe(Math.round((255 * 510) / 638));
  expect(
    Array.from(
      (
        await filterPixels(source, 2, 2, {
          kind: "sepia",
          amount: 100,
          radius: 2,
        })
      ).slice(0, 3),
    ),
  ).toEqual([100, 89, 69]);
  const blurred = await filterPixels(source, 2, 2, {
    kind: "blur",
    amount: 100,
    radius: 8,
  });
  expect(blurred[0]).toBeLessThan(255);
  expect(blurred[2]).toBeGreaterThan(0);
  expect(
    (
      await filterPixels(source, 2, 2, {
        kind: "vignette",
        amount: 100,
        radius: 2,
      })
    )[0],
  ).toBeLessThan(255);
  await expect(
    filterPixels(source, 2, 2, { kind: "blur", amount: 101, radius: 2 }),
  ).rejects.toThrow();
});

test("hidden Gate 7 brush cancellation, compact tool rail and native close wait for saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-brush-close-")),
    profile = join(dir, "profile"),
    input = join(dir, "close.png");
  await sharp({
    create: { width: 512, height: 512, channels: 4, background: "#ffffff" },
  })
    .png()
    .toFile(input);
  const app = await launch(profile);
  let closed = false;
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [input],
      });
    }, input);
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /Export PNG/ }),
    ).toBeEnabled();
    const library = new Library(join(profile, "projects")),
      id = (await library.recent())[0].id,
      before = (await library.load(id)).document;
    const cancellation = await page.evaluate(
      async ({ id, brush }) => {
        const pending = window.photo.strokeImage(id, {
          ...brush,
          kind: "paint",
        });
        const timer = setInterval(() => window.photo.cancelStroke(), 5);
        try {
          await pending;
          return "completed";
        } catch (e) {
          return String(e);
        } finally {
          clearInterval(timer);
        }
      },
      { id: before.layers[0].id, brush },
    );
    expect(cancellation).toContain("cancelled");
    expect((await library.load(id)).document).toEqual(before);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(900, 600),
    );
    for (const name of ["Filters", "Retouch", "Draw", "Liquify"]) {
      await page.getByRole("button", { name, exact: true }).click();
      const inside = await page
        .getByRole("button", { name, exact: true })
        .evaluate((button) => {
          const b = button.getBoundingClientRect(),
            n = button.closest("nav")!.getBoundingClientRect();
          return b.top >= n.top && b.bottom <= n.bottom;
        });
      expect(inside).toBe(true);
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1280, 800),
    );
    await page.getByRole("button", { name: "100%", exact: true }).click();
    await page.getByRole("button", { name: "Draw", exact: true }).click();
    await page.getByLabel("Brush colour", { exact: true }).fill("#ff0000");
    await page.getByLabel("Brush hardness", { exact: true }).fill("100");
    await page.getByLabel("Brush size", { exact: true }).fill("32");
    await app.evaluate(({ app, ipcMain, BrowserWindow }) => {
      ipcMain.once("project:operation", (_, active) => {
        if (active)
          setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 20);
      });
    });
    const closing = app.waitForEvent("close"),
      box = (await page.locator(".paper").boundingBox())!;
    await page.mouse.click(box.x + 128, box.y + 128);
    await closing;
    closed = true;
    const after = await library.load(id),
      layer = after.document.layers[0] as any,
      pixel = await sharp(after.assets[layer.asset])
        .ensureAlpha()
        .raw()
        .toBuffer();
    expect(
      Array.from(
        pixel.subarray((128 * 512 + 128) * 4, (128 * 512 + 128) * 4 + 4),
      ),
    ).toEqual([255, 0, 0, 255]);
    expect(layer.original).toBe((before.layers[0] as any).original);
  } finally {
    if (!closed) app.process().kill();
  }
});
async function launch(profile: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PHOTO_EDITOR_HIDDEN: "1",
    PHOTO_EDITOR_DATA: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    ...(process.env.PHOTO_PACKAGED
      ? { executablePath: process.env.PHOTO_PACKAGED, args: [] }
      : { args: ["."] }),
    env: env as Record<string, string>,
  });
  await app.firstWindow();
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
    ),
  ).toBe(true);
  return app;
}
test("hidden Gate 7 filters: before/after, cancel, apply, undo and persisted original", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-filters-")),
    profile = join(dir, "profile"),
    input = join(dir, "red.png");
  await sharp({
    create: {
      width: 80,
      height: 60,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0.5 },
    },
  })
    .png()
    .toFile(input);
  const app = await launch(profile);
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [input],
      });
    }, input);
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /Export PNG/ }),
    ).toBeEnabled();
    const library = new Library(join(profile, "projects")),
      id = (await library.recent())[0].id,
      before = (await library.load(id)).document;
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page
      .getByRole("button", { name: "Preview filter", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Apply filter", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: /Export PNG/ }),
    ).toBeDisabled();
    expect((await library.load(id)).document).toEqual(before);
    await page
      .getByRole("button", { name: "Cancel filter", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Preview filter", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Show before", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Apply filter", exact: true })
      .click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    const after = await library.load(id),
      layer = after.document.layers[0] as any;
    expect(layer.original).toBe((before.layers[0] as any).original);
    const rgba = await sharp(after.assets[layer.asset]).raw().toBuffer();
    expect(Array.from(rgba.subarray(0, 4))).toEqual([54, 54, 54, 128]);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    expect((await library.load(id)).document).toEqual(before);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
  } finally {
    app.process().kill();
  }
});
