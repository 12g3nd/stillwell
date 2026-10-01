import React, { useEffect, useState } from "react";
import { documentSchema, type PhotoDocument } from "../editor/model/document";
import { resize } from "../editor/commands/geometry";
import { vectorPrintSupported } from "../editor/render/print";

export function PrintControls({
  doc,
  disabled,
  change,
  exportPdf,
}: {
  doc: PhotoDocument;
  disabled: boolean;
  change(doc: PhotoDocument): void;
  exportPdf(): void;
}) {
  const [dpi, setDpi] = useState(doc.dpi ?? 300),
    [width, setWidth] = useState(0),
    [height, setHeight] = useState(0),
    [border, setBorder] = useState(doc.border?.width ?? 0),
    [colour, setColour] = useState(doc.border?.colour ?? "#ffffff"),
    [error, setError] = useState("");
  useEffect(() => {
    setDpi(doc.dpi ?? 300);
    setWidth((doc.width / (doc.dpi ?? 300)) * 25.4);
    setHeight((doc.height / (doc.dpi ?? 300)) * 25.4);
    setBorder(doc.border?.width ?? 0);
    setColour(doc.border?.colour ?? "#ffffff");
  }, [doc]);
  function apply(resample: boolean) {
    try {
      let next = documentSchema.parse({
        ...doc,
        dpi,
        border: { width: border, colour },
      });
      if (resample)
        next = resize(
          next,
          Math.round((width / 25.4) * dpi),
          Math.round((height / 25.4) * dpi),
          "fit",
        );
      setError("");
      change(next);
    } catch {
      setError(
        "Use 36–1200 PPI, a 0–2000 px border, and dimensions within 12,000 px per side / 24 MP.",
      );
    }
  }
  const settingsPending =
    dpi !== (doc.dpi ?? 300) ||
    border !== (doc.border?.width ?? 0) ||
    colour !== (doc.border?.colour ?? "#ffffff");
  return (
    <section className="size-controls">
      <p>
        {doc.width} × {doc.height} px ·{" "}
        {((doc.width / (doc.dpi ?? 300)) * 25.4).toFixed(2)} ×{" "}
        {((doc.height / (doc.dpi ?? 300)) * 25.4).toFixed(2)} mm
      </p>
      <fieldset disabled={disabled}>
        <label>
          Resolution (PPI)
          <input
            aria-label="Print resolution"
            type="number"
            min="36"
            max="1200"
            value={dpi}
            onChange={(e) => setDpi(e.target.valueAsNumber)}
          />
        </label>
        <label>
          Inside border (px)
          <input
            aria-label="Border width"
            type="number"
            min="0"
            max="2000"
            value={border}
            onChange={(e) => setBorder(e.target.valueAsNumber)}
          />
        </label>
        <label>
          Border colour
          <input
            aria-label="Border colour"
            type="color"
            value={colour}
            onChange={(e) => setColour(e.target.value)}
          />
        </label>
        <p className="hint">
          The border covers the inside edge of the artwork and appears in all
          exports. Zero removes it. Original layers stay editable.
        </p>
        <button onClick={() => apply(false)}>Apply print settings</button>
        <p className="hint">
          Resolution changes the physical print size without changing pixels.
          PDFs use this exact page size; print at 100% / actual size.
        </p>
        <details>
          <summary>Resize to a physical size</summary>
          <label>
            Width (mm)
            <input
              aria-label="Print width mm"
              type="number"
              min="0.1"
              step="0.1"
              value={width}
              onChange={(e) => setWidth(e.target.valueAsNumber)}
            />
          </label>
          <label>
            Height (mm)
            <input
              aria-label="Print height mm"
              type="number"
              min="0.1"
              step="0.1"
              value={height}
              onChange={(e) => setHeight(e.target.valueAsNumber)}
            />
          </label>
          <p className="hint">
            Fits the composition into the new pixel dimensions at the selected
            PPI. Layers remain editable. Undo restores the previous size.
          </p>
          <button onClick={() => apply(true)}>Resize for print</button>
        </details>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <p className="hint">
        {vectorPrintSupported(doc)
          ? "PDF keeps ordinary text and the border as vectors. Photos and imported SVG/PSD remain raster images."
          : "This composition uses groups, blending or text effects. PDF flattens the artwork for fidelity; the border stays vector. The saved project stays editable."}{" "}
        PDF is sRGB, not a CMYK proof.
      </p>
      {settingsPending && (
        <p className="hint">Apply print settings before exporting the PDF.</p>
      )}
      <button disabled={disabled || settingsPending} onClick={exportPdf}>
        Export print PDF
      </button>
    </section>
  );
}
