import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import {
  mkdtemp,
  writeFile,
  readFile,
  unlink,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { Library } from "../src/main/library";
import { references, hashBytes } from "../src/main/project";
import { documentSchema } from "../src/editor/model/document";
import { textStyleSchema } from "../src/editor/model/text";
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
async function field(page: Page, name: string, value: string) {
  await page.getByLabel(name, { exact: true }).fill(value);
  await page.getByLabel(name, { exact: true }).press("Tab");
  await saved(page);
}
async function fixture(dir: string) {
  const path = join(dir, "Poster.png");
  await writeFile(
    path,
    await sharp({
      create: { width: 600, height: 500, channels: 4, background: "#e7e7e7" },
    })
      .png()
      .toBuffer(),
  );
  return path;
}
test("hidden typography: editable poster, imported font, styles and exact export after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-type-")),
    profile = join(dir, "profile"),
    input = await fixture(dir),
    output = join(dir, "finished-poster.png"),
    font = join(dir, "PosterFace.ttf");
  // Fixed system test face; no user font folders or photographs are scanned.
  await copyFile(
    join(process.env.WINDIR ?? "C:\\Windows", "Fonts", "arial.ttf"),
    font,
  );
  let app = await launch(profile);
  try {
    let page = await app.firstWindow();
    await choose(app, input, output);
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await saved(page);
    await page.getByRole("button", { name: "Text tool", exact: true }).click();
    await expect(
      page.getByLabel("Font face").locator("option"),
    ).not.toHaveCount(0);
    const listing = await page.evaluate(async () => {
      const q = (window as any).queryLocalFonts;
      try {
        return { count: (await q.call(window)).length };
      } catch (e) {
        return { error: String(e) };
      }
    });
    expect(listing.count).toBeGreaterThan(0);
    await expect(
      page.getByLabel("Font face").locator("option"),
    ).not.toHaveCount(1);
    await page.getByLabel("Font face").selectOption("ArialMT");
    await saved(page);
    await page
      .getByRole("button", { name: "Edit on canvas", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Done editing text" }),
    ).toBeVisible();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Editing text…",
    );
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText(
      "A quieter afternoon\nColour, light and room to think.",
    );
    await page.getByRole("button", { name: "Done editing text" }).click();
    await saved(page);
    const library = new Library(join(profile, "projects")),
      id = (await library.recent())[0].id;
    let doc = (await library.load(id)).document;
    expect(doc.layers[1]).toMatchObject({
      text: "A quieter afternoon\nColour, light and room to think.",
      transform: [1, 0, 0, 1, 40, 40],
    });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await saved(page);
    expect((await library.load(id)).document.layers[1]).toMatchObject({
      text: "Your text",
    });
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await saved(page);
    await choose(app, font, output);
    await page
      .getByRole("button", { name: "Import font file", exact: true })
      .click();
    await saved(page);
    await expect(page.locator("footer[role=status]")).toContainText(
      "Font imported",
    );
    await page
      .getByRole("checkbox", { name: "Wrap text", exact: true })
      .check();
    await saved(page);
    await field(page, "Text box width", "390");
    await field(page, "Font size", "36");
    await field(page, "Line spacing", "1.4");
    await field(page, "Letter spacing", "1.5");
    for (const name of ["Bold", "Italic", "Underline"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await saved(page);
    }
    await page.getByLabel("Paragraph alignment").selectOption("center");
    await saved(page);
    for (const name of ["Text background", "Text outline", "Text shadow"]) {
      await page.getByRole("checkbox", { name, exact: true }).check();
      await saved(page);
    }
    await field(page, "Outline width", "2");
    await field(page, "Shadow blur", "4");
    await page
      .getByRole("button", { name: "Favourite font", exact: true })
      .click();
    await saved(page);
    await page.getByLabel("Text style name").fill("Poster heading");
    await page
      .getByRole("button", { name: "Save text style", exact: true })
      .click();
    await saved(page);
    doc = (await library.load(id)).document;
    const heading = doc.layers[1];
    if (heading.kind !== "text") throw Error("Fixture");
    expect(heading.fontAsset).toBe(hashBytes(await readFile(font)));
    expect(doc.fontFavourites).toHaveLength(1);
    expect(doc.textPresets).toHaveLength(1);
    await page
      .getByRole("button", { name: "Add text layer", exact: true })
      .click();
    await saved(page);
    await page
      .getByRole("button", { name: "Poster heading", exact: true })
      .click();
    await saved(page);
    const styled = (await library.load(id)).document.layers[2];
    expect(styled).toMatchObject({
      kind: "text",
      text: "Your text",
      fontAsset: heading.fontAsset,
      wrapWidth: 390,
      fontWeight: 700,
      shadow: heading.shadow,
    });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await saved(page);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await saved(page);
    await page.getByRole("button", { name: /Export PNG/ }).click();
    await expect(page.locator("footer[role=status]")).toContainText(
      "exported successfully",
    );
    const exported = await readFile(output),
      pixels = await sharp(exported).raw().toBuffer();
    expect(pixels.some((v, i) => i % 4 !== 3 && v !== 231)).toBe(true);
    doc = (await library.load(id)).document;
    expect(references(doc)).toContain(heading.fontAsset);
    await app.close();
    await unlink(font);
    await unlink(input);
    app = await launch(profile);
    page = await app.firstWindow();
    await page.getByRole("button", { name: /Poster.png/ }).click();
    await page
      .getByRole("button", { name: "Select Text", exact: true })
      .click();
    await page.getByRole("button", { name: "Text tool", exact: true }).click();
    await expect(page.getByLabel("Text content", { exact: true })).toHaveValue(
      heading.text,
    );
    await expect(
      page.getByRole("button", { name: "Remove favourite font", exact: true }),
    ).toBeVisible();
    const reopened = join(dir, "reopened.png");
    await choose(app, input, reopened);
    await page.getByRole("button", { name: /Export PNG/ }).click();
    await expect(page.locator("footer[role=status]")).toContainText(
      "exported successfully",
    );
    expect(await readFile(reopened)).toEqual(exported);
    expect((await library.load(id)).document).toEqual(doc);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
test("text style schema bounds settings and keeps font assets used only by presets", () => {
  expect(
    textStyleSchema.safeParse({
      fontFamily: "Arial",
      fontSize: 36,
      fill: "#24262a",
      shadow: { color: "red", blur: 4, offsetX: 0, offsetY: 0 },
    }).success,
  ).toBe(false);
  expect(
    textStyleSchema.safeParse({
      fontFamily: "Arial",
      fontSize: 1001,
      fill: "#24262a",
    }).success,
  ).toBe(false);
  const d = documentSchema.parse({
    schemaVersion: 2,
    id: "fixture",
    name: "styles",
    width: 10,
    height: 10,
    colourSpace: "srgb",
    layers: [],
    fontFavourites: [{ fontFamily: "Stored", fontAsset: "a".repeat(64) }],
    textPresets: [
      {
        id: "d0590c3a-e64a-4191-886a-79906478d0f9",
        name: "Heading",
        style: {
          fontFamily: "Stored",
          fontAsset: "b".repeat(64),
          fontSize: 36,
          fill: "#24262a",
        },
      },
    ],
  });
  expect(references(d)).toEqual(["a".repeat(64), "b".repeat(64)]);
});

test("hidden typography: cancel, invalid font, keyboard save and close while typing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-type-edit-")),
    profile = join(dir, "profile"),
    input = await fixture(dir),
    badFont = join(dir, "Invalid.ttf");
  await writeFile(badFont, Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const app = await launch(profile);
  let closed = false;
  try {
    const page = await app.firstWindow();
    await choose(app, input, join(dir, "unused.png"));
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await saved(page);
    await page.getByRole("button", { name: "Text tool", exact: true }).click();
    const library = new Library(join(profile, "projects")),
      id = (await library.recent())[0].id,
      original = (await library.load(id)).document;
    await page.getByRole("button", { name: "100%", exact: true }).click();
    const box = (await page.locator(".paper").boundingBox())!;
    await page.mouse.dblclick(box.x + 70, box.y + 65);
    await expect(
      page.getByRole("button", { name: "Done editing text" }),
    ).toBeVisible();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("Discard this draft");
    await page.keyboard.press("Escape");
    await saved(page);
    expect((await library.load(id)).document).toEqual(original);
    await choose(app, badFont, join(dir, "unused.png"));
    await page
      .getByRole("button", { name: "Import font file", exact: true })
      .click();
    await saved(page);
    await expect(page.locator("footer[role=status]")).toContainText(
      "Font unavailable or invalid",
    );
    expect((await library.load(id)).document).toEqual(original);
    await page
      .getByRole("button", { name: "Edit on canvas", exact: true })
      .click();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("Saved with keyboard\nStill editable");
    await page.keyboard.press("Control+s");
    await saved(page);
    expect((await library.load(id)).document.layers[1]).toMatchObject({
      text: "Saved with keyboard\nStill editable",
    });
    await page
      .getByRole("button", { name: "Edit on canvas", exact: true })
      .click();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("Finish this before closing");
    const close = app.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await close;
    closed = true;
    expect((await library.load(id)).document.layers[1]).toMatchObject({
      text: "Finish this before closing",
      transform: [1, 0, 0, 1, 40, 40],
    });
  } finally {
    if (!closed) await app.close();
  }
});

