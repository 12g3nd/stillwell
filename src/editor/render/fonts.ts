import type { FontChoice } from "../model/text";
const loaded = new Map<string, Promise<string>>();
const fontKey = (font: FontChoice) =>
  font.fontAsset
    ? `asset:${font.fontAsset}`
    : `local:${font.fontPostscript ?? font.fontFamily}`;
export function fontAlias(font: FontChoice) {
  return (
    "PhotoFont_" +
    Array.from(fontKey(font))
      .map((c) => c.codePointAt(0)!.toString(16))
      .join("_")
  );
}
export async function fontFamily(
  font: FontChoice,
  assets: Record<string, Uint8Array>,
): Promise<string> {
  const key = fontKey(font);
  if (font.fontAsset && !assets[font.fontAsset])
    throw Error(`Missing imported font: ${font.fontFamily}`);
  let pending = loaded.get(key);
  if (!pending) {
    pending = (async () => {
      const alias = fontAlias(font);
      const bytes = font.fontAsset ? assets[font.fontAsset] : undefined;
      if (font.fontAsset && !bytes)
        throw Error(`Missing imported font: ${font.fontFamily}`);
      const face = new FontFace(
        alias,
        bytes
          ? new Uint8Array(bytes).buffer
          : `local(${JSON.stringify(font.fontPostscript ?? font.fontFamily)})`,
      );
      try {
        await face.load();
      } catch {
        throw Error(
          `Font unavailable or invalid: ${font.fontFamily}. Choose another installed font or import its file.`,
        );
      }
      document.fonts.add(face);
      return alias;
    })();
    loaded.set(key, pending);
    pending.catch(() => loaded.delete(key));
  }
  return pending;
}
export type InstalledFont = {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
};
export async function installedFonts(): Promise<InstalledFont[]> {
  const query = (
    window as unknown as { queryLocalFonts?: () => Promise<InstalledFont[]> }
  ).queryLocalFonts;
  if (!query)
    throw Error(
      "Installed font listing is unavailable. Import a local font file instead.",
    );
  return (await query.call(window)).sort((a, b) =>
    a.fullName.localeCompare(b.fullName),
  );
}
