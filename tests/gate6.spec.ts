import { test, expect, _electron as electron } from "@playwright/test";
import { Worker } from "node:worker_threads";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir, cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { validateSvg } from "../src/workers/compatibility";
import { Library } from "../src/main/library";
import { hashBytes } from "../src/main/project";
import { documentSchema } from "../src/editor/model/document";
import { randomUUID } from "node:crypto";

function decode(bytes: Uint8Array, exportFormat?: "png" | "jpeg" | "webp") {
  return new Promise<any>((res, rej) => {
    const worker = new Worker(resolve("dist/raster.cjs"));
    const timeout = setTimeout(() => {
      void worker.terminate();
      rej(Error("Worker timeout"));
    }, 30000);
    worker.once("error", rej);
    worker.once("message", (m) => {
      clearTimeout(timeout);
      void worker.terminate();
      m.error ? rej(Error(m.error)) : res(m.result);
    });
    worker.postMessage({
      id: "test",
      kind: exportFormat ? "export" : "import",
      bytes,
      width: 120,
      height: 80,
      options: exportFormat
        ? { format: exportFormat, dpi: 144, quality: 92, matte: "#ffffff" }
        : undefined,
    });
  });
}
// Tiny uncompressed, three-channel PSD with an explicit saved composite. No
// external photographs or Photoshop installation are needed for this fixture.
function psd() {
  const header = Buffer.alloc(40);
  header.write("8BPS");
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(3, 12);
  header.writeUInt32BE(2, 14);
  header.writeUInt32BE(3, 18);
  header.writeUInt16BE(8, 22);
  header.writeUInt16BE(3, 24);
  return Buffer.concat([
    header,
    Buffer.alloc(6, 255),
    Buffer.alloc(6, 32),
    Buffer.alloc(6, 64),
  ]);
}
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#13579b"/><circle cx="60" cy="40" r="12" fill="#ffffff"/></svg>';
test("Gate 6 worker compatibility: TIFF, geometry SVG, PSD composite and rejection boundaries", async () => {
  const tiff = await sharp({
    create: { width: 120, height: 80, channels: 4, background: "#13579b" },
  })
    .tiff({ compression: "lzw" })
    .toBuffer();
  for (const bytes of [tiff, Buffer.from(svg), psd()]) {
    const result = await decode(bytes),
      image = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
    expect(image.subarray(0, 3)).toEqual(
      bytes === tiff || bytes.toString().startsWith("<")
        ? Buffer.from([19, 87, 155])
        : Buffer.from([255, 32, 64]),
    );
    expect(result.warning).toBeTruthy();
  }
  const multi = await sharp({
    create: { width: 10, height: 20, channels: 3, background: "red" },
  })
    .raw()
    .toBuffer();
  const multiTiff = await sharp(multi, {
    raw: { width: 10, height: 20, channels: 3, pageHeight: 10 },
  })
    .tiff()
    .toBuffer();
  await expect(decode(multiTiff)).rejects.toThrow(/multipage/);
  for (const xml of [
    svg.replace("<rect", "<script/><rect"),
    svg.replace("<rect", '<image href="file:///C:/private.png"/><rect'),
    '<!DOCTYPE svg [<!ENTITY a SYSTEM "file:///C:/secret">]><svg>&a;</svg>',
    svg.replace('fill="#13579b"', 'fill="url(http://example.com/a)"'),
    svg.replace("<rect", "<foreignObject/><rect"),
    svg.replace("<rect", '<style>@import "https://example.com";</style><rect'),
  ])
    expect(() => validateSvg(Buffer.from(xml))).toThrow();
  const large = svg.replace('width="120"', 'width="12001"');
  await expect(decode(Buffer.from(large))).rejects.toThrow();
  const poster = svg.replace(
    'width="120" height="80"',
    'width="10800" height="14400"',
  );
  await expect(decode(Buffer.from(poster))).rejects.toThrow(
    /pixel limit|12,000/,
  );
  const cmyk = psd();
  cmyk.writeUInt16BE(4, 24);
  await expect(decode(cmyk)).rejects.toThrow(/8-bit RGB/);
  await expect(decode(Buffer.from("0000ftypheic"))).rejects.toThrow(/HEIC/);
  const png = await sharp(tiff).png().toBuffer();
  for (const format of ["png", "jpeg", "webp"] as const) {
    const exported = await decode(png, format);
    const metadata = await sharp(exported.bytes).metadata();
    expect(metadata.format).toBe(format);
    if (format !== "webp") expect(metadata.density).toBe(144);
    // WebP stores physical resolution in EXIF rather than a native density
    // field. Read its TIFF IFD directly instead of assuming Sharp exposes it.
    const exif = metadata.exif!;
    expect(exif).toBeTruthy();
    const base = exif.subarray(0, 4).toString() === "Exif" ? 6 : 0;
    const little = exif.subarray(base, base + 2).toString() === "II";
    const u16 = (at: number) =>
      little ? exif.readUInt16LE(at) : exif.readUInt16BE(at);
    const u32 = (at: number) =>
      little ? exif.readUInt32LE(at) : exif.readUInt32BE(at);
    const directory = base + u32(base + 4),
      tags = new Map<number, number>();
    for (let i = 0; i < u16(directory); i++) {
      const at = directory + 2 + i * 12,
        tag = u16(at);
      if (tag === 282 || tag === 283) {
        const offset = base + u32(at + 8);
        tags.set(tag, u32(offset) / u32(offset + 4));
      }
      if (tag === 296) tags.set(tag, u16(at + 8));
    }
    expect(tags.get(282)).toBe(144);
    expect(tags.get(283)).toBe(144);
    expect(tags.get(296)).toBe(2);
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
  await app.evaluate(({ app, BrowserWindow }) => {
    if (BrowserWindow.getAllWindows().some((w) => w.isVisible()))
      throw Error("Visible test window");
    (globalThis as any).visiblePrintWindows = 0;
    app.on("browser-window-created", (_, win) =>
      win.on("show", () => {
        (globalThis as any).visiblePrintWindows++;
      }),
    );
  });
  return app;
}
test("hidden Gate 6 print: physical size, vector text/border, source preservation, metadata and undo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-gate6-")),
    profile = join(dir, "profile"),
    input = join(dir, "geometry.svg"),
    output = join(dir, "print.pdf");
  const printFixture = svg.replace(
    'width="120" height="80"',
    'width="600" height="400"',
  );
  await writeFile(input, printFixture);
  const app = await launch(profile);
  try {
    const page = await app.firstWindow();
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
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    await expect(page.getByRole("note")).toContainText(
      "SVG geometry was rasterized",
    );
    for (const forbidden of [
      "<svg><script/></svg>",
      '<svg><image href="file:///C:/private.png"/></svg>',
      "<svg><foreignObject/></svg>",
    ]) {
      const rejected = await page.evaluate(async (artwork) => {
        try {
          await window.photo.exportPdf(artwork);
          return false;
        } catch {
          return true;
        }
      }, forbidden);
      expect(rejected).toBe(true);
    }
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    await page
      .getByRole("button", { name: "Print settings", exact: true })
      .click();
    await page.getByLabel("Print resolution", { exact: true }).fill("72");
    await page.getByLabel("Border width", { exact: true }).fill("5");
    await page
      .getByRole("button", { name: "Apply print settings", exact: true })
      .click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    await page
      .getByRole("button", { name: "Export print PDF", exact: true })
      .click();
    await expect(page.locator("footer")).toContainText(
      "Print PDF exported successfully",
      { timeout: 30000 },
    );
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = pdfjs.getDocument({
      data: new Uint8Array(await readFile(output)),
      useSystemFonts: true,
    });
    const pdf = await loading.promise;
    expect(pdf.numPages).toBe(1);
    const first = await pdf.getPage(1),
      view = first.getViewport({ scale: 1 });
    expect(view.width).toBeCloseTo(600, 0);
    expect(view.height).toBeCloseTo(400, 0);
    const text = await first.getTextContent();
    expect(
      text.items.some((item: any) => item.str?.includes("Your text")),
    ).toBe(true);
    const operators = await first.getOperatorList();
    expect(operators.fnArray).toContain(pdfjs.OPS.constructPath);
    expect(operators.fnArray).toContain(pdfjs.OPS.showText);
    const surface = (pdf.canvasFactory as any).create(600, 400);
    await first.render({
      canvas: surface.canvas,
      canvasContext: surface.context,
      viewport: view,
    }).promise;
    expect(Array.from(surface.context.getImageData(15, 15, 1, 1).data)).toEqual(
      [19, 87, 155, 255],
    );
    expect(Array.from(surface.context.getImageData(1, 1, 1, 1).data)).toEqual([
      255, 255, 255, 255,
    ]);
    (pdf.canvasFactory as any).destroy(surface);
    await loading.destroy();
    const library = new Library(join(profile, "projects")),
      id = (await library.recent())[0].id,
      result = await library.load(id);
    expect(result.document.dpi).toBe(72);
    expect(result.document.border?.width).toBe(5);
    expect(hashBytes(await readFile(input))).toBe(
      hashBytes(Buffer.from(printFixture)),
    );
    await app.evaluate(
      ({ dialog }, output) => {
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: output,
        });
      },
      join(dir, "border.png"),
    );
    await page.getByRole("button", { name: /Export PNG/ }).click();
    await expect(page.locator("footer")).toContainText(
      "PNG exported successfully",
    );
    const metadata = await sharp(join(dir, "border.png")).metadata();
    expect(metadata.density).toBe(72);
    const pixel = await sharp(join(dir, "border.png"))
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(Array.from(pixel.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    expect((await library.load(id)).document.border).toBeUndefined();
    await page.getByLabel("Print resolution", { exact: true }).fill("300");
    await page
      .getByRole("button", { name: "Apply print settings", exact: true })
      .click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    await app.evaluate(
      ({ dialog }, output) => {
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: output,
        });
      },
      join(dir, "300ppi.pdf"),
    );
    await page
      .getByRole("button", { name: "Export print PDF", exact: true })
      .click();
    await expect(page.locator("footer")).toContainText(
      "Print PDF exported successfully",
    );
    const scaled = pdfjs.getDocument({
        data: new Uint8Array(await readFile(join(dir, "300ppi.pdf"))),
      }),
      scaledDoc = await scaled.promise;
    expect(
      (await scaledDoc.getPage(1)).getViewport({ scale: 1 }).width,
    ).toBeCloseTo(144, 0);
    await scaled.destroy();
    await page.getByText("Resize to a physical size", { exact: true }).click();
    await page.getByLabel("Print width mm", { exact: true }).fill("50.8");
    await page.getByLabel("Print height mm", { exact: true }).fill("25.4");
    await page
      .getByRole("button", { name: "Resize for print", exact: true })
      .click();
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText(
      "Saved",
    );
    const resized = (await library.load(id)).document;
    expect([resized.width, resized.height, resized.dpi]).toEqual([
      600, 300, 300,
    ]);
    expect(resized.layers[1].kind).toBe("text");
    expect(
      await app.evaluate(({ BrowserWindow }) => ({
        visible: BrowserWindow.getAllWindows().some((w) => w.isVisible()),
        shown: (globalThis as any).visiblePrintWindows,
      })),
    ).toEqual({ visible: false, shown: 0 });
  } finally {
    app.process().kill();
  }
});

