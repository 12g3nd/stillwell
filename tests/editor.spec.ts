import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import sharp from "sharp";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashBytes, writeProject, readProject } from "../src/main/project";
import {
  documentSchema,
  type ImportResult,
  type PhotoDocument,
} from "../src/editor/model/document";
const executable = process.env.PHOTO_PACKAGED;
async function launch(scale = 1) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.PHOTO_EDITOR_HIDDEN = "1";
  env.PHOTO_EDITOR_DATA = await mkdtemp(join(tmpdir(), "photo-gate0-profile-"));
  const app = await electron.launch({
    ...(executable
      ? {
          executablePath: executable,
          args: [`--force-device-scale-factor=${scale}`],
        }
      : { args: [".", `--force-device-scale-factor=${scale}`] }),
    env,
  });
  const page = await app.firstWindow();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: scale,
    mobile: false,
  });
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
    ),
  ).toBe(true);
  // Isolate CDP pointer input from the user's physical desktop mouse.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.setBackgroundThrottling(false);
      window.setIgnoreMouseEvents(true);
    }),
  );
  return app;
}
async function choose(app: ElectronApplication, input: string, output: string) {
  await app.evaluate(
    ({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [paths.input],
      });
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: paths.output,
      });
    },
    { input, output },
  );
}
test("canonical manifest validates boundaries and separate blobs round trip", async () => {
  const bytes = await sharp({
    create: { width: 8, height: 8, channels: 4, background: "#ed5b54" },
  })
    .png()
    .toBuffer();
  const id = hashBytes(bytes);
  const doc: PhotoDocument = {
    schemaVersion: 1,
    id: "fixture",
    name: "Fixture",
    width: 128,
    height: 96,
    colourSpace: "srgb",
    layers: [
      {
        id: "raster",
        name: "Masked coral",
        kind: "raster",
        visible: true,
        opacity: 1,
        original: id,
        asset: id,
        mask: id,
        transform: [0, 1, -1, 0, 64, 8],
      },
      {
        id: "text",
        name: "Editable title",
        kind: "text",
        visible: true,
        opacity: 1,
        transform: [1, 0, 0, 1, 4, 60],
        text: "Hello\nPhoto",
        fontFamily: "Arial",
        fontSize: 12,
        fill: "#24262a",
      },
    ],
  };
  const dir = await mkdtemp(join(tmpdir(), "photo-project-"));
  await writeProject(dir, doc, { [id]: bytes });
  const loaded = await readProject(dir);
  expect(loaded.document).toEqual(doc);
  expect(hashBytes(loaded.assets[id])).toBe(id);
  expect(
    documentSchema.safeParse({ ...doc, width: 12000, height: 12000 }).success,
  ).toBe(false);
  expect(
    documentSchema.safeParse({
      ...doc,
      layers: [{ ...doc.layers[0], asset: "../escape" }],
    }).success,
  ).toBe(false);
  await writeFile(join(dir, "assets", id), "bad");
  await expect(readProject(dir)).rejects.toThrow("checksum");
});
for (const scale of [1.25, 1.5])
  test(`native import, move, exact export and originals at ${scale * 100}%`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "photo-desktop-"));
    const input = join(dir, "oriented.jpg"),
      output = join(dir, "export.png");
    const original = await sharp({
      create: { width: 80, height: 40, channels: 3, background: "#ee5544" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    await writeFile(input, original);
    const app = await launch(scale);
    try {
      await choose(app, input, output);
      const page = await app.firstWindow();
      await page
        .getByRole("button", { name: "Open photo", exact: true })
        .click();
      await expect(page.getByText("40 × 80 px", { exact: true })).toBeVisible();
      await expect(page.locator("footer[role=status]")).toContainText(
        "Original preserved",
      );
      expect(await page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(
        scale,
        1,
      );
      await page.getByRole("button", { name: "100%", exact: true }).click();
      const target = page.locator(".upper-canvas");
      const box = (await target.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width / 2 + 8,
        box.y + box.height / 2 + 6,
        { steps: 4 },
      );
      await page.mouse.up();
      await expect(
        page.getByRole("spinbutton", { name: "X position" }),
      ).toHaveValue("8");
      await expect(
        page.getByRole("spinbutton", { name: "Y position" }),
      ).toHaveValue("6");
      await page.getByRole("checkbox", { name: "Document grid" }).check();
      await page.getByRole("button", { name: "Export PNG" }).click();
      await expect(page.locator("footer[role=status]")).toContainText(
        "PNG exported successfully",
      );
      const exported = await sharp(output)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([exported.info.width, exported.info.height]).toEqual([40, 80]);
      expect(exported.data[3]).toBe(0);
      expect(exported.data[(20 * 40 + 20) * 4 + 3]).toBe(255);
      expect(hashBytes(await readFile(input))).toBe(hashBytes(original));
      await choose(app, input, input);
      await page.getByRole("button", { name: "Export PNG" }).click();
      await expect(page.locator("footer[role=status]")).toContainText(
        "cannot be overwritten",
      );
      expect(hashBytes(await readFile(input))).toBe(hashBytes(original));
      await page.screenshot({ path: `test-results/workspace-${scale}.png` });
      expect(await page.evaluate(() => typeof (window as any).require)).toBe(
        "undefined",
      );
    } finally {
      await app.close();
    }
  });
test("real Fabric compositor: soft mask, affine transform, editable text and reload", async () => {
  test.skip(!!executable, "Proof harness is excluded from the packaged app");
  const rawRaster = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 240, g: 80, b: 40, alpha: 0.5 },
    },
  })
    .raw()
    .toBuffer();
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 8; x++) rawRaster[(y * 16 + x) * 4 + 3] = 255;
  const raster = await sharp(rawRaster, {
    raw: { width: 16, height: 16, channels: 4 },
  })
    .png()
    .toBuffer();
  const mask = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const asset = hashBytes(raster),
    maskId = hashBytes(mask);
  const doc: PhotoDocument = {
    schemaVersion: 1,
    id: "proof",
    name: "Alpha proof",
    width: 128,
    height: 96,
    colourSpace: "srgb",
    layers: [
      {
        id: "raster",
        name: "Soft mask",
        kind: "raster",
        visible: true,
        opacity: 1,
        original: asset,
        asset,
        mask: maskId,
        transform: [0, 2, -2, 0, 64, 8],
      },
      {
        id: "text",
        name: "Title",
        kind: "text",
        visible: true,
        opacity: 1,
        text: "Photo",
        fontFamily: "Arial",
        fontSize: 20,
        fill: "#24262a",
        transform: [1, 0, 0, 1, 4, 60],
      },
    ],
  };
  const dir = await mkdtemp(join(tmpdir(), "photo-composite-"));
  await writeProject(dir, doc, { [asset]: raster, [maskId]: mask });
  const loaded = await readProject(dir);
  const app = await launch();
  try {
    await app.firstWindow();
    const proofWindow = app.waitForEvent("window");
    await app.evaluate(async ({ BrowserWindow }, file) => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          offscreen: true,
          backgroundThrottling: false,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await w.loadFile(file);
    }, resolve("dist/proof.html"));
    const page = await proofWindow;
    await page.waitForFunction(() => !!window.proof);
    const wire = {
      document: loaded.document,
      assets: Object.fromEntries(
        Object.entries(loaded.assets).map(([k, v]) => [k, Array.from(v)]),
      ),
    };
    const out = await page.evaluate(async (wire) => {
      const input = {
        document: wire.document,
        assets: Object.fromEntries(
          Object.entries(wire.assets).map(([k, v]) => [k, new Uint8Array(v)]),
        ),
      } as ImportResult;
      return {
        png: await window.proof.render(input),
        preview: await window.proof.preview(input),
      };
    }, wire);
    const { data, info } = await sharp(Buffer.from(out.png))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([128, 96]);
    const pixel = (x: number, y: number) =>
      Array.from(data.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4));
    expect(pixel(0, 0)[3]).toBe(0);
    expect(pixel(48, 32)[3]).toBeGreaterThanOrEqual(63);
    expect(pixel(48, 32)[3]).toBeLessThanOrEqual(65);
    expect(pixel(48, 16)[3]).toBeGreaterThanOrEqual(127);
    expect(pixel(48, 16)[3]).toBeLessThanOrEqual(129);
    expect(pixel(48, 32)[0]).toBeGreaterThan(235);
    expect(pixel(70, 24)[3]).toBe(0);
    expect(
      Math.max(...Array.from(data, (v, i) => Math.abs(v - out.preview[i]))),
    ).toBeLessThanOrEqual(1);
    let textPixels = 0;
    for (let y = 60; y < 90; y++)
      for (let x = 4; x < 90; x++) if (pixel(x, y)[3] > 0) textPixels++;
    expect(textPixels).toBeGreaterThan(100);
    expect(loaded.document).toEqual(doc);
  } finally {
    await app.close();
  }
});

