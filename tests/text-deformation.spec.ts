import { test, expect } from "@playwright/test";
import { deform } from "../src/editor/render/deformation";
import { textStyleSchema } from "../src/editor/model/text";

test("text deformation preserves alpha and edge colours without clipping at signed extremes", () => {
  const width = 64,
    height = 48,
    pixels = new Uint8ClampedArray(width * height * 4);
  let sourceAlpha = 0;
  for (let y = 5; y < height - 5; y++)
    for (let x = 4; x < width - 4; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = 240;
      pixels[i + 1] = 110;
      pixels[i + 2] = 40;
      pixels[i + 3] = 180;
      sourceAlpha += 180;
    }
  for (const curve of [-100, 0, 100])
    for (const kind of ["wave", "bulge"] as const)
      for (const amount of [-100, 0, 100]) {
        const result = deform(
          {
            width,
            height,
            padding: 4,
            contentWidth: 56,
            curve,
            warp: { kind, amount },
          },
          pixels,
        );
        let alpha = 0,
          boundaryPixels = 0,
          incorrectColours = 0;
        for (let y = 0; y < result.height; y++)
          for (let x = 0; x < result.width; x++) {
            const i = (y * result.width + x) * 4,
              a = result.pixels[i + 3];
            alpha += a;
            if (a) {
              if (
                y === 0 ||
                y === result.height - 1 ||
                x === 0 ||
                x === result.width - 1
              )
                boundaryPixels++;
              if (
                result.pixels[i] !== 240 ||
                result.pixels[i + 1] !== 110 ||
                result.pixels[i + 2] !== 40
              )
                incorrectColours++;
            }
          }
        expect(boundaryPixels).toBe(0);
        expect(incorrectColours).toBe(0);
        if (kind === "wave")
          expect(Math.abs(alpha - sourceAlpha)).toBeLessThan(
            sourceAlpha * 0.002,
          );
        else expect(alpha).toBeGreaterThan(sourceAlpha * 0.25);
      }
  expect(() =>
    deform(
      {
        width: 12000,
        height: 4000,
        padding: 4,
        contentWidth: 11992,
        curve: 100,
      },
      new Uint8ClampedArray(),
    ),
  ).toThrow("supported layer dimensions");
});

test("text deformation schema rejects unsafe and unknown parameters", () => {
  const base = { fontFamily: "Arial", fontSize: 24, fill: "#000000" };
  for (const patch of [
    { curve: 101 },
    { curve: -101 },
    { curve: NaN },
    { warp: { kind: "wave", amount: Infinity } },
    { warp: { kind: "bulge", amount: -101 } },
    { warp: { kind: "unknown", amount: 5 } },
  ]) {
    expect(textStyleSchema.safeParse({ ...base, ...patch }).success).toBe(
      false,
    );
  }
});