test("Gate 6 synthetic 24 MP worker benchmark and enforced limits", async () => {
  test.setTimeout(60000);
  const raw = Buffer.alloc(6000 * 4000 * 3);
  for (let i = 0; i < raw.length; i += 3) {
    raw[i] = (i / 3) % 251;
    raw[i + 1] = (i / 18000) % 251;
    raw[i + 2] = ((i / 3) * 13) % 251;
  }
  const fixture = await sharp(raw, {
    raw: { width: 6000, height: 4000, channels: 3 },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  const start = performance.now(),
    image = await decode(fixture),
    elapsed = performance.now() - start;
  const proxyStart = performance.now();
  const proxy = await sharp(fixture).resize(1200, 800).png().toBuffer();
  const proxyMs = Math.round(performance.now() - proxyStart);
  expect(image.width).toBe(6000);
  expect(image.height).toBe(4000);
  const huge = await sharp({
    create: { width: 6001, height: 4000, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await expect(decode(huge)).rejects.toThrow(/pixel limit/);
  console.log(
    JSON.stringify({
      gate6: "worker benchmark",
      cpu: cpus()[0].model,
      ramGiB: totalmem() / 1024 ** 3,
      importMs: Math.round(elapsed),
      inputBytes: fixture.length,
      normalizedBytes: image.bytes.length,
      proxyMs,
      proxyBytes: proxy.length,
      testProcessRssMiB: process.memoryUsage().rss / 1024 ** 2,
    }),
  );
});

test("hidden Gate 6 large-image benchmark: 24 MP full-resolution import and export", async () => {
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), "photo-large-ui-")),
    input = join(dir, "large.jpg"),
    output = join(dir, "large.png");
  const raw = Buffer.alloc(6000 * 4000 * 3);
  for (let i = 0; i < raw.length; i += 3) {
    raw[i] = (i / 3) % 251;
    raw[i + 1] = (i / 18000) % 251;
    raw[i + 2] = ((i / 3) * 13) % 251;
  }
  await sharp(raw, { raw: { width: 6000, height: 4000, channels: 3 } })
    .jpeg({ quality: 90 })
    .toFile(input);
  const app = await launch(join(dir, "profile"));
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ app }) => {
      (globalThis as any).peakWorkingSet = 0;
      (globalThis as any).memorySampler = setInterval(() => {
        const total =
          app
            .getAppMetrics()
            .reduce((sum, process) => sum + process.memory.workingSetSize, 0) /
          1024;
        (globalThis as any).peakWorkingSet = Math.max(
          (globalThis as any).peakWorkingSet,
          total,
        );
      }, 100);
    });
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
    await page.evaluate(() => {
      let last = performance.now();
      (window as any).maxGap = 0;
      (window as any).heartbeat = setInterval(() => {
        const now = performance.now();
        (window as any).maxGap = Math.max((window as any).maxGap, now - last);
        last = now;
      }, 20);
    });
    const start = performance.now();
    await page.getByRole("button", { name: "Open photo", exact: true }).click();
    await expect(page.getByRole("button", { name: /Export PNG/ })).toBeEnabled({
      timeout: 60000,
    });
    const importMs = Math.round(performance.now() - start),
      exportStart = performance.now();
    await page.getByRole("button", { name: /Export PNG/ }).click();
    await expect(page.locator("footer")).toContainText(
      "PNG exported successfully",
      { timeout: 60000 },
    );
    const exportMs = Math.round(performance.now() - exportStart);
    const meta = await sharp(output).metadata();
    expect([meta.width, meta.height]).toEqual([6000, 4000]);
    const expected = await sharp(input)
      .extract({ left: 2000, top: 1500, width: 10, height: 10 })
      .removeAlpha()
      .raw()
      .toBuffer();
    const actual = await sharp(output)
      .extract({ left: 2000, top: 1500, width: 10, height: 10 })
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(actual).toEqual(expected);
    const maxGap = await page.evaluate(() => {
      clearInterval((window as any).heartbeat);
      return (window as any).maxGap;
    });
    const memory = await app.evaluate(({ app, BrowserWindow }) => {
      if (BrowserWindow.getAllWindows().some((w) => w.isVisible()))
        throw Error("Visible benchmark window");
      return app.getAppMetrics().map((p) => ({
        type: p.type,
        workingSetMiB: p.memory.workingSetSize / 1024,
      }));
    });
    const sampledPeakWorkingSetMiB = await app.evaluate(() => {
      clearInterval((globalThis as any).memorySampler);
      return (globalThis as any).peakWorkingSet;
    });
    console.log(
      JSON.stringify({
        gate6: "hidden 24 MP",
        importMs,
        exportMs,
        maxRendererHeartbeatGapMs: Math.round(maxGap),
        memory,
        sampledPeakWorkingSetMiB,
      }),
    );
  } finally {
    app.process().kill();
  }
});

