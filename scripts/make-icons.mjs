// Renders the Stillwell mark (build/icon.svg) into the PNG and ICO files used by the
// window, the packaged executable and the installer. Run with `npm run icons`.
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";

const svg = await readFile("build/icon.svg");
const render = (size) =>
  sharp(svg, { density: Math.max(72, (288 * size) / 1024) })
    .resize(size, size)
    .png()
    .toBuffer();

await writeFile("build/icon.png", await render(1024));
for (const size of [256, 64])
  await writeFile(`build/icon-${size}.png`, await render(size));

// ICO with PNG-compressed entries (supported since Windows Vista).
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(render));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const entry = 6 + 16 * i;
  header.writeUInt8(size === 256 ? 0 : size, entry);
  header.writeUInt8(size === 256 ? 0 : size, entry + 1);
  header.writeUInt8(0, entry + 2);
  header.writeUInt8(0, entry + 3);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
});
await writeFile("build/icon.ico", Buffer.concat([header, ...images]));
console.log("icons written to build/");