test("hidden typography: nested text edits keep group structure and local placement", async () => {
  const profile = await mkdtemp(join(tmpdir(), "photo-type-nested-")),
    id = randomUUID();
  const library = new Library(join(profile, "projects"));
  await library.save(
    documentSchema.parse({
      schemaVersion: 2,
      id,
      name: "Nested poster",
      width: 600,
      height: 500,
      colourSpace: "srgb",
      layers: [
        {
          kind: "group",
          id: "group",
          name: "Title group",
          visible: true,
          opacity: 1,
          transform: [1, 0, 0, 1, 60, 40],
          children: [
            {
              kind: "text",
              id: "title",
              name: "Title",
              text: "Before",
              fontFamily: "Arial",
              fontSize: 36,
              fill: "#24262a",
              visible: true,
              opacity: 1,
              transform: [1, 0, 0, 1, 10, 20],
            },
          ],
        },
      ],
    }),
    {},
  );
  const app = await launch(profile);
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: /Nested poster/ }).click();
    await page
      .getByRole("button", { name: "Select Title", exact: true })
      .click();
    await page.getByRole("button", { name: "Text tool", exact: true }).click();
    await page
      .getByRole("button", { name: "Edit on canvas", exact: true })
      .click();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("After\nStill nested");
    await page.keyboard.press("Control+Enter");
    await saved(page);
    const doc = (await library.load(id)).document,
      group = doc.layers[0];
    expect(group).toMatchObject({
      id: "group",
      transform: [1, 0, 0, 1, 60, 40],
    });
    if (group.kind !== "group") throw Error("Missing group");
    expect(group.children[0]).toMatchObject({
      id: "title",
      text: "After\nStill nested",
      transform: [1, 0, 0, 1, 10, 20],
    });
    await page
      .getByRole("button", { name: "Lock Title group", exact: true })
      .click();
    await saved(page);
    await expect(
      page.getByRole("button", { name: "Edit on canvas", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await saved(page);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await saved(page);
    const original = (await library.load(id)).document.layers[0];
    expect(original.kind === "group" && original.children[0]).toMatchObject({
      text: "Before",
    });
  } finally {
    await app.close();
  }
});

