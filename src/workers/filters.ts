import sharp from "sharp";
import { filterSchema, type PhotoFilter } from "../editor/model/filters";

export async function filterPixels(
  source: Uint8Array,
  width: number,
  height: number,
  input: PhotoFilter,
) {
  const f = filterSchema.parse(input),
    output = new Uint8Array(source),
    amount = f.amount / 100;
  if (!amount) return output;
  let blurred: Buffer | undefined;
  if (f.kind === "blur")
    blurred = await sharp(source, { raw: { width, height, channels: 4 } })
      .blur(Math.max(0.3, f.radius / 2))
      .raw()
      .toBuffer();
  if (f.kind === "pixelate") {
    for (let y = 0; y < height; y += f.radius)
      for (let x = 0; x < width; x += f.radius) {
        const sums = [0, 0, 0];
        let alpha = 0;
        const right = Math.min(width, x + f.radius),
          bottom = Math.min(height, y + f.radius);
        for (let yy = y; yy < bottom; yy++)
          for (let xx = x; xx < right; xx++) {
            const at = (yy * width + xx) * 4,
              a = source[at + 3];
            alpha += a;
            for (let c = 0; c < 3; c++) sums[c] += source[at + c] * a;
          }
        for (let yy = y; yy < bottom; yy++)
          for (let xx = x; xx < right; xx++) {
            const at = (yy * width + xx) * 4;
            for (let c = 0; c < 3; c++)
              output[at + c] = Math.round(
                source[at + c] * (1 - amount) +
                  (alpha ? sums[c] / alpha : source[at + c]) * amount,
              );
          }
      }
    return output;
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4,
        r = source[at],
        g = source[at + 1],
        b = source[at + 2];
      const gray = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const distance =
        f.kind === "vignette"
          ? Math.hypot(
              (x + 0.5 - width / 2) / (width / 2),
              (y + 0.5 - height / 2) / (height / 2),
            )
          : 0;
      const shade = 1 - Math.min(1, Math.max(0, distance - 0.25) / 0.9) ** 2;
      const rgb =
        f.kind === "mono"
          ? [gray, gray, gray]
          : f.kind === "sepia"
            ? [
                r * 0.393 + g * 0.769 + b * 0.189,
                r * 0.349 + g * 0.686 + b * 0.168,
                r * 0.272 + g * 0.534 + b * 0.131,
              ]
            : f.kind === "blur"
              ? [blurred![at], blurred![at + 1], blurred![at + 2]]
              : [r * shade, g * shade, b * shade];
      for (let c = 0; c < 3; c++)
        output[at + c] = Math.round(
          source[at + c] * (1 - amount) + Math.min(255, rgb[c]) * amount,
        );
    }
  return output;
}
