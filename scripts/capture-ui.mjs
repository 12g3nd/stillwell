// Hidden UI capture for design review. Windows stay hidden (PHOTO_EDITOR_HIDDEN=1);
// screenshots come from offscreen rendering. Usage: node scripts/capture-ui.mjs <outDir> [width height]
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";

const out = resolve(process.argv[2] ?? ".impeccable/review");
const width = Number(process.argv[3] ?? 1440);
const height = Number(process.argv[4] ?? 900);
await mkdir(out, { recursive: true });
const dir = await mkdtemp(join(tmpdir(), "stillwell-capture-"));
const profile = join(dir, "profile");
await mkdir(profile);

// Synthetic landscape fixture: sky gradient, sun, layered hills.
const W = 1920,
  H = 1200;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fc3e0"/><stop offset="0.7" stop-color="#f3d2b5"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#s)"/><circle cx="1350" cy="380" r="150" fill="#ec8a55"/>
<path d="M0 760 C 400 520 700 560 1000 800 S 1700 700 1920 560 V1200 H0Z" fill="#6d9e8f"/>
<path d="M0 900 C 500 700 900 760 1300 900 S 1800 860 1920 780 V1200 H0Z" fill="#3c6b66"/>
<path d="M0 1050 C 600 920 1200 980 1920 1000 V1200 H0Z" fill="#23474a"/></svg>`;
const input = join(dir, "Harbour hills.png");
await writeFile(input, await sharp(Buffer.from(svg)).png().toBuffer());

const env = Object.fromEntries(
  Object.entries(process.env).filter((e) => e[1] !== undefined),
);
delete env.ELECTRON_RUN_AS_NODE;
env.PHOTO_EDITOR_DATA = profile;
env.PHOTO_EDITOR_HIDDEN = "1";
const app = await electron.launch({ args: ["."], env });
try {
  const page = await app.firstWindow();
  await app.evaluate(
    ({ BrowserWindow }, s) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isVisible()) throw new Error("window became visible");
        w.setIgnoreMouseEvents(true);
        w.setContentSize(s.width, s.height);
        w.webContents.setBackgroundThrottling(false);
      }
    },
    { width, height },
  );
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(500);
  if (process.env.CAPTURE_THEME === "light")
    await page.getByRole("button", { name: "Switch to light theme" }).click();
  await page.screenshot({ path: join(out, `home-${width}.png`) });
  await app.evaluate(({ dialog }, v) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [v] });
  }, input);
  await page.getByRole("button", { name: "Open photo", exact: true }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, `arrange-${width}.png`) });
  const tools = (
    process.env.CAPTURE_TOOLS ??
    "Crop and size,Cutout,Text tool,Adjustments,Filters"
  ).split(",");
  for (const name of tools) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(700);
    await page.screenshot({
      path: join(
        out,
        `${name.toLowerCase().replace(/\W+/g, "-")}-${width}.png`,
      ),
    });
  }
  const visible = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => w.isVisible()),
  );
  if (visible) throw new Error("window became visible");
  console.log("captured to", out);
} finally {
  await app.close();
}
