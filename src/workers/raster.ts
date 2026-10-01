import { parentPort } from "node:worker_threads";
import sharp from "sharp";
import { compatibleInput } from "./compatibility";
import { filterPixels } from "./filters";
import { MAX_PIXELS } from "../editor/model/document";
import { adjustPixels, adjustmentSchema } from "../editor/model/adjustments";
parentPort!.on(
  "message",
  async ({ id, kind, bytes, width, height, options }) => {
    try {
      const input = Buffer.from(bytes);
      if (input.length > 128 * 1024 * 1024)
        throw Error("File exceeds 128 MB limit");
      const source = sharp(await compatibleInput(input), {
        limitInputPixels: MAX_PIXELS,
        failOn: "error",
      });
      const meta = await source.metadata();
      if (
        !meta.width ||
        !meta.height ||
        meta.width > 12000 ||
        meta.height > 12000
      )
        throw Error("Images must be at most 12,000 pixels on either side");
      if (!["png", "jpeg", "webp", "tiff", "svg"].includes(meta.format ?? ""))
        throw Error(
          "Choose PNG, JPEG, WebP, static TIFF, geometry SVG or flattened RGB PSD",
        );
      if ((meta.pages ?? 1) !== 1)
        throw Error("Animated or multipage images are not supported");
      let pipeline = source.rotate().toColourspace("srgb");
      if (kind === "filter") {
        const { data, info } = await pipeline
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const pixels = await filterPixels(
          data,
          info.width,
          info.height,
          options,
        );
        pipeline = sharp(pixels, {
          raw: { width: info.width, height: info.height, channels: 4 },
        });
      }
      if (kind === "adjust") {
        const settings = adjustmentSchema.parse(options);
        const { data: raw, info } = await pipeline
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const pixels = adjustPixels(raw, settings);
        if (settings.sharpen > 0) {
          const rgb = await sharp(pixels, {
            raw: { width: info.width, height: info.height, channels: 4 },
          })
            .removeAlpha()
            .sharpen({ sigma: settings.sharpen })
            .raw()
            .toBuffer();
          for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
            pixels[i] = rgb[j];
            pixels[i + 1] = rgb[j + 1];
            pixels[i + 2] = rgb[j + 2];
          }
        }
        pipeline = sharp(pixels, {
          raw: { width: info.width, height: info.height, channels: 4 },
        });
      }
      if (kind === "export" && options?.format === "jpeg")
        pipeline = pipeline
          .flatten({ background: options.matte })
          .jpeg({ quality: options.quality });
      else if (kind === "export" && options?.format === "webp")
        pipeline = pipeline.webp({ quality: options.quality });
      else pipeline = pipeline.png();
      if (kind === "export" && options?.dpi)
        pipeline = pipeline.withMetadata({ density: options.dpi });
      const { data, info } = await pipeline.toBuffer({
        resolveWithObject: true,
      });
      if (kind === "export" && (info.width !== width || info.height !== height))
        throw Error("Export dimensions do not match");
      parentPort!.postMessage({
        id,
        result: {
          bytes: data,
          width: info.width,
          height: info.height,
          warning:
            input.subarray(0, 4).toString() === "8BPS"
              ? "PSD opened as its saved flattened composite. Photoshop layers, text, masks and effects are not editable here; the original PSD is preserved."
              : meta.format === "svg"
                ? "SVG geometry was rasterized at its intrinsic size. It is an image layer here; the original SVG is preserved."
                : meta.format === "tiff"
                  ? "Single-page TIFF converted to 8-bit sRGB for editing. Original TIFF bytes are preserved; extra channels and print profiles are not editable."
                  : undefined,
        },
      });
    } catch (e) {
      parentPort!.postMessage({ id, error: (e as Error).message });
    }
  },
);
