import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, writeFile, readFile, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
const packaged = process.env.PHOTO_PACKAGED;
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
    ...(packaged ? { executablePath: packaged, args: [] } : { args: ["."] }),
    env,
  });
  const window = await app.firstWindow();
  expect(await window.title()).toBe("Stillwell");
  expect(await app.evaluate(({ app }) => app.getName())).toBe("Stillwell");
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
    ),
  ).toBe(true);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => {
      w.setIgnoreMouseEvents(true);
      w.webContents.setBackgroundThrottling(false);
    }),
  );
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
test("daily workflow: undo, checkpoint, crop, restart without source, canvas, JPEG/WebP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-daily-"));
  const profile = join(dir, "profile");
  await mkdir(profile);
  const input = join(dir, "Daily.png");
  const data = Buffer.alloc(80 * 40 * 4);
  for (let y = 0; y < 40; y++)
    for (let x = 0; x < 80; x++) {
      const i = (y * 80 + x) * 4;
      data[i] = x < 40 ? 240 : 20;
      data[i + 1] = 80;
      data[i + 2] = x < 40 ? 40 : 230;
      data[i + 3] = 255;
    }
  await writeFile(
    input,
    await sharp(data, { raw: { width: 80, height: 40, channels: 4 } })
      .png()
      .toBuffer(),
  );
  let app = await launch(profile);
  try {
    await choose(app, input, join(dir, "crop.png"));
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    await page.getByRole("spinbutton", { name: "X position" }).fill("10");
    await expect(
      page.getByRole("button", { name: "Undo", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(
      page.getByRole("spinbutton", { name: "X position" }),
    ).toHaveValue("0");
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(
      page.getByRole("spinbutton", { name: "X position" }),
    ).toHaveValue("10");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByRole("button", { name: "Versions", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Checkpoint name" })
      .fill("Before crop");
    await page
      .getByRole("button", { name: "Save checkpoint", exact: true })
      .click();
    await expect(page.getByText("Before crop", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Crop and size" }).click();
    await page.getByRole("spinbutton", { name: "Size width" }).fill("40");
    await page.getByRole("spinbutton", { name: "Size height" }).fill("20");
    await page.getByRole("spinbutton", { name: "Crop left" }).fill("20");
    await page.getByRole("spinbutton", { name: "Crop top" }).fill("10");
    await page.getByRole("button", { name: "Preview size" }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("80 × 40 px", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Preview size" }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    await page.getByRole("button", { name: "Export PNG" }).click();
    await expect(page.locator("footer")).toContainText(
      "PNG exported successfully",
    );
    const cropped = await sharp(join(dir, "crop.png"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([cropped.info.width, cropped.info.height]).toEqual([40, 20]);
    expect(cropped.data[0]).toBe(240);
    expect(cropped.data[39 * 4 + 2]).toBe(230);
    await app.close();
    await rename(input, input + ".moved");
    app = await launch(profile);
    page = await app.firstWindow();
    await page.getByRole("button", { name: /Daily.png/ }).click();
    await expect(page.getByText("40 × 20 px", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Crop and size" }).click();
    await page
      .getByRole("combobox", { name: "Size action" })
      .selectOption("canvas");
    await page.getByRole("spinbutton", { name: "Size width" }).fill("60");
    await page.getByRole("spinbutton", { name: "Size height" }).fill("60");
    await page.getByRole("button", { name: "Preview size" }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    for (const format of ["jpeg", "webp"] as const) {
      const output = join(dir, "result." + format);
      await choose(app, input, output);
      await page
        .getByRole("combobox", { name: "Export format" })
        .selectOption(format);
      await page
        .getByRole("button", { name: "Export " + format.toUpperCase() })
        .click();
      await expect(page.locator("footer")).toContainText(
        "exported successfully",
      );
      const result = await sharp(output)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([result.info.width, result.info.height]).toEqual([60, 60]);
      if (format === "jpeg") {
        expect(result.data[0]).toBeGreaterThan(245);
        expect(result.data[3]).toBe(255);
      } else expect(result.data[3]).toBe(0);
    }
    await page.getByRole("button", { name: "Versions", exact: true }).click();
    await page
      .locator(".project-row")
      .filter({ has: page.getByText("Before crop", { exact: true }) })
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await expect(page.getByText("80 × 40 px", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Versions", exact: true }).click();
    await expect(page.getByText(/Before restore/)).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.screenshot({ path: "test-results/gate-1-workspace.png" });
    await page.getByRole("button", { name: "Toggle arrange settings" }).click();
    await page
      .getByRole("button", { name: "Flip horizontal", exact: true })
      .click();
    await page.getByRole("button", { name: "Rotate 90°", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Export format" })
      .selectOption("png");
    await choose(app, input, join(dir, "rotated.png"));
    await page.getByRole("button", { name: "Export PNG" }).click();
    await expect(page.locator("footer")).toContainText(
      "PNG exported successfully",
    );
    const rotated = await sharp(join(dir, "rotated.png"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([rotated.info.width, rotated.info.height]).toEqual([40, 80]);
    expect(rotated.data[(10 * 40 + 10) * 4 + 2]).toBe(230);
    expect(rotated.data[(70 * 40 + 10) * 4]).toBe(240);
    await page.getByRole("button", { name: "Crop and size" }).click();
    await page
      .getByRole("combobox", { name: "Size action" })
      .selectOption("resize");
    await page.getByRole("spinbutton", { name: "Size width" }).fill("80");
    await expect(
      page.getByRole("spinbutton", { name: "Size height" }),
    ).toHaveValue("160");
    await page.getByRole("button", { name: "Preview size" }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await choose(app, input, join(dir, "resized.png"));
    await page.getByRole("button", { name: "Export PNG" }).click();
    await expect(page.locator("footer")).toContainText(
      "PNG exported successfully",
    );
    expect((await sharp(join(dir, "resized.png")).metadata()).width).toBe(80);
  } finally {
    await app.close();
  }
});

test("save failure stays visible and close is blocked until retry succeeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-save-failure-"));
  const profile = join(dir, "profile");
  await mkdir(profile);
  const input = join(dir, "Failure.png");
  await writeFile(
    input,
    await sharp({
      create: { width: 32, height: 32, channels: 4, background: "red" },
    })
      .png()
      .toBuffer(),
  );
  const app = await launch(profile);
  try {
    await choose(app, input, join(dir, "out.png"));
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    const rows = await page.evaluate(() => window.photo.recent());
    const revisions = join(profile, "projects", rows[0].id, "revisions");
    await rename(revisions, revisions + ".held");
    await writeFile(revisions, "Blocked by fixture");
    await page.getByRole("spinbutton", { name: "X position" }).fill("7");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Save failed",
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect(page.getByRole("alert")).toContainText("Save failed");
    await rename(revisions, revisions + ".obstruction");
    await rename(revisions + ".held", revisions);
    await page.getByRole("button", { name: "Retry save" }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    expect((await page.evaluate(() => window.photo.recent())).length).toBe(1);
  } finally {
    await app.close();
  }
});

test("drop and clipboard imports are saved; immediate close flushes the last edit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-input-"));
  const profile = join(dir, "profile");
  await mkdir(profile);
  const bytes = await sharp({
    create: { width: 64, height: 48, channels: 4, background: "#5588aa" },
  })
    .png()
    .toBuffer();
  const app = await launch(profile);
  let closed = false;
  try {
    const page = await app.firstWindow();
    await expect(page.locator("main")).toBeVisible();
    await page.evaluate(async (data) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(data)], "Dropped.png", { type: "image/png" }),
      );
      document
        .querySelector("main")!
        .dispatchEvent(
          new DragEvent("drop", { bubbles: true, dataTransfer: transfer }),
        );
    }, Array.from(bytes));
    await expect(page.getByText("64 × 48 px", { exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    // Stub the clipboard read only; never replace or inspect the user's clipboard.
    await app.evaluate(({ clipboard }, data) => {
      clipboard.read = async () =>
        [
          {
            types: ["image/png"],
            getType: async () =>
              new Blob([new Uint8Array(data)], { type: "image/png" }),
          },
        ] as any;
    }, Array.from(bytes));
    await page
      .getByRole("button", { name: "Paste image", exact: true })
      .click();
    await expect(page.locator("footer")).toContainText(
      "Pasted image saved locally",
    );
    await page.getByRole("spinbutton", { name: "X position" }).fill("13");
    const close = app.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await close;
    closed = true;
    const { Library } = await import("../src/main/library");
    const library = new Library(join(profile, "projects"));
    const rows = await library.recent();
    expect(rows.length).toBe(2);
    const pasted = rows.find((r) => r.name === "Pasted photo")!;
    expect(
      (await library.load(pasted.id)).document.layers[0].transform[4],
    ).toBe(13);
  } finally {
    if (!closed) await app.close();
  }
});