test("hidden typography: curve and warp remain editable through styles, undo and restart", async () => {
  let closed = false;
  const dir = await mkdtemp(join(tmpdir(), "photo-shape-"));
  const profile = join(dir, "profile"),
    input = await fixture(dir),
    output = join(dir, "shaped.png"),
    font = join(dir, "ShapeFace.ttf");
  await copyFile(
    join(process.env.WINDIR ?? "C:\\Windows", "Fonts", "arial.ttf"),
    font,
  );
  let app = await launch(profile);
  try {
    let page = await app.firstWindow();
    await choose(app, input, output);
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await saved(page);
    await page.getByRole("button", { name: "Text tool", exact: true }).click();
    await choose(app, font, output);
    await page
      .getByRole("button", { name: "Import font file", exact: true })
      .click();
    await saved(page);
    await field(page, "Text content", "A softer shape\nMade for your wall");
    await field(page, "Font size", "24");
    await field(page, "Curve amount", "-45");
    await expect(
      page.getByRole("button", { name: "Edit on canvas", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("Warp shape", { exact: true }).selectOption("bulge");
    await saved(page);
    await field(page, "Warp amount", "55");
    await field(page, "Text content", "A softer shape\nStill editable");
    const library = new Library(join(profile, "projects")),
      id = (await library.recent())[0].id;
    let doc = (await library.load(id)).document;
    expect(doc.layers[1]).toMatchObject({
      kind: "text",
      text: "A softer shape\nStill editable",
      curve: -45,
      warp: { kind: "bulge", amount: 55 },
      transform: [1, 0, 0, 1, 40, 40],
    });
    await page.getByLabel("Text style name").fill("Shaped heading");
    await page
      .getByRole("button", { name: "Save text style", exact: true })
      .click();
    await saved(page);
    await page
      .getByRole("button", { name: "Reset curve and warp", exact: true })
      .click();
    await saved(page);
    await expect(
      page.getByRole("button", { name: "Edit on canvas", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await saved(page);
    await expect(page.getByLabel("Curve amount")).toHaveValue("-45");
    await page.getByLabel("Warp shape").selectOption("wave");
    await saved(page);
    await page
      .getByRole("button", { name: "Shaped heading", exact: true })
      .click();
    await saved(page);
    await expect(page.getByLabel("Warp shape")).toHaveValue("bulge");
    doc = (await library.load(id)).document;
    await page.getByRole("button", { name: /Export PNG/ }).click();
    await expect(page.locator("footer[role=status]")).toContainText(
      "exported successfully",
    );
    const exported = await readFile(output);
    await app.close();
    await unlink(font);
    await unlink(input);
    app = await launch(profile);
    page = await app.firstWindow();
    await page.getByRole("button", { name: /Poster.png/ }).click();
    await page
      .getByRole("button", { name: "Select Text", exact: true })
      .click();
    await page.getByRole("button", { name: "Text tool", exact: true }).click();
    await expect(page.getByLabel("Text content", { exact: true })).toHaveValue(
      "A softer shape\nStill editable",
    );
    await expect(page.getByLabel("Warp amount")).toHaveValue("55");
    const reopened = join(dir, "reopened.png");
    await choose(app, input, reopened);
    await page.getByRole("button", { name: /Export PNG/ }).click();
    await expect(page.locator("footer[role=status]")).toContainText(
      "exported successfully",
    );
    expect(hashBytes(await readFile(reopened))).toBe(hashBytes(exported));
    expect((await library.load(id)).document).toEqual(doc);
    await page
      .getByLabel("Text content", { exact: true })
      .fill("Edited after restart");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Editing text…",
    );
    await page.getByLabel("Text content", { exact: true }).press("Control+s");
    await saved(page);
    expect((await library.load(id)).document.layers[1]).toMatchObject({
      text: "Edited after restart",
      curve: -45,
      warp: { kind: "bulge", amount: 55 },
    });
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
  } catch (error) {
    app.process().kill();
    closed = true;
    throw error;
  } finally {
    if (!closed) await app.close();
  }
});

test("hidden typography: native close commits a pending shaped-text panel draft", async () => {
  const profile = await mkdtemp(join(tmpdir(), "photo-shape-close-")),
    id = randomUUID();
  const library = new Library(join(profile, "projects"));
  await library.save(
    documentSchema.parse({
      schemaVersion: 2,
      id,
      name: "Shaped draft",
      width: 600,
      height: 500,
      colourSpace: "srgb",
      layers: [
        {
          kind: "text",
          id: "title",
          name: "Title",
          text: "Before",
          fontFamily: "Arial",
          fontSize: 24,
          fill: "#24262a",
          curve: -45,
          warp: { kind: "bulge", amount: 55 },
          visible: true,
          opacity: 1,
          transform: [1, 0, 0, 1, 40, 40],
        },
      ],
    }),
    {},
  );
  const app = await launch(profile);
  let closed = false;
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: /Shaped draft/ }).click();
    await page
      .getByRole("button", { name: "Select Title", exact: true })
      .click();
    await page.getByRole("button", { name: "Text tool", exact: true }).click();
    await page
      .getByLabel("Text content", { exact: true })
      .fill("Saved while closing shaped text");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Editing text…",
    );
    const closing = app.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await closing;
    closed = true;
    expect((await library.load(id)).document.layers[0]).toMatchObject({
      text: "Saved while closing shaped text",
      curve: -45,
      warp: { kind: "bulge", amount: 55 },
      transform: [1, 0, 0, 1, 40, 40],
    });
  } catch (error) {
    app.process().kill();
    closed = true;
    throw error;
  } finally {
    if (!closed) await app.close();
  }
});