test("1920 × 1200 export is identical at 25%, 100% and 200%; pan and grid stay out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-wallpaper-"));
  const input = join(dir, "Colour study.png");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1200"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#cddbe9"/><stop offset="1" stop-color="#f4d5b8"/></linearGradient></defs><rect width="1920" height="1200" fill="url(#sky)"/><circle cx="1370" cy="330" r="155" fill="#e99c6b"/><path d="M0 840 Q350 250 820 800 T1920 650 V1200 H0Z" fill="#799c95"/><path d="M0 1060 Q540 520 1100 920 T1920 850 V1200 H0Z" fill="#3d6769"/><path d="M0 1130 Q600 850 1100 1060 T1920 1010 V1200 H0Z" fill="#25494f"/></svg>`;
  await writeFile(input, await sharp(Buffer.from(svg)).png().toBuffer());
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await choose(app, input, join(dir, "25.png"));
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await expect(
      page.getByText("1920 × 1200 px", { exact: true }),
    ).toBeVisible();
    await page.getByRole("checkbox", { name: "Document grid" }).check();
    let reference = "";
    for (const zoom of [25, 100, 200]) {
      await page
        .getByRole("spinbutton", { name: "Zoom percent" })
        .fill(String(zoom));
      const output = join(dir, `${zoom}.png`);
      await choose(app, input, output);
      await page.getByRole("button", { name: "Export PNG" }).click();
      await expect(page.locator("footer")).toContainText(
        "PNG exported successfully",
      );
      const data = await sharp(output)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([data.info.width, data.info.height]).toEqual([1920, 1200]);
      const hash = hashBytes(data.data);
      if (reference) expect(hash).toBe(reference);
      else reference = hash;
    }
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    const box = (await page.locator(".upper-canvas").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Space");
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 20,
      box.y + box.height / 2 + 15,
    );
    await page.mouse.up();
    await page.keyboard.up("Space");
    await expect(
      page.getByRole("spinbutton", { name: "X position" }),
    ).toHaveValue("0");
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.getByRole("checkbox", { name: "Document grid" }).uncheck();
    await page.screenshot({ path: "test-results/workspace-colour-study.png" });
  } finally {
    await app.close();
  }
});
