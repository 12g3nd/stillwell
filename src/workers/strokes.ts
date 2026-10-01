import { parentPort } from "node:worker_threads";
import sharp from "sharp";
import { MAX_PIXELS } from "../editor/model/document";
import { strokeSchema, type Stroke } from "../editor/model/strokes";
import type { PixelPoint } from "../editor/model/mask";

const clamp = (n: number, low: number, high: number) =>
  Math.max(low, Math.min(high, n));
function sample(src: Uint8Array, w: number, h: number, x: number, y: number) {
  x = clamp(x, 0, w - 1);
  y = clamp(y, 0, h - 1);
  const xx = Math.floor(x),
    yy = Math.floor(y),
    fx = x - xx,
    fy = y - yy;
  const rgb = [0, 0, 0];
  let alpha = 0;
  for (let dy = 0; dy < 2; dy++)
    for (let dx = 0; dx < 2; dx++) {
      const at = (Math.min(h - 1, yy + dy) * w + Math.min(w - 1, xx + dx)) * 4;
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy),
        a = src[at + 3] * weight;
      alpha += a;
      for (let c = 0; c < 3; c++) rgb[c] += src[at + c] * a;
    }
  return [...rgb.map((n) => (alpha ? n / alpha : 0)), alpha];
}
function dabs(points: PixelPoint[], radius: number) {
  const result = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      length = Math.hypot(b.x - a.x, b.y - a.y),
      steps = Math.ceil(length / Math.max(1, radius / 3));
    if (result.length + steps > 8192)
      throw Error("Stroke is too long. Use shorter strokes.");
    for (let j = 1; j <= steps; j++)
      result.push({
        x: a.x + ((b.x - a.x) * j) / steps,
        y: a.y + ((b.y - a.y) * j) / steps,
      });
  }
  if (result.length * (radius * 2 + 2) ** 2 > 30_000_000)
    throw Error(
      "Stroke covers too much work at once. Use shorter strokes or a smaller brush.",
    );
  return result;
}
function ring(
  src: Uint8Array,
  w: number,
  h: number,
  point: PixelPoint,
  radius: number,
) {
  const sum = [0, 0, 0];
  let weight = 0;
  for (let i = 0; i < 32; i++) {
    const angle = (i * Math.PI) / 16,
      x = point.x + Math.cos(angle) * radius,
      y = point.y + Math.sin(angle) * radius;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const p = sample(src, w, h, x, y);
    weight += p[3];
    for (let c = 0; c < 3; c++) sum[c] += p[c] * p[3];
  }
  return weight ? sum.map((c) => c / weight) : undefined;
}
export function strokePixels(
  src: Uint8Array,
  w: number,
  h: number,
  input: Stroke,
  mask?: Uint8Array,
) {
  const s = strokeSchema.parse(input),
    radius = s.diameter / 2,
    first = s.points[0];
  if (src.length !== w * h * 4 || (mask && mask.length !== src.length))
    throw Error("Pixel dimensions do not match");
  const output = new Uint8Array(src),
    outMask = mask ? new Uint8Array(mask) : undefined;
  const inside = (p: PixelPoint) => p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
  if (!inside(first)) throw Error("Start inside the selected image");
  let origin = s.source,
    colourOffset = [0, 0, 0];
  if (s.kind === "clone" && (!origin || !inside(origin)))
    throw Error("Pick a source inside the selected image");
  if (s.kind === "heal") {
    const target = ring(src, w, h, first, radius + 2);
    if (!target) throw Error("Not enough surrounding image to heal this spot");
    let best = Infinity;
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4,
        point = {
          x: first.x + Math.cos(angle) * (radius * 2 + 3),
          y: first.y + Math.sin(angle) * (radius * 2 + 3),
        };
      if (
        point.x < radius ||
        point.y < radius ||
        point.x >= w - radius ||
        point.y >= h - radius
      )
        continue;
      const candidate = ring(src, w, h, point, radius + 2);
      if (!candidate) continue;
      const centre = sample(src, w, h, point.x, point.y);
      if (centre[3] < 250) continue;
      const score = candidate.reduce(
        (sum, c, j) => sum + (c - target[j]) ** 2,
        0,
      );
      if (score < best) {
        best = score;
        origin = point;
        colourOffset = target.map((c, j) => c - candidate[j]);
      }
    }
    if (!origin)
      throw Error(
        "No nearby source fits this brush. Reduce its size or use Clone.",
      );
  }
  const coverage = new Float32Array(w * h),
    path = dabs(s.points, radius);
  const deform = ["push", "pinch", "expand"].includes(s.kind);
  const dx = deform ? new Float32Array(w * h) : undefined,
    dy = deform ? new Float32Array(w * h) : undefined;
  let previous = path[0];
  for (const p of path) {
    const left = Math.max(0, Math.floor(p.x - radius)),
      right = Math.min(w - 1, Math.ceil(p.x + radius));
    const top = Math.max(0, Math.floor(p.y - radius)),
      bottom = Math.min(h - 1, Math.ceil(p.y + radius));
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= right; x++) {
        // A sub-two-pixel brush must hit the pixel under the pointer even when the
        // pointer lies on integer grid intersections between pixel centres.
        const centreX = s.diameter < 2 ? Math.floor(p.x) + 0.5 : p.x;
        const centreY = s.diameter < 2 ? Math.floor(p.y) + 0.5 : p.y;
        const d = Math.hypot(x + 0.5 - centreX, y + 0.5 - centreY) / radius;
        const a =
          d >= 1
            ? 0
            : d <= s.hardness
              ? 1
              : (1 - d) / Math.max(0.0001, 1 - s.hardness);
        const index = y * w + x,
          strength = a * s.opacity;
        if (deform) {
          if (s.kind === "push") {
            dx![index] -= (p.x - previous.x) * strength;
            dy![index] -= (p.y - previous.y) * strength;
          } else if (strength > coverage[index]) {
            const sign = s.kind === "pinch" ? 1 : -1;
            dx![index] = (x + 0.5 - p.x) * strength * 0.6 * sign;
            dy![index] = (y + 0.5 - p.y) * strength * 0.6 * sign;
          }
        }
        coverage[index] = Math.max(coverage[index], strength);
      }
    previous = p;
  }
  const paint = [1, 3, 5].map((i) => parseInt(s.colour.slice(i, i + 2), 16));
  for (let i = 0; i < coverage.length; i++) {
    const mix = coverage[i];
    if (!mix) continue;
    const at = i * 4,
      x = i % w,
      y = Math.floor(i / w);
    if (deform) {
      const length = Math.hypot(dx![i], dy![i]),
        scale = length > radius ? radius / length : 1;
      const sx = x + dx![i] * scale,
        sy = y + dy![i] * scale;
      output.set(sample(src, w, h, sx, sy).map(Math.round), at);
      if (mask && outMask)
        outMask.set(sample(mask, w, h, sx, sy).map(Math.round), at);
    } else if (s.kind === "paint") {
      const alpha = mix + (src[at + 3] / 255) * (1 - mix);
      for (let c = 0; c < 3; c++)
        output[at + c] = Math.round(
          (paint[c] * mix + ((src[at + c] * src[at + 3]) / 255) * (1 - mix)) /
            alpha,
        );
      output[at + 3] = Math.round(alpha * 255);
    } else if (s.kind === "clone" || s.kind === "heal") {
      const sx = x + origin!.x - first.x,
        sy = y + origin!.y - first.y;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const colour = sample(src, w, h, sx, sy),
        strength = (mix * colour[3]) / 255;
      // Retouch preserves source alpha exactly; cutouts remain independent masks.
      for (let c = 0; c < 3; c++)
        output[at + c] = Math.round(
          src[at + c] * (1 - strength) +
            clamp(colour[c] + colourOffset[c], 0, 255) * strength,
        );
    }
  }
  return { pixels: output, mask: outMask };
}

