import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { Library } from "../src/main/library";
import { hashBytes } from "../src/main/project";
import {
  flattenLayers,
  type PhotoDocument,
} from "../src/editor/model/document";
import { createSelection, editMask } from "../src/workers/mask";
async function launch(profile: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.PHOTO_EDITOR_DATA = profile;
  env.PHOTO_EDITOR_HIDDEN = "1";
  const app = await electron.launch({
    ...(process.env.PHOTO_PACKAGED
      ? { executablePath: process.env.PHOTO_PACKAGED, args: [] }
      : { args: ["."] }),
    env,
  });
  await app.firstWindow();
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
    ),
  ).toBe(true);
  return app;
}
async function choose(app: ElectronApplication, input: string, output: string) {
  await app.evaluate(
    ({ dialog }, { input, output }) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [input],
      });
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: output,
      });
    },
    { input, output },
  );
}
async function drag(
  page: Page,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  const box = (await page.locator(".paper").boundingBox())!;
  await page.mouse.move(box.x + x1, box.y + y1);
  await page.mouse.down();
  await page.mouse.move(box.x + x2, box.y + y2, { steps: 6 });
  await page.mouse.up();
}
async function saved(page: Page) {
  await expect(page.getByRole("button", { name: /Export PNG/ })).toBeEnabled();
  await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
    "Saved",
  );
}
test("hidden cutout workflow: soft alpha, restore brush, undo, reopen, inspection and trim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-cutout-")),
    profile = join(dir, "profile"),
    input = join(dir, "Cutout.png"),
    output = join(dir, "soft.png");
  const raw = Buffer.alloc(64 * 48 * 4);
  for (let i = 0; i < 64 * 48; i++) {
    raw[i * 4] = 220;
    raw[i * 4 + 1] = 80;
    raw[i * 4 + 2] = 30;
    raw[i * 4 + 3] = 128;
  }
  const original = await sharp(raw, {
    raw: { width: 64, height: 48, channels: 4 },
  })
    .png()
    .toBuffer();
  await writeFile(input, original);
  let app = await launch(profile);
  try {
    let page = await app.firstWindow();
    await choose(app, input, output);
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await page.getByRole("button", { name: "100%", exact: true }).click();
    await page.getByRole("button", { name: "Cutout", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Mask feather" }).fill("2");
    await drag(page, 16, 12, 48, 36);
    await expect(page.getByLabel("Selection status")).toHaveText(
      "Selection ready",
    );
    await page
      .getByRole("button", { name: "Keep selected", exact: true })
      .click();
    await saved(page);
    const library = new Library(join(profile, "projects")),
      id = (await library.recent())[0].id;
    const cut = await library.load(id),
      layer = cut.document.layers[0];
    expect(layer.kind).toBe("raster");
    if (layer.kind !== "raster") throw Error("fixture");
    const maskHash = layer.mask;
    expect(maskHash).toBeTruthy();
    expect(cut.assets[layer.original]).toEqual(new Uint8Array(original));
    const rect = await createSelection(original, {
      kind: "rectangle",
      start: { x: 16, y: 12 },
      end: { x: 48, y: 36 },
    });
    const expected = await editMask(original, undefined, rect.bytes, {
      action: "keep",
      selection: hashBytes(rect.bytes),
      feather: 2,
    });
    expect(Buffer.from(cut.assets[maskHash!])).toEqual(expected.bytes);
    await page.getByRole("button", { name: /Export PNG/ }).click();
    await expect(page.locator("footer[role=status]")).toContainText(
      "exported successfully",
    );
    const exported = await sharp(await readFile(output))
      .ensureAlpha()
      .raw()
      .toBuffer();
    const expectedMask = await sharp(expected.bytes)
      .ensureAlpha()
      .raw()
      .toBuffer();
    for (let i = 3; i < exported.length; i += 4)
      expect(
        Math.abs(exported[i] - Math.round((expectedMask[i] * 128) / 255)),
      ).toBeLessThanOrEqual(1);
    expect(exported.some((v, i) => i % 4 === 3 && v > 0 && v < 128)).toBe(true);
    for (const background of ["white", "black", "checker"]) {
      await page.getByLabel("Transparency view").selectOption(background);
      const path = join(dir, background + ".png");
      await choose(app, input, path);
      await page.getByRole("button", { name: /Export PNG/ }).click();
      await expect(page.locator("footer[role=status]")).toContainText(
        "exported successfully",
      );
      expect(await readFile(path)).toEqual(await readFile(output));
    }
    await page.getByLabel("Cutout tool").selectOption("restore-brush");
    await page.getByLabel("Brush diameter").fill("8");
    await page.getByLabel("Mask feather").fill("0");
    await drag(page, 4, 24, 20, 24);
    await saved(page);
    const restored = await library.load(id),
      restoredLayer = restored.document.layers[0];
    if (restoredLayer.kind !== "raster") throw Error("fixture");
    const restoredAlpha = await sharp(restored.assets[restoredLayer.mask!])
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(restoredAlpha[(24 * 64 + 6) * 4 + 3]).toBe(255);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await saved(page);
    expect((await library.load(id)).document).toEqual(cut.document);
    expect(await readFile(input)).toEqual(original);
    await app.close();
    await unlink(input);
    app = await launch(profile);
    page = await app.firstWindow();
    await page.getByRole("button", { name: /Cutout.png/ }).click();
    await page.getByRole("button", { name: "Cutout", exact: true }).click();
    const reopenedOutput = join(dir, "reopened.png");
    await choose(app, input, reopenedOutput);
    await page.getByRole("button", { name: /Export PNG/ }).click();
    await expect(page.locator("footer[role=status]")).toContainText(
      "exported successfully",
    );
    expect(await readFile(reopenedOutput)).toEqual(await readFile(output));
    await page.getByRole("button", { name: "Trim transparent edges" }).click();
    await saved(page);
    const trimmed = (await library.load(id)).document;
    expect(trimmed.width).toBeLessThan(64);
    expect(trimmed.height).toBeLessThan(48);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await saved(page);
    expect((await library.load(id)).document).toEqual(cut.document);
    await page
      .getByRole("button", { name: "Restore entire image", exact: true })
      .click();
    await saved(page);
    await choose(app, input, join(dir, "restored.png"));
    await page.getByRole("button", { name: /Export PNG/ }).click();
    await expect(page.locator("footer[role=status]")).toContainText(
      "exported successfully",
    );
    const full = await sharp(await readFile(join(dir, "restored.png")))
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(full.every((v, i) => i % 4 !== 3 || v === 128)).toBe(true);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test("hidden cutout transformed nested layer maps selection to image pixels and enforces locks", async () => {
  const profile = await mkdtemp(join(tmpdir(), "photo-cutout-transform-"));
  const bytes = await sharp({
      create: { width: 16, height: 16, channels: 4, background: "red" },
    })
      .png()
      .toBuffer(),
    hash = hashBytes(bytes);
  const doc: PhotoDocument = {
    schemaVersion: 2,
    id: randomUUID(),
    name: "Transformed cutout",
    width: 128,
    height: 128,
    colourSpace: "srgb",
    layers: [
      {
        kind: "group",
        id: "group",
        name: "Group",
        visible: true,
        opacity: 1,
        transform: [1, 0, 0, 1, 10, 5],
        children: [
          {
            kind: "raster",
            id: "image",
            name: "Image",
            visible: true,
            opacity: 1,
            transform: [0, 2, -2, 0, 80, 10],
            original: hash,
            asset: hash,
          },
        ],
      },
    ],
  };
  const library = new Library(join(profile, "projects"));
  await library.save(doc, { [hash]: bytes });
  const app = await launch(profile);
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: /Transformed cutout/ }).click();
    await page
      .getByRole("button", { name: "Select Image", exact: true })
      .click();
    await page.getByRole("spinbutton", { name: "Zoom percent" }).fill("200");
    await page.getByRole("button", { name: "Cutout", exact: true }).click();
    await drag(page, 164, 46, 132, 78);
    await expect(page.getByLabel("Selection status")).toHaveText(
      "Selection ready",
    );
    await page
      .getByRole("button", { name: "Keep selected", exact: true })
      .click();
    await saved(page);
    const result = await library.load(doc.id),
      layer = flattenLayers(result.document.layers).find(
        (l) => l.id === "image",
      )!;
    if (layer.kind !== "raster") throw Error("fixture");
    const raw = await sharp(result.assets[layer.mask!])
      .ensureAlpha()
      .raw()
      .toBuffer();
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        expect(raw[(y * 16 + x) * 4 + 3]).toBe(
          x >= 4 && x < 12 && y >= 4 && y < 12 ? 255 : 0,
        );
    await page.getByRole("button", { name: "Lock Group", exact: true }).click();
    await saved(page);
    await expect(
      page.getByRole("button", { name: "Invert mask", exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(async () => {
        try {
          await window.photo.editMask("image", { action: "invert" });
          return "allowed";
        } catch (e) {
          return String(e);
        }
      }),
    ).toContain("Unlock");
  } finally {
    await app.close();
  }
});

test("hidden cutout tools: polygon, freehand, ellipse, wand, mask operations and cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-cutout-tools-")),
    input = join(dir, "Tools.png"),
    profile = join(dir, "profile");
  await writeFile(
    input,
    await sharp({
      create: { width: 64, height: 64, channels: 4, background: "red" },
    })
      .png()
      .toBuffer(),
  );
  const app = await launch(profile);
  try {
    const page = await app.firstWindow();
    await choose(app, input, join(dir, "unused.png"));
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await page.getByRole("button", { name: "100%", exact: true }).click();
    await page.getByRole("button", { name: "Cutout", exact: true }).click();
    const library = new Library(join(profile, "projects")),
      id = (await library.recent())[0].id;
    const start = (await library.load(id)).document;
    const getAlpha = async () => {
      const loaded = await library.load(id),
        layer = loaded.document.layers[0];
      if (layer.kind !== "raster" || !layer.mask) throw Error("Missing mask");
      return sharp(loaded.assets[layer.mask]).ensureAlpha().raw().toBuffer();
    };
    for (const tool of ["polygon", "freehand", "ellipse"]) {
      await page.getByLabel("Cutout tool").selectOption(tool);
      const box = (await page.locator(".paper").boundingBox())!;
      if (tool === "polygon") {
        for (const [x, y] of [
          [8, 8],
          [48, 8],
          [8, 48],
        ])
          await page.mouse.click(box.x + x, box.y + y);
        await page
          .getByRole("button", { name: "Finish polygon", exact: true })
          .click();
      } else if (tool === "freehand") {
        await page.mouse.move(box.x + 8, box.y + 8);
        await page.mouse.down();
        await page.mouse.move(box.x + 48, box.y + 8, { steps: 5 });
        await page.mouse.move(box.x + 8, box.y + 48, { steps: 5 });
        await page.mouse.up();
      } else await drag(page, 8, 8, 48, 48);
      await expect(page.getByLabel("Selection status")).toHaveText(
        "Selection ready",
      );
      await page
        .getByRole("button", { name: "Remove selected", exact: true })
        .click();
      await saved(page);
      const a = await getAlpha();
      expect(a[(20 * 64 + 20) * 4 + 3]).toBe(0);
      expect(a[3]).toBe(255);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await saved(page);
      expect((await library.load(id)).document).toEqual(start);
    }
    await page.getByLabel("Cutout tool").selectOption("wand");
    await page.getByLabel("Wand tolerance").fill("0");
    await page
      .getByRole("checkbox", { name: "Contiguous pixels only" })
      .uncheck();
    const box = (await page.locator(".paper").boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + 20);
    await expect(page.getByLabel("Selection status")).toHaveText(
      "Selection ready",
    );
    await page
      .getByRole("button", { name: "Invert selection", exact: true })
      .click();
    await expect(page.getByLabel("Selection status")).toHaveText(
      "Outside selection",
    );
    await page
      .getByRole("button", { name: "Keep selected", exact: true })
      .click();
    await saved(page);
    expect((await getAlpha()).every((v, i) => i % 4 !== 3 || v === 0)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Trim transparent edges" }).click();
    await saved(page);
    await expect(page.locator("footer[role=status]")).toContainText(
      "fully transparent",
    );
    await page
      .getByRole("button", { name: "Invert mask", exact: true })
      .click();
    await saved(page);
    expect((await getAlpha()).every((v, i) => i % 4 !== 3 || v === 255)).toBe(
      true,
    );
    await page.getByLabel("Cutout tool").selectOption("remove-brush");
    await page.getByLabel("Brush diameter").fill("8");
    await drag(page, 10, 20, 35, 20);
    await saved(page);
    expect((await getAlpha())[(20 * 64 + 20) * 4 + 3]).toBe(0);
    await page.getByLabel("Mask feather").fill("3");
    await page
      .getByRole("button", { name: "Feather mask", exact: true })
      .click();
    await saved(page);
    expect((await getAlpha())[(20 * 64 + 20) * 4 + 3]).toBeGreaterThan(0);
    const before = (await library.load(id)).document;
    const cancellation = await page.evaluate(async (layerId) => {
      const pending = window.photo.createSelection(layerId, {
        kind: "wand",
        point: { x: 0, y: 0 },
        tolerance: 255,
        contiguous: true,
      });
      setTimeout(() => window.photo.cancelMaskJob(), 10);
      try {
        await pending;
        return "completed";
      } catch (e) {
        return String(e);
      }
    }, start.layers[0].id);
    expect(cancellation).toContain("cancelled");
    expect((await library.load(id)).document).toEqual(before);
    expect(
      await page.evaluate(async (layerId) => {
        const result = await window.photo.createSelection(layerId, {
          kind: "wand",
          point: { x: 0, y: 0 },
          tolerance: 0,
          contiguous: true,
        });
        return result.width;
      }, start.layers[0].id),
    ).toBe(64);
    expect(
      await page.evaluate(async (layerId) => {
        try {
          await window.photo.editMask(layerId, {
            action: "keep",
            selection: "f".repeat(64),
          });
          return "allowed";
        } catch (e) {
          return String(e);
        }
      }, start.layers[0].id),
    ).toContain("Unknown selection");
  } finally {
    await app.close();
  }
});

