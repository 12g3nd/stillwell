import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { hashBytes } from "../src/main/project";
import type { PhotoDocument, Layer, Blend } from "../src/editor/model/document";
test("hidden Fabric groups isolate nested opacity and render Normal/Multiply/Screen expected pixels", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.PHOTO_EDITOR_DATA = await mkdtemp(join(tmpdir(), "photo-groups-render-"));
  env.PHOTO_EDITOR_HIDDEN = "1";
  const app = await electron.launch({ args: ["."], env });
  try {
    await app.firstWindow();
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
    const newWindow = app.waitForEvent("window");
    await app.evaluate(async ({ BrowserWindow }, path) => {
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
      await w.loadFile(path);
    }, resolve("dist/proof.html"));
    const page = await newWindow;
    await page.waitForFunction(() => !!window.proof);
    const assets: Record<string, number[]> = {};
    async function asset(color: string) {
      const bytes = await sharp({
        create: { width: 16, height: 16, channels: 4, background: color },
      })
        .png()
        .toBuffer();
      const id = hashBytes(bytes);
      assets[id] = Array.from(bytes);
      return id;
    }
    const red = await asset("#ff0000"),
      blue = await asset("#0000ff"),
      back = await asset("#6496c8"),
      front = await asset("#c86432");
    const raster = (id: string, hash: string, x = 0): Layer => ({
      id,
      kind: "raster",
      name: id,
      original: hash,
      asset: hash,
      visible: true,
      opacity: 1,
      transform: [1, 0, 0, 1, x, 0],
    });
    const group = (
      id: string,
      children: Layer[],
      opacity = 0.5,
      blend: Blend = "source-over",
    ): Layer => ({
      id,
      kind: "group",
      name: id,
      visible: true,
      opacity,
      blend,
      transform: [1, 0, 0, 1, 0, 0],
      children,
    });
    async function render(layers: Layer[]) {
      const document: PhotoDocument = {
        schemaVersion: 2,
        id: "proof",
        name: "Groups",
        width: 64,
        height: 64,
        colourSpace: "srgb",
        layers,
      };
      const bytes = await page.evaluate(
        async (data) =>
          window.proof.render({
            document: data.document,
            assets: Object.fromEntries(
              Object.entries(data.assets).map(([k, v]) => [
                k,
                new Uint8Array(v),
              ]),
            ),
          }),
        { document, assets },
      );
      const { data } = await sharp(Buffer.from(bytes))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return (x: number, y: number) =>
        Array.from(data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
    }
    let pixels = await render([
      group("g", [raster("r", red), raster("b", blue, 8)]),
    ]);
    expect(pixels(4, 4)[3]).toBe(128);
    expect(pixels(12, 4)[3]).toBe(128);
    expect(pixels(12, 4)[2]).toBe(255);
    expect(pixels(40, 40)[3]).toBe(0);
    pixels = await render([
      group("outer", [
        group("inner", [raster("r", red), raster("b", blue, 8)]),
      ]),
    ]);
    expect(pixels(12, 4)[3]).toBe(64);
    const shifted = group(
      "shifted",
      [{ ...raster("r", red), transform: [1, 0, 0, 1, 20, 20] }],
      1,
    );
    shifted.transform = [0, 1, -1, 0, 50, 0];
    pixels = await render([shifted]);
    expect(pixels(25, 25)).toEqual([255, 0, 0, 255]);
    expect(pixels(5, 5)[3]).toBe(0);
    for (const [blend, expected] of [
      ["source-over", [200, 100, 50]],
      ["multiply", [78, 59, 39]],
      ["screen", [222, 191, 211]],
    ] as const) {
      pixels = await render([
        raster("background", back),
        { ...raster("foreground", front), blend },
      ]);
      pixels(4, 4)
        .slice(0, 3)
        .forEach((v, i) =>
          expect(Math.abs(v - expected[i])).toBeLessThanOrEqual(1),
        );
      pixels = await render([
        raster("background", back),
        group("blended", [raster("foreground", front)], 1, blend),
      ]);
      pixels(4, 4)
        .slice(0, 3)
        .forEach((v, i) =>
          expect(Math.abs(v - expected[i])).toBeLessThanOrEqual(1),
        );
    }
    // Child Multiply is evaluated on an isolated transparent backdrop, not on the root.
    pixels = await render([
      raster("background", back),
      group(
        "isolation",
        [{ ...raster("foreground", front), blend: "multiply" }],
        1,
      ),
    ]);
    expect(pixels(4, 4)).toEqual([200, 100, 50, 255]);
  } finally {
    await app.close();
  }
});
