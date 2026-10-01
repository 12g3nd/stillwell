import { z } from "zod";
const percent = z.number().min(-100).max(100);
export const adjustmentSchema = z
  .object({
    exposure: z.number().min(-4).max(4),
    brightness: percent,
    contrast: percent,
    saturation: percent,
    temperature: percent,
    tint: percent,
    sharpen: z.number().min(0).max(3),
    black: z.number().min(0).max(254),
    white: z.number().min(1).max(255),
    gamma: z.number().min(0.2).max(5),
    shadows: z.number().min(0).max(255),
    midtones: z.number().min(0).max(255),
    highlights: z.number().min(0).max(255),
  })
  .refine((v) => v.black < v.white, "Black point must be below white point.");
export type Adjustments = z.infer<typeof adjustmentSchema>;
export const neutralAdjustments: Adjustments = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  sharpen: 0,
  black: 0,
  white: 255,
  gamma: 1,
  shadows: 63.75,
  midtones: 127.5,
  highlights: 191.25,
};
export function adjustPixels(input: Uint8Array, settings: Adjustments) {
  const p = adjustmentSchema.parse(settings),
    output = new Uint8Array(input.length);
  const stops = [0, p.shadows, p.midtones, p.highlights, 255];
  const clamp = (x: number) => Math.max(0, Math.min(255, x));
  const tone = (v: number) => {
    const t =
      Math.pow(
        clamp(((v - p.black) / (p.white - p.black)) * 255) / 255,
        1 / p.gamma,
      ) * 4;
    const i = Math.min(3, Math.floor(t));
    return stops[i] + (stops[i + 1] - stops[i]) * (t - i);
  };
  // Exposure scales linear light, using a small sRGB lookup table per job.
  const exposure = Float64Array.from({ length: 256 }, (_, value) => {
    if (p.exposure === 0) return value;
    const srgb = value / 255;
    const linear =
      (srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4) *
      2 ** p.exposure;
    return (
      255 *
      (linear <= 0.0031308
        ? linear * 12.92
        : 1.055 * linear ** (1 / 2.4) - 0.055)
    );
  });
  for (let i = 0; i < input.length; i += 4) {
    let r = exposure[input[i]] + p.brightness * 2.55 + p.temperature * 0.4;
    let g = exposure[input[i + 1]] + p.brightness * 2.55 + p.tint * 0.4;
    let b = exposure[input[i + 2]] + p.brightness * 2.55 - p.temperature * 0.4;
    r = (r - 127.5) * (1 + p.contrast / 100) + 127.5;
    g = (g - 127.5) * (1 + p.contrast / 100) + 127.5;
    b = (b - 127.5) * (1 + p.contrast / 100) + 127.5;
    const light = r * 0.2126 + g * 0.7152 + b * 0.0722,
      saturation = 1 + p.saturation / 100;
    output[i] = Math.round(clamp(tone(light + (r - light) * saturation)));
    output[i + 1] = Math.round(clamp(tone(light + (g - light) * saturation)));
    output[i + 2] = Math.round(clamp(tone(light + (b - light) * saturation)));
    output[i + 3] = input[i + 3];
  }
  return output;
}
