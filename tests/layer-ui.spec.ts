import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Library } from "../src/main/library";
import { flattenLayers } from "../src/editor/model/document";
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
    ({ dialog }, v) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [v.input],
      });
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: v.output,
      });
    },
    { input, output },
  );
}
test("hidden layer workflow: import, name, multiselect, groups, locking, undo and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-layer-ui-")),
    profile = join(dir, "profile");
  await mkdir(profile);
  const base = join(dir, "Base.png"),
    accent = join(dir, "Accent.png"),
    output = join(dir, "layers.png");
  await writeFile(
    base,
    await sharp({
      create: { width: 128, height: 96, channels: 4, background: "#ff0000" },
    })
      .png()
      .toBuffer(),
  );
  await writeFile(
    accent,
    await sharp({
      create: { width: 16, height: 16, channels: 4, background: "#0000ff" },
    })
      .png()
      .toBuffer(),
  );
  let app = await launch(profile);
  try {
    let page = await app.firstWindow();
    await choose(app, base, output);
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Select Base.png", exact: true }),
    ).toBeVisible();
    await choose(app, accent, output);
    await page.getByRole("button", { name: "Add image", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Layer name", exact: true })
      .fill("Accent");
    await page
      .getByRole("textbox", { name: "Layer name", exact: true })
      .press("Tab");
    await expect(
      page.getByRole("button", { name: "Select Accent", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await page
      .getByRole("button", { name: "Select Text", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Text content", exact: true })
      .fill("Editable title");
    await page
      .getByRole("textbox", { name: "Text content", exact: true })
      .press("Tab");
    await page
      .getByRole("button", { name: "Select Accent", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Select Text", exact: true })
      .click({ modifiers: ["Control"] });
    await page.getByRole("button", { name: "Group", exact: true }).click();
    await page
      .getByRole("button", { name: "Select Group", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Layer name", exact: true })
      .fill("Card");
    await page
      .getByRole("textbox", { name: "Layer name", exact: true })
      .press("Tab");
    await page
      .getByRole("spinbutton", { name: "Layer opacity", exact: true })
      .fill("50");
    await page
      .getByRole("spinbutton", { name: "Layer opacity", exact: true })
      .press("Tab");
    await page.getByRole("button", { name: "Ungroup", exact: true }).click();
    await expect(page.locator("footer")).toContainText("opacity");
    await page.getByRole("button", { name: "Lock Card", exact: true }).click();
    await expect(
      page.getByRole("spinbutton", { name: "X position" }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Select Accent", exact: true })
      .click();
    await expect(
      page.getByRole("spinbutton", { name: "X position" }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Unlock Card", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Select Card", exact: true })
      .click();
    await page
      .getByRole("checkbox", { name: "Document grid", exact: true })
      .check();
    await page
      .getByRole("spinbutton", { name: "Guide position", exact: true })
      .fill("10");
    await page.getByRole("button", { name: "Add guide", exact: true }).click();
    await page
      .getByRole("checkbox", { name: "Snap to guides", exact: true })
      .check();
    await page.getByRole("button", { name: "Export PNG" }).click();
    await expect(page.locator("footer")).toContainText(
      "PNG exported successfully",
    );
    const pixels = await sharp(output).ensureAlpha().raw().toBuffer();
    expect(pixels[(8 * 128 + 8) * 4]).toBeGreaterThanOrEqual(126);
    expect(pixels[(8 * 128 + 8) * 4 + 2]).toBeGreaterThanOrEqual(127);
    await page
      .getByRole("button", { name: "Select Card", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Select Base.png", exact: true })
      .click({ modifiers: ["Control"] });
    await page.getByRole("button", { name: "Group", exact: true }).click();
    await page
      .getByRole("button", { name: "Select Group", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Layer name", exact: true })
      .fill("Composition");
    await page
      .getByRole("textbox", { name: "Layer name", exact: true })
      .press("Tab");
    await page.getByRole("button", { name: "Duplicate", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "Select Composition copy",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "Select Composition copy",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    const library = new Library(join(profile, "projects"));
    const rows = await library.recent();
    const saved = (await library.load(rows[0].id)).document;
    expect(saved.layers[0].kind).toBe("group");
    expect(
      flattenLayers(saved.layers).find((l) => l.kind === "text"),
    ).toMatchObject({ text: "Editable title" });
    expect(saved.guides?.[0].position).toBe(10);
    await app.close();
    app = await launch(profile);
    page = await app.firstWindow();
    await page.getByRole("button", { name: /Base.png/ }).click();
    await expect(
      page.getByRole("button", { name: "Select Composition", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Select Card", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Select Accent", exact: true }),
    ).toBeVisible();
    expect((await library.load(rows[0].id)).document).toEqual(saved);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test("hidden multiselect drag snaps once, undoes once, and a locked group cannot move", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-layer-drag-")),
    profile = join(dir, "profile");
  await mkdir(profile);
  const base = join(dir, "Base.png"),
    accent = join(dir, "Accent.png");
  await writeFile(
    base,
    await sharp({
      create: { width: 128, height: 96, channels: 4, background: "red" },
    })
      .png()
      .toBuffer(),
  );
  await writeFile(
    accent,
    await sharp({
      create: { width: 16, height: 16, channels: 4, background: "blue" },
    })
      .png()
      .toBuffer(),
  );
  const app = await launch(profile);
  try {
    const page = await app.firstWindow();
    await choose(app, base, join(dir, "unused.png"));
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await choose(app, accent, join(dir, "unused.png"));
    await page.getByRole("button", { name: "Add image", exact: true }).click();
    await page
      .getByRole("button", { name: "Select Base.png", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Select Accent.png", exact: true })
      .click({ modifiers: ["Control"] });
    await page
      .getByRole("checkbox", { name: "Snap to grid", exact: true })
      .check();
    await page.getByRole("button", { name: "100%", exact: true }).click();
    const box = (await page.locator(".paper").boundingBox())!;
    await page.mouse.move(box.x + 8, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 38, box.y + 8, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    const library = new Library(join(profile, "projects"));
    const id = (await library.recent())[0].id;
    expect(
      (await library.load(id)).document.layers.map((l) => l.transform[4]),
    ).toEqual([32, 32]);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    expect(
      (await library.load(id)).document.layers.map((l) => l.transform[4]),
    ).toEqual([0, 0]);
    await page.getByRole("button", { name: "Group", exact: true }).click();
    await page.getByRole("button", { name: "Lock Group", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    await page.mouse.move(box.x + 8, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 20, { steps: 4 });
    await page.mouse.up();
    expect((await library.load(id)).document.layers[0].transform).toEqual([
      1, 0, 0, 1, 0, 0,
    ]);
  } finally {
    await app.close();
  }
});