test("hidden cutout close waits for the active worker and persists its mask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-cutout-close-")),
    profile = join(dir, "profile"),
    input = join(dir, "Close.png");
  await writeFile(
    input,
    await sharp({
      create: { width: 512, height: 512, channels: 4, background: "red" },
    })
      .png()
      .toBuffer(),
  );
  const app = await launch(profile);
  let closed = false;
  try {
    const page = await app.firstWindow();
    await choose(app, input, join(dir, "unused.png"));
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await page.getByRole("button", { name: "Cutout", exact: true }).click();
    const close = app.waitForEvent("close");
    // Observe the worker boundary, then request an ordinary native close while
    // the mask action is still pending. Do not forcibly terminate the process.
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      // A dedicated test signal travels after the renderer has started the action.
      ipcMain.once("project:preview", () =>
        setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 20),
      );
    });
    await page
      .getByRole("button", { name: "Invert mask", exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        window.photo.previewActive(false);
      });
    await close;
    closed = true;
    const library = new Library(join(profile, "projects")),
      rows = await library.recent(),
      loaded = await library.load(rows[0].id),
      layer = loaded.document.layers[0];
    expect(layer.kind).toBe("raster");
    if (layer.kind !== "raster" || !layer.mask)
      throw Error("Pending mask was lost");
    const a = await sharp(loaded.assets[layer.mask])
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(a.every((v, i) => i % 4 !== 3 || v === 0)).toBe(true);
  } finally {
    if (!closed) await app.close();
  }
});