async function decode(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 128 * 1024 * 1024)
    throw Error("Invalid image data");
  const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" });
  const meta = await image.metadata();
  if (
    meta.format !== "png" ||
    !meta.width ||
    !meta.height ||
    meta.width > 12000 ||
    meta.height > 12000 ||
    (meta.pages ?? 1) !== 1
  )
    throw Error("Expected a bounded PNG");
  return image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
parentPort?.on("message", async ({ id, bytes, input, mask, width, height }) => {
  try {
    if (input === "blank") {
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 12000 ||
        height > 12000 ||
        width * height > MAX_PIXELS
      )
        throw Error("Invalid drawing dimensions");
      const bytes = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer();
      parentPort!.postMessage({ id, result: { bytes, width, height } });
      return;
    }
    const { data, info } = await decode(bytes),
      maskData = mask ? await decode(mask) : undefined;
    if (
      maskData &&
      (maskData.info.width !== info.width ||
        maskData.info.height !== info.height)
    )
      throw Error("Mask dimensions do not match");
    const result = strokePixels(
      data,
      info.width,
      info.height,
      input,
      maskData?.data,
    );
    const raw = {
      width: info.width,
      height: info.height,
      channels: 4 as const,
    };
    parentPort!.postMessage({
      id,
      result: {
        bytes: await sharp(result.pixels, { raw }).png().toBuffer(),
        mask: result.mask
          ? await sharp(result.mask, { raw }).png().toBuffer()
          : undefined,
        width: info.width,
        height: info.height,
      },
    });
  } catch (e) {
    parentPort!.postMessage({ id, error: (e as Error).message });
  }
});
