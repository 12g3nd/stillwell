import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: [
    "src/main/main.ts",
    "src/workers/raster.ts",
    "src/workers/mask.ts",
    "src/workers/strokes.ts",
    "src/preload/preload.ts",
  ],
  outdir: "dist",
  entryNames: "[name]",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  external: ["electron", "sharp"],
});
await build({
  entryPoints: ["src/renderer/app.tsx"],
  outfile: "dist/app.js",
  bundle: true,
  platform: "browser",
  target: "chrome140",
  loader: { ".css": "css" },
});
await copyFile("src/renderer/index.html", "dist/index.html");
await copyFile("src/renderer/print.html", "dist/print.html");
await build({
  entryPoints: ["src/workers/text-shape.ts"],
  outfile: "dist/text-shape.js",
  bundle: true,
  platform: "browser",
  target: "chrome140",
});
await build({
  entryPoints: ["tests/proof.ts"],
  outfile: "dist/proof.js",
  bundle: true,
  platform: "browser",
  target: "chrome140",
});
const { writeFile } = await import("node:fs/promises");
await writeFile(
  "dist/proof.html",
  '<!doctype html><html><body><script src="proof.js"></script></body></html>',
);
