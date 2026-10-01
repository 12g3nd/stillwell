import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, writeFile, readFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Library } from "../src/main/library";
import { hashBytes } from "../src/main/project";
async function launch(profile: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.PHOTO_EDITOR_HIDDEN = "1";
  env.PHOTO_EDITOR_DATA = profile;
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
    ({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [p.input],
      });
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: p.output,
      });
    },
    { input, output },
  );
}
async function saved(page: Page) {
  await expect(page.getByRole("button", { name: /Export PNG/ })).toBeEnabled();
  await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
    "Saved",
  );
}
async function fixture(dir: string) {
  const input = join(dir, "Colour.png"),
    raw = Buffer.alloc(64 * 48 * 4);
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      raw[i] = 40 + x;
      raw[i + 1] = 60;
      raw[i + 2] = 80;
      raw[i + 3] = x < 8 ? x * 32 : 255;
    }
  await writeFile(
    input,
    await sharp(raw, { raw: { width: 64, height: 48, channels: 4 } })
      .png()
      .toBuffer(),
  );
  return input;
}

test("hidden Gate 5 adjustments: compare, cancel, apply, alpha, undo and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-adjust-ui-")),
    profile = join(dir, "profile"),
    input = await fixture(dir),
    output = join(dir, "adjusted.png");
  let app = await launch(profile);
  try {
    let page = await app.firstWindow();
    await choose(app, input, output);
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await saved(page);
    const library = new Library(join(profile, "projects")),
      id = (await library.recent())[0].id,
      before = (await library.load(id)).document;
    await page
      .getByRole("button", { name: "Adjustments", exact: true })
      .click();
    await page.getByLabel("Exposure (EV)", { exact: true }).fill("1");
    await page
      .getByRole("button", { name: "Preview adjustments", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Apply adjustments" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: /Export PNG/ }),
    ).toBeDisabled();
    expect((await library.load(id)).document).toEqual(before);
    await page.getByRole("button", { name: "Show before" }).click();
    await expect(page.locator("footer")).toContainText("Before adjustments");
    await page.getByRole("button", { name: "Show after" }).click();
    await expect(page.locator("footer")).toContainText("After adjustments");
    await page.getByRole("button", { name: "Cancel adjustments" }).click();
    await saved(page);
    expect((await library.load(id)).document).toEqual(before);
    await page.getByRole("button", { name: "Preview adjustments" }).click();
    await page.getByRole("button", { name: "Show before" }).click();
    await page.getByRole("button", { name: "Apply adjustments" }).click();
    await saved(page);
    const changed = (await library.load(id)).document;
    expect(changed.layers[0]).toMatchObject({
      original: (before.layers[0] as any).original,
    });
    expect((changed.layers[0] as any).asset).not.toBe(
      (before.layers[0] as any).asset,
    );
    await page.getByRole("button", { name: /Export PNG/ }).click();
    await expect(page.locator("footer")).toContainText("exported successfully");
    const image = await sharp(output).ensureAlpha().raw().toBuffer(),
      original = await sharp(input).ensureAlpha().raw().toBuffer();
    expect(image[32 * 4]).toBe(101);
    expect(image[32 * 4 + 1]).toBe(85);
    expect(Array.from(image).filter((_, i) => i % 4 === 3)).toEqual(
      Array.from(original).filter((_, i) => i % 4 === 3),
    );
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await saved(page);
    expect((await library.load(id)).document).toEqual(before);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await saved(page);
    await app.close();
    app = await launch(profile);
    page = await app.firstWindow();
    await page.getByRole("button", { name: /Colour.png/ }).click();
    const second = join(dir, "reopened.png");
    await choose(app, input, second);
    await page.getByRole("button", { name: /Export PNG/ }).click();
    await expect(page.locator("footer")).toContainText("exported successfully");
    expect(hashBytes(await readFile(second))).toBe(
      hashBytes(await readFile(output)),
    );
    expect(hashBytes(await readFile(input))).toBe(
      (before.layers[0] as any).original,
    );
  } catch (e) {
    app.process().kill();
    throw e;
  } finally {
    if (app.process().exitCode === null) await app.close();
  }
});