test("hidden Gate 6 native TIFF/PSD imports preserve original bytes and reject HEIC", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-compat-ui-")),
    profile = join(dir, "profile");
  const fixtures = [
    {
      name: "test.tiff",
      bytes: await sharp({
        create: { width: 32, height: 24, channels: 4, background: "#773344" },
      })
        .tiff()
        .toBuffer(),
      note: "TIFF converted",
    },
    { name: "test.psd", bytes: psd(), note: "flattened composite" },
  ];
  const app = await launch(profile);
  try {
    const page = await app.firstWindow(),
      library = new Library(join(profile, "projects"));
    for (const fixture of fixtures) {
      const input = join(dir, fixture.name);
      await writeFile(input, fixture.bytes);
      await app.evaluate(({ dialog }, input) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [input],
        });
      }, input);
      await page
        .getByRole("button", { name: "Open photo", exact: true })
        .click();
      await expect(page.getByRole("note")).toContainText(fixture.note);
      const loaded = await library.load((await library.recent())[0].id);
      expect(loaded.assets[hashBytes(fixture.bytes)]).toEqual(fixture.bytes);
    }
    expect(
      await page.evaluate(async () => {
        try {
          await window.photo.importBytes(
            new TextEncoder().encode("0000ftypheic"),
            "unsupported.heic",
          );
          return "accepted";
        } catch (e) {
          return String(e);
        }
      }),
    ).toContain("HEIC/HEIF");
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
  } finally {
    app.process().kill();
  }
});

