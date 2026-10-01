import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { hashBytes } from "../src/main/project";
import type { PhotoDocument, TextLayer } from "../src/editor/model/document";
test("typography renderer: effects, wrapping, spacing, group clipping and missing fonts", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.PHOTO_EDITOR_HIDDEN = "1";
  env.PHOTO_EDITOR_DATA = await mkdtemp(join(tmpdir(), "photo-type-pixels-"));
  const app = await electron.launch({ args: ["."], env });
  try {
    await app.firstWindow();
    const pending = app.waitForEvent("window");
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
    const page = await pending;
    await page.waitForFunction(() => !!window.proof);
    const font = await readFile(
        join(process.env.WINDIR ?? "C:\\Windows", "Fonts", "arial.ttf"),
      ),
      hash = hashBytes(font);
    await page.evaluate(
      (p) => {
        (window as any).__fontFixture = { [p.hash]: new Uint8Array(p.bytes) };
      },
      { hash, bytes: Array.from(font) },
    );
    const text: TextLayer = {
      kind: "text",
      id: "title",
      name: "Title",
      text: "MMMM MMMM MMMM",
      fontFamily: "Fixture face",
      fontAsset: hash,
      fontSize: 28,
      fill: "#24262a",
      visible: true,
      opacity: 1,
      transform: [1, 0, 0, 1, 30, 30],
    };
    async function render(patch: Partial<TextLayer> = {}, grouped = false) {
      const layer = { ...text, ...patch } as TextLayer;
      const document: PhotoDocument = {
        schemaVersion: 2,
        id: "fixture",
        name: "Typography",
        width: 500,
        height: 300,
        colourSpace: "srgb",
        layers: grouped
          ? [
              {
                kind: "group",
                id: "group",
                name: "Group",
                visible: true,
                opacity: 1,
                transform: [1, 0, 0, 1, 0, 0],
                children: [layer],
              },
            ]
          : [layer],
      };
      const output = await page.evaluate(
        async (document) =>
          window.proof.render({
            document,
            assets: (window as any).__fontFixture,
          }),
        document,
      );
      const bytes = Buffer.from(output),
        raw = await sharp(bytes).ensureAlpha().raw().toBuffer();
      let left = 500,
        top = 300,
        right = -1,
        bottom = -1,
        count = 0;
      for (let y = 0; y < 300; y++)
        for (let x = 0; x < 500; x++)
          if (raw[(y * 500 + x) * 4 + 3]) {
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
            count++;
          }
      return { bytes, raw, left, top, right, bottom, count };
    }
    const plain = await render();
    expect(plain.count).toBeGreaterThan(100);
    const wrap = await render({ wrapWidth: 140 });
    expect(wrap.bottom).toBeGreaterThan(plain.bottom + 40);
    expect(wrap.right).toBeLessThan(180);
    expect(
      (await render({ wrapWidth: 140, lineHeight: 1.8 })).bottom,
    ).toBeGreaterThan(wrap.bottom);
    expect((await render({ letterSpacing: 2 })).right).toBeGreaterThan(
      plain.right,
    );
    expect((await render({ fontWeight: 700 })).bytes).not.toEqual(plain.bytes);
    expect((await render({ fontStyle: "italic" })).bytes).not.toEqual(
      plain.bytes,
    );
    expect((await render({ underline: true })).count).toBeGreaterThan(
      plain.count,
    );
    expect(
      (await render({ backgroundColor: "#d8eee7" })).count,
    ).toBeGreaterThan(plain.count * 2);
    expect(
      (await render({ stroke: "#ff0000", strokeWidth: 3 })).count,
    ).toBeGreaterThan(plain.count);
    const shadow = await render({
      shadow: { color: "#000000", blur: 6, offsetX: 10, offsetY: 10 },
    });
    expect(shadow.right).toBeGreaterThan(plain.right);
    expect(shadow.bottom).toBeGreaterThan(plain.bottom);
    const effects = {
      stroke: "#ff0000",
      strokeWidth: 3,
      shadow: { color: "#000000", blur: 6, offsetX: 10, offsetY: 10 },
    };
    const alone = await render(effects),
      grouped = await render(effects, true);
    expect(hashBytes(grouped.raw)).toEqual(hashBytes(alone.raw));
    const left = await render({ text: "Hi", wrapWidth: 240 }),
      right = await render({ text: "Hi", wrapWidth: 240, textAlign: "right" });
    expect(right.left).toBeGreaterThan(left.left + 150);
    const shaped = {
      ...effects,
      text: "Curved\nposter",
      transform: [1, 0, 0, 1, 150, 120] as [
        number,
        number,
        number,
        number,
        number,
        number,
      ],
      curve: 55,
    };
    const straight = await render({ ...shaped, curve: 0 });
    const curved = await render(shaped);
    expect(hashBytes(curved.raw)).not.toEqual(hashBytes(straight.raw));
    expect(curved.top).toBeLessThan(straight.top);
    expect(curved.left).toBeGreaterThan(0);
    expect(curved.right).toBeLessThan(499);
    expect(curved.bottom).toBeLessThan(299);
    expect(hashBytes((await render(shaped, true)).raw)).toEqual(
      hashBytes(curved.raw),
    );
    expect(
      hashBytes((await render({ ...shaped, curve: -55 })).raw),
    ).not.toEqual(hashBytes(curved.raw));
    for (const kind of ["wave", "bulge"] as const) {
      const patch = { ...shaped, warp: { kind, amount: 60 } };
      const warped = await render(patch);
      expect(hashBytes(warped.raw)).not.toEqual(hashBytes(curved.raw));
      expect(warped.count).toBeGreaterThan(100);
      expect(hashBytes((await render(patch, true)).raw)).toEqual(
        hashBytes(warped.raw),
      );
      expect(warped.top).toBeGreaterThan(0);
      expect(warped.bottom).toBeLessThan(299);
    }
    expect(
      hashBytes(
        (await render({ curve: 0, warp: { kind: "wave", amount: 0 } })).raw,
      ),
    ).toEqual(hashBytes(plain.raw));
    await expect(
      render({
        fontAsset: undefined,
        fontFamily: "DefinitelyMissingPhotoEditorFixtureFont",
      }),
    ).rejects.toThrow("Font unavailable");
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
