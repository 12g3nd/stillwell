// Document-pixel deformation, independent of viewport/device scale. The worker
// inverse-maps each output pixel, so enlargement cannot leave forward-map holes.
export type Deformation = {
  width: number;
  height: number;
  padding: number;
  contentWidth: number;
  curve: number;
  warp?: { kind: "wave" | "bulge"; amount: number };
};
export function column(p: Deformation, x: number) {
  const u = Math.max(0, Math.min(1, (x - p.padding) / p.contentWidth));
  const offset =
    (-p.curve / 100) * p.contentWidth * 0.5 * 4 * u * (1 - u) +
    (p.warp?.kind === "wave"
      ? (p.warp.amount / 100) *
        p.contentWidth *
        0.25 *
        Math.sin(u * Math.PI * 2)
      : 0);
  const scale =
    1 +
    (p.warp?.kind === "bulge"
      ? (p.warp.amount / 100) * 0.75 * Math.sin(u * Math.PI)
      : 0);
  return { offset, scale };
}
export function dimensions(p: Deformation) {
  let min = 0,
    max = p.height;
  for (let x = 0; x < p.width; x++) {
    const { offset, scale } = column(p, x);
    min = Math.min(min, (p.height / 2) * (1 - scale) + offset);
    max = Math.max(max, (p.height / 2) * (1 + scale) + offset);
  }
  const top = Math.floor(min) - 2;
  return { width: p.width, height: Math.ceil(max) - top + 2, top };
}
export function deform(p: Deformation, source: Uint8ClampedArray) {
  const size = dimensions(p);
  if (
    p.width > 12000 ||
    size.height > 12000 ||
    p.width * size.height > 24_000_000
  )
    throw Error(
      "Shaped text exceeds the supported layer dimensions. Reduce its size or deformation.",
    );
  const output = new Uint8ClampedArray(size.width * size.height * 4);
  let left = size.width,
    top = size.height,
    right = -1,
    bottom = -1;
  for (let x = 0; x < size.width; x++) {
    const { offset, scale } = column(p, x);
    for (let y = 0; y < size.height; y++) {
      const sy = (y + size.top - p.height / 2 - offset) / scale + p.height / 2;
      const low = Math.floor(sy),
        fraction = sy - low;
      const dest = (y * size.width + x) * 4;
      // Premultiplied interpolation avoids dark fringes on translucent edges.
      let alpha = 0;
      for (let k = 0; k < 2; k++) {
        const row = low + k;
        if (row < 0 || row >= p.height) continue;
        const src = (row * p.width + x) * 4;
        alpha += source[src + 3] * (k ? fraction : 1 - fraction);
      }
      output[dest + 3] = alpha;
      if (output[dest + 3]) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
      if (!alpha) continue;
      for (let c = 0; c < 3; c++) {
        let value = 0;
        for (let k = 0; k < 2; k++) {
          const row = low + k;
          if (row < 0 || row >= p.height) continue;
          const src = (row * p.width + x) * 4;
          value +=
            source[src + c] * source[src + 3] * (k ? fraction : 1 - fraction);
        }
        output[dest + c] = value / alpha;
      }
    }
  }
  // Remove the generous render padding from selection/hit bounds, retaining a
  // two-pixel transparent guard. Keep the offset so no document pixels move.
  if (right < 0)
    return {
      width: 1,
      height: 1,
      left: p.padding,
      top: p.padding,
      pixels: new Uint8ClampedArray(4),
    };
  left = Math.max(0, left - 2);
  top = Math.max(0, top - 2);
  right = Math.min(size.width - 1, right + 2);
  bottom = Math.min(size.height - 1, bottom + 2);
  const width = right - left + 1,
    height = bottom - top + 1;
  const cropped = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((y + top) * size.width + left) * 4;
    cropped.set(output.subarray(start, start + width * 4), y * width * 4);
  }
  return { width, height, left, top: size.top + top, pixels: cropped };
}