test("hidden Gate 6 PDF: imported font stays vector; grouped effects use faithful raster fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "photo-print-font-")),
    profile = join(dir, "profile"),
    library = new Library(join(profile, "projects"));
  const font = await readFile(
      join(process.env.WINDIR ?? "C:\\Windows", "Fonts", "arial.ttf"),
    ),
    hash = hashBytes(font);
  const text = {
    kind: "text",
    id: "type",
    name: "Type",
    text: "Embedded type",
    fontFamily: "Imported Arial",
    fontAsset: hash,
    fontSize: 36,
    fill: "#24262a",
    opacity: 1,
    visible: true,
    transform: [1, 0, 0, 1, 30, 40],
  };
  const base = {
    schemaVersion: 2,
    width: 600,
    height: 400,
    dpi: 150,
    colourSpace: "srgb",
    border: { width: 6, colour: "#ff0000" },
  };
  await library.save(
    documentSchema.parse({
      ...base,
      id: randomUUID(),
      name: "Vector imported font",
      layers: [text],
    }),
    { [hash]: font },
  );
  await library.save(
    documentSchema.parse({
      ...base,
      id: randomUUID(),
      name: "Grouped fallback",
      layers: [
        {
          kind: "group",
          id: "group",
          name: "Group",
          visible: true,
          opacity: 0.7,
          transform: [1, 0, 0, 1, 0, 0],
          children: [
            {
              ...text,
              shadow: { color: "#111111", blur: 3, offsetX: 3, offsetY: 3 },
            },
          ],
        },
      ],
    }),
    { [hash]: font },
  );
  const app = await launch(profile);
  try {
    const page = await app.firstWindow(),
      pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    for (const [name, vector] of [
      ["Vector imported font", true],
      ["Grouped fallback", false],
    ] as const) {
      await page.reload();
      await page.getByRole("button", { name: new RegExp(name) }).click();
      await page
        .getByRole("button", { name: "Print settings", exact: true })
        .click();
      if (!vector)
        await expect(page.locator(".settings")).toContainText(
          "flattens the artwork",
        );
      const output = join(dir, vector ? "vector.pdf" : "raster.pdf");
      await app.evaluate(({ dialog }, output) => {
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: output,
        });
      }, output);
      await page
        .getByRole("button", { name: "Export print PDF", exact: true })
        .click();
      await expect(page.locator("footer")).toContainText(
        "Print PDF exported successfully",
        { timeout: 30000 },
      );
      const loading = pdfjs.getDocument({
          data: new Uint8Array(await readFile(output)),
        }),
        pdf = await loading.promise,
        first = await pdf.getPage(1);
      const content = await first.getTextContent(),
        operators = await first.getOperatorList();
      if (vector)
        expect(content.items.some((i: any) => i.str === "Embedded type")).toBe(
          true,
        );
      else {
        expect(content.items).toHaveLength(0);
        expect(operators.fnArray).toContain(pdfjs.OPS.paintImageXObject);
      }
      expect(operators.fnArray).toContain(pdfjs.OPS.constructPath);
      // At 150 PPI a 600px page is exactly four inches (288 points).
      expect(first.getViewport({ scale: 1 }).width).toBeCloseTo(288, 0);
      await loading.destroy();
    }
    expect(
      await app.evaluate(({ BrowserWindow }) => ({
        visible: BrowserWindow.getAllWindows().some((w) => w.isVisible()),
        shown: (globalThis as any).visiblePrintWindows,
      })),
    ).toEqual({ visible: false, shown: 0 });
  } finally {
    app.process().kill();
  }
});
