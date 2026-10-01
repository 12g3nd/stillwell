import React, { useState } from "react";
import type { PhotoFilter } from "../editor/model/filters";
export function FilterControls(p: {
  disabled: boolean;
  busy: boolean;
  previewing: boolean;
  preview(filter: PhotoFilter): void;
  apply(): void;
  cancel(): void;
  compare(before: boolean): void;
}) {
  const [kind, setKind] = useState<PhotoFilter["kind"]>("mono"),
    [amount, setAmount] = useState(100),
    [radius, setRadius] = useState(8);
  return (
    <section>
      <p className="hint">
        Preview the selected image. Original pixels and cutout masks stay
        preserved. Apply makes one undoable change.
      </p>
      <fieldset disabled={p.disabled || p.busy || p.previewing}>
        <label>
          Filter
          <select
            aria-label="Photo filter"
            value={kind}
            onChange={(e) => setKind(e.target.value as PhotoFilter["kind"])}
          >
            <option value="mono">Black & white</option>
            <option value="sepia">Sepia</option>
            <option value="blur">Gaussian blur</option>
            <option value="pixelate">Pixelate</option>
            <option value="vignette">Vignette</option>
          </select>
        </label>
        <label>
          Amount (%)
          <input
            aria-label="Filter amount"
            type="number"
            min="0"
            max="100"
            value={amount}
            onChange={(e) => setAmount(e.target.valueAsNumber)}
          />
        </label>
        {(kind === "blur" || kind === "pixelate") && (
          <label>
            {kind === "blur" ? "Blur size (px)" : "Block size (px)"}
            <input
              aria-label="Filter size"
              type="number"
              min="1"
              max="64"
              value={radius}
              onChange={(e) => setRadius(e.target.valueAsNumber)}
            />
          </label>
        )}
        <button onClick={() => p.preview({ kind, amount, radius })}>
          Preview filter
        </button>
      </fieldset>
      {p.busy && (
        <p role="status" aria-label="Filter progress">
          Rendering filter…
        </p>
      )}
      {p.previewing && (
        <>
          <div className="button-grid">
            <button disabled={p.busy} onClick={() => p.compare(true)}>
              Show before
            </button>
            <button disabled={p.busy} onClick={() => p.compare(false)}>
              Show after
            </button>
          </div>
          <div className="button-grid">
            <button disabled={p.busy} onClick={p.apply}>
              Apply filter
            </button>
            <button disabled={p.busy} onClick={p.cancel}>
              Cancel filter
            </button>
          </div>
        </>
      )}
    </section>
  );
}
