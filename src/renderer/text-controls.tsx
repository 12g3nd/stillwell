import React, { useEffect, useState } from "react";
import { Icon } from "./icons";
import type { PhotoDocument, TextLayer } from "../editor/model/document";
import {
  textStyleSchema,
  type FontChoice,
  type TextStyle,
} from "../editor/model/text";
import {
  installedFonts,
  fontAlias,
  type InstalledFont,
} from "../editor/render/fonts";
import { patchLayer } from "../editor/commands/layers";
type Props = {
  doc: PhotoDocument;
  layer?: TextLayer;
  disabled: boolean;
  change(operation: (d: PhotoDocument) => PhotoDocument): void;
  importFont(): void;
  editCanvas(): void;
  addText(): void;
  draft(active: boolean): void;
};
const fontKey = (f: FontChoice) =>
  f.fontAsset ?? f.fontPostscript ?? f.fontFamily;
export function TextControls(p: Props) {
  const [fonts, setFonts] = useState<InstalledFont[]>([]),
    [fontError, setFontError] = useState(""),
    [presetName, setPresetName] = useState("");
  async function refresh() {
    try {
      setFonts(await installedFonts());
      setFontError("");
    } catch (e) {
      setFontError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  const layer = p.layer,
    disabled = p.disabled || !layer;
  function patch(value: Partial<TextStyle> & { text?: string }) {
    if (layer) p.change((d) => patchLayer(d, layer.id, value));
  }
  const choices = new Map<string, { font: FontChoice; name: string }>();
  for (const f of fonts)
    choices.set(f.postscriptName, {
      font: { fontFamily: f.family, fontPostscript: f.postscriptName },
      name: f.fullName,
    });
  for (const f of p.doc.fontFavourites ?? [])
    choices.set(fontKey(f), { font: f, name: `★ ${f.fontFamily}` });
  if (layer && !choices.has(fontKey(layer)))
    choices.set(fontKey(layer), {
      font: {
        fontFamily: layer.fontFamily,
        fontAsset: layer.fontAsset,
        fontPostscript: layer.fontPostscript,
      },
      name: layer.fontFamily,
    });
  const favourite =
    !!layer &&
    (p.doc.fontFavourites ?? []).some((f) => fontKey(f) === fontKey(layer));
  function number(
    label: string,
    key:
      | "fontSize"
      | "wrapWidth"
      | "lineHeight"
      | "letterSpacing"
      | "strokeWidth"
      | "curve",
    fallback: number,
    min: number,
    max: number,
    step = 1,
  ) {
    const value = layer?.[key] ?? fallback;
    return (
      <label>
        {label}
        <input
          key={`${layer?.id}-${key}-${value}`}
          aria-label={label}
          type="number"
          min={min}
          max={max}
          step={step}
          defaultValue={value}
          disabled={disabled || (key === "wrapWidth" && !layer?.wrapWidth)}
          onBlur={(e) => {
            if (
              Number.isFinite(e.target.valueAsNumber) &&
              e.target.valueAsNumber >= min &&
              e.target.valueAsNumber <= max
            )
              patch({ [key]: e.target.valueAsNumber });
            else e.target.value = String(value);
          }}
        />
      </label>
    );
  }
  return (
    <section className="text-controls" aria-label="Typography">
      <button className="tool-action" disabled={p.disabled} onClick={p.addText}>
        Add text layer
      </button>
      {!layer && (
        <p className="hint">Select a text layer to edit its typography.</p>
      )}
      <label>
        Text content
        <textarea
          key={layer?.id + (layer?.text ?? "")}
          aria-label="Text content"
          defaultValue={layer?.text ?? ""}
          maxLength={10000}
          disabled={disabled}
          onChange={() => p.draft(true)}
          onBlur={(e) => {
            patch({ text: e.target.value });
            p.draft(false);
          }}
        />
      </label>
      <button
        disabled={disabled || !!layer?.curve || !!layer?.warp?.amount}
        title="Or double-click the text. Ctrl+Enter finishes as one undo step; Esc cancels."
        onClick={p.editCanvas}
      >
        Edit on canvas
      </button>
      {(layer?.curve || layer?.warp?.amount) && (
        <p className="hint">
          Shaped text is edited in Text content above. Set curve and warp to
          zero to edit on the canvas.
        </p>
      )}
      <label>
        Font face
        <select
          aria-label="Font face"
          value={layer ? fontKey(layer) : ""}
          disabled={disabled}
          onChange={(e) => {
            const f = choices.get(e.target.value)?.font;
            if (f)
              patch({
                fontFamily: f.fontFamily,
                fontPostscript: f.fontPostscript,
                fontAsset: f.fontAsset,
              });
          }}
        >
          {!layer && <option value="">Select text</option>}
          {[...choices].map(([key, value]) => (
            <option
              key={key}
              value={key}
              style={{ fontFamily: value.font.fontFamily }}
            >
              {value.name}
            </option>
          ))}
        </select>
      </label>
      {layer && (
        <div className="font-sample" style={{ fontFamily: fontAlias(layer) }}>
          {layer.text.split("\n")[0] || "Aa Bb Cc · 123"}
        </div>
      )}
      <div className="button-grid">
        <button disabled={p.disabled} onClick={() => void refresh()}>
          Refresh installed fonts
        </button>
        <button
          disabled={disabled}
          title="Imported fonts are saved with this project. Installed fonts must stay installed on this computer."
          onClick={p.importFont}
        >
          Import font file
        </button>
        <button
          disabled={disabled}
          onClick={() => {
            if (!layer) return;
            const font = {
              fontFamily: layer.fontFamily,
              fontAsset: layer.fontAsset,
              fontPostscript: layer.fontPostscript,
            };
            p.change((d) => ({
              ...d,
              fontFavourites: favourite
                ? (d.fontFavourites ?? []).filter(
                    (f) => fontKey(f) !== fontKey(font),
                  )
                : [...(d.fontFavourites ?? []), font],
            }));
          }}
        >
          {favourite ? "Remove favourite font" : "Favourite font"}
        </button>
      </div>
      {fontError && (
        <p role="status" className="hint">
          {fontError}
        </p>
      )}
      <div className="fields">
        {number("Font size", "fontSize", 48, 1, 1000)}
        <label>
          Text colour
          <input
            aria-label="Text colour"
            type="color"
            disabled={disabled}
            value={layer?.fill ?? "#24262a"}
            onChange={(e) => patch({ fill: e.target.value })}
          />
        </label>
      </div>
      <div className="button-grid">
        <button
          aria-pressed={layer?.fontWeight === 700}
          disabled={disabled}
          onClick={() =>
            patch({ fontWeight: layer?.fontWeight === 700 ? 400 : 700 })
          }
        >
          Bold
        </button>
        <button
          aria-pressed={layer?.fontStyle === "italic"}
          disabled={disabled}
          onClick={() =>
            patch({
              fontStyle: layer?.fontStyle === "italic" ? "normal" : "italic",
            })
          }
        >
          Italic
        </button>
        <button
          aria-pressed={!!layer?.underline}
          disabled={disabled}
          onClick={() => patch({ underline: !layer?.underline })}
        >
          Underline
        </button>
      </div>
      <label className="check">
        <input
          type="checkbox"
          aria-label="Wrap text"
          disabled={disabled}
          checked={!!layer?.wrapWidth}
          onChange={(e) =>
            patch({
              wrapWidth: e.target.checked
                ? Math.max(20, Math.min(500, p.doc.width - 40))
                : undefined,
            })
          }
        />
        Wrap text
      </label>
      {number("Text box width", "wrapWidth", 400, 20, 12000)}
      <div className="fields">
        {number("Line spacing", "lineHeight", 1.16, 0.5, 4, 0.05)}
        {number("Letter spacing", "letterSpacing", 0, -20, 200, 0.5)}
      </div>
      <label>
        Paragraph alignment
        <select
          aria-label="Paragraph alignment"
          value={layer?.textAlign ?? "left"}
          disabled={disabled}
          onChange={(e) =>
            patch({ textAlign: e.target.value as TextStyle["textAlign"] })
          }
        >
          <option value="left">Left</option>
          <option value="center">Centre</option>
          <option value="right">Right</option>
          <option value="justify">Justify</option>
        </select>
      </label>
      <label className="check">
        <input
          type="checkbox"
          aria-label="Text background"
          disabled={disabled}
          checked={!!layer?.backgroundColor}
          onChange={(e) =>
            patch({ backgroundColor: e.target.checked ? "#e7dff5" : undefined })
          }
        />
        Text background
      </label>
      {layer?.backgroundColor && (
        <input
          aria-label="Background colour"
          type="color"
          value={layer.backgroundColor}
          disabled={disabled}
          onChange={(e) => patch({ backgroundColor: e.target.value })}
        />
      )}
      <label className="check">
        <input
          type="checkbox"
          aria-label="Text outline"
          disabled={disabled}
          checked={!!layer?.stroke}
          onChange={(e) =>
            patch({
              stroke: e.target.checked ? "#ffffff" : undefined,
              strokeWidth: e.target.checked ? 1 : 0,
            })
          }
        />
        Outline
      </label>
      {layer?.stroke && (
        <div className="fields">
          <input
            aria-label="Outline colour"
            type="color"
            value={layer.stroke}
            disabled={disabled}
            onChange={(e) => patch({ stroke: e.target.value })}
          />
          {number("Outline width", "strokeWidth", 1, 0, 30, 0.5)}
        </div>
      )}
      <label className="check">
        <input
          type="checkbox"
          aria-label="Text shadow"
          disabled={disabled}
          checked={!!layer?.shadow}
          onChange={(e) =>
            patch({
              shadow: e.target.checked
                ? { color: "#24262a", blur: 6, offsetX: 3, offsetY: 3 }
                : undefined,
            })
          }
        />
        Shadow
      </label>
      {layer?.shadow && (
        <>
          <input
            aria-label="Shadow colour"
            type="color"
            disabled={disabled}
            value={layer.shadow.color}
            onChange={(e) =>
              patch({ shadow: { ...layer.shadow!, color: e.target.value } })
            }
          />
          <div className="fields">
            {(["blur", "offsetX", "offsetY"] as const).map((key) => (
              <label key={key}>
                {key === "blur"
                  ? "Blur"
                  : key === "offsetX"
                    ? "Offset X"
                    : "Offset Y"}
                <input
                  key={String(layer.shadow![key])}
                  aria-label={`Shadow ${key}`}
                  type="number"
                  min={key === "blur" ? 0 : -100}
                  max="100"
                  defaultValue={layer.shadow![key]}
                  disabled={disabled}
                  onBlur={(e) => {
                    if (
                      Number.isFinite(e.target.valueAsNumber) &&
                      e.target.valueAsNumber >= (key === "blur" ? 0 : -100) &&
                      e.target.valueAsNumber <= 100
                    )
                      patch({
                        shadow: {
                          ...layer.shadow!,
                          [key]: e.target.valueAsNumber,
                        },
                      });
                    else e.target.value = String(layer.shadow![key]);
                  }}
                />
              </label>
            ))}
          </div>
        </>
      )}
      <h2>Curve &amp; warp</h2>
      {number("Curve amount", "curve", 0, -100, 100)}
      <p className="hint">
        Positive curves arch upward; negative curves dip downward. Zero restores
        straight text. The entire paragraph bends, including its effects.
      </p>
      <label>
        Warp shape
        <select
          aria-label="Warp shape"
          disabled={disabled}
          value={layer?.warp?.kind ?? "none"}
          onChange={(e) =>
            patch({
              warp:
                e.target.value === "none"
                  ? undefined
                  : {
                      kind: e.target.value as "wave" | "bulge",
                      amount: layer?.warp?.amount ?? 30,
                    },
            })
          }
        >
          <option value="none">None</option>
          <option value="wave">Wave</option>
          <option value="bulge">Bulge / pinch</option>
        </select>
      </label>
      {layer?.warp && (
        <label>
          Warp amount
          <input
            key={`${layer.id}-${layer.warp.amount}`}
            aria-label="Warp amount"
            type="number"
            min={-100}
            max={100}
            defaultValue={layer.warp.amount}
            disabled={disabled}
            onBlur={(e) => {
              const amount = e.target.valueAsNumber;
              if (Number.isFinite(amount) && Math.abs(amount) <= 100)
                patch({ warp: { ...layer.warp!, amount } });
              else e.target.value = String(layer.warp!.amount);
            }}
          />
        </label>
      )}
      <button
        disabled={disabled || (!layer?.curve && !layer?.warp)}
        onClick={() => patch({ curve: undefined, warp: undefined })}
      >
        Reset curve and warp
      </button>
      <p className="hint">
        Text, fonts and shape settings stay editable. Shape rendering uses
        document pixels; enlarging the layer can soften its edges.
      </p>
      <h2>Project text styles</h2>
      <label>
        Style name
        <input
          aria-label="Text style name"
          maxLength={80}
          value={presetName}
          disabled={disabled}
          onChange={(e) => setPresetName(e.target.value)}
        />
      </label>
      <button
        disabled={
          disabled ||
          !presetName.trim() ||
          (p.doc.textPresets?.length ?? 0) >= 30
        }
        onClick={() => {
          if (!layer) return;
          const preset = {
            id: crypto.randomUUID(),
            name: presetName.trim(),
            style: textStyleSchema.parse(layer),
          };
          p.change((d) => ({
            ...d,
            textPresets: [...(d.textPresets ?? []), preset],
          }));
          setPresetName("");
        }}
      >
        Save text style
      </button>
      {(p.doc.textPresets ?? []).map((preset) => (
        <div className="button-grid" key={preset.id}>
          <button
            disabled={disabled}
            onClick={() => {
              if (!layer) return;
              const cleared = Object.fromEntries(
                Object.keys(textStyleSchema.shape).map((key) => [
                  key,
                  undefined,
                ]),
              );
              patch({ ...cleared, ...preset.style });
            }}
          >
            {preset.name}
          </button>
          <button
            aria-label={`Delete style ${preset.name}`}
            disabled={p.disabled}
            onClick={() =>
              p.change((d) => ({
                ...d,
                textPresets: (d.textPresets ?? []).filter(
                  (s) => s.id !== preset.id,
                ),
              }))
            }
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
      <p className="hint">
        Favourites and styles travel with this project. Applying a style keeps
        the text, placement and layer identity.
      </p>
    </section>
  );
}