test("hidden Gate 5 versions: thumbnail, restore later work, portable copy from a new location", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-version-ui-")),
    profile = join(dir, "first"),
    input = await fixture(dir),
    archive = join(dir, "portable.stillwell");
  let app = await launch(profile);
  try {
    let page = await app.firstWindow();
    await choose(app, input, archive);
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await saved(page);
    const library = new Library(join(profile, "projects")),
      id = (await library.recent())[0].id;
    await page.getByRole("button", { name: "Versions", exact: true }).click();
    await page.getByLabel("Checkpoint name").fill("Before move");
    await page.getByRole("button", { name: "Save checkpoint" }).click();
    await expect(page.getByAltText("Preview of Before move")).toHaveJSProperty(
      "naturalWidth",
      200,
    );
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByLabel("X position", { exact: true }).fill("9");
    await saved(page);
    await page.getByRole("button", { name: "Versions", exact: true }).click();
    const row = page
      .locator(".project-row")
      .filter({ has: page.getByText("Before move", { exact: true }) });
    await row.getByRole("button", { name: "Restore", exact: true }).click();
    await saved(page);
    expect((await library.load(id)).document.layers[0].transform[4]).toBe(0);
    const later = (await library.checkpoints(id)).find((c) =>
      c.name.startsWith("Before restore"),
    )!;
    expect(
      (await library.preview(id, later.id)).document.layers[0].transform[4],
    ).toBe(9);
    await page.getByRole("button", { name: "Versions", exact: true }).click();
    await page
      .getByRole("button", { name: "Export portable project", exact: true })
      .click();
    await expect(page.locator("footer")).toContainText(
      "Portable project exported",
    );
    await app.close();
    await unlink(input);
    const moved = join(dir, "moved.stillwell");
    await rename(archive, moved);
    const secondProfile = join(dir, "second");
    app = await launch(secondProfile);
    page = await app.firstWindow();
    await choose(app, moved, join(dir, "portable-export.png"));
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page
      .getByRole("button", { name: "Open portable project", exact: true })
      .click();
    await saved(page);
    await expect(page.locator("footer")).toContainText("new local copy");
    const secondLibrary = new Library(join(secondProfile, "projects")),
      copied = (await secondLibrary.recent())[0].id;
    expect(copied).not.toBe(id);
    expect((await secondLibrary.load(copied)).document.layers).toEqual(
      (await library.load(id)).document.layers,
    );
    expect(
      (await secondLibrary.checkpoints(copied)).some((c) =>
        c.name.startsWith("Before restore"),
      ),
    ).toBe(true);
    await page.getByRole("button", { name: /Export PNG/ }).click();
    await expect(page.locator("footer")).toContainText("exported successfully");
    const output = await sharp(join(dir, "portable-export.png")).metadata();
    expect([output.width, output.height]).toEqual([64, 48]);
  } catch (e) {
    app.process().kill();
    throw e;
  } finally {
    if (app.process().exitCode === null) await app.close();
  }
});

test("hidden Gate 5 shelf: reuse an image and text style across projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-shelf-ui-")),
    profile = join(dir, "profile"),
    input = await fixture(dir);
  const app = await launch(profile);
  try {
    const page = await app.firstWindow();
    await choose(app, input, join(dir, "unused.png"));
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await saved(page);
    await page
      .getByRole("button", { name: "Local shelf", exact: true })
      .click();
    await page.getByLabel("Shelf name").fill("Reusable photo");
    await page.getByRole("button", { name: "Save selected to shelf" }).click();
    await expect(
      page.getByRole("button", { name: "Reusable photo", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await saved(page);
    await page.getByRole("button", { name: "Text tool", exact: true }).click();
    await page.getByLabel("Font size", { exact: true }).fill("31");
    await page.getByLabel("Font size", { exact: true }).press("Tab");
    await saved(page);
    await page.getByLabel("Curve amount").fill("-30");
    await page.getByLabel("Curve amount").press("Tab");
    await saved(page);
    await page
      .getByRole("button", { name: "Local shelf", exact: true })
      .click();
    await page.getByLabel("Shelf name").fill("Reusable heading");
    await page.getByRole("button", { name: "Save selected to shelf" }).click();
    await expect(
      page.getByRole("button", { name: "Reusable heading", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await saved(page);
    await page
      .getByRole("button", { name: "Local shelf", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Reusable photo", exact: true })
      .click();
    await saved(page);
    const library = new Library(join(profile, "projects")),
      id = (await library.recent())[0].id;
    expect((await library.load(id)).document.layers).toHaveLength(2);
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await saved(page);
    await page
      .getByRole("button", { name: "Local shelf", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Reusable heading", exact: true })
      .click();
    await saved(page);
    expect((await library.load(id)).document.layers[2]).toMatchObject({
      kind: "text",
      text: "Your text",
      fontSize: 31,
      curve: -30,
    });
    await page
      .getByRole("button", { name: "Remove Reusable photo from shelf" })
      .click();
    await expect(
      page.getByRole("button", { name: "Reusable photo", exact: true }),
    ).toHaveCount(0);
    expect((await library.load(id)).document.layers).toHaveLength(3);
  } catch (e) {
    app.process().kill();
    throw e;
  } finally {
    if (app.process().exitCode === null) await app.close();
  }
});
