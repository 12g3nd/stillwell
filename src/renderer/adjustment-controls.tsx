import React, { useState } from "react";
import {
  neutralAdjustments,
  type Adjustments,
} from "../editor/model/adjustments";
export function AdjustmentControls(p: {
  disabled: boolean;
  busy: boolean;
  previewing: boolean;
  preview(s: Adjustments): void;
  apply(): void;
  cancel(): void;
  compare(before: boolean): void;
}) {
  const [values, setValues] = useState<Adjustments>({ ...neutralAdjustments });
  const field = (
    key: keyof Adjustments,
    label: string,
    min: number,
    max: number,
    step = 1,
  ) => (
    <label key={key}>
      {label}
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={values[key]}
        disabled={p.busy || p.previewing || p.disabled}
        onChange={(e) =>
          setValues((v) => ({ ...v, [key]: e.target.valueAsNumber }))
        }
      />
    </label>
  );
  return (
    <section className="adjustment-controls" aria-label="Photo adjustments">
      <p className="hint">
        Adjust the selected image. Its original and cutout mask stay preserved.
        Preview first, then apply one undoable change.
      </p>
      <div className="fields">
        {field("exposure", "Exposure (EV)", -4, 4, 0.1)}
        {field("brightness", "Brightness", -100, 100)}
        {field("contrast", "Contrast", -100, 100)}
        {field("saturation", "Saturation", -100, 100)}
        {field("temperature", "Temperature", -100, 100)}
        {field("tint", "Tint", -100, 100)}
        {field("sharpen", "Sharpen", 0, 3, 0.1)}
      </div>
      <details>
        <summary>Levels &amp; tone curve</summary>
        <div className="fields">
          {field("black", "Black point", 0, 254)}
          {field("white", "White point", 1, 255)}
          {field("gamma", "Midtone gamma", 0.2, 5, 0.1)}
          {field("shadows", "Curve shadows", 0, 255, 0.25)}
          {field("midtones", "Curve midtones", 0, 255, 0.25)}
          {field("highlights", "Curve highlights", 0, 255, 0.25)}
        </div>
        <p className="hint">
          Curve controls set output at 25%, 50% and 75% input. Black and white
          endpoints remain fixed; segments interpolate linearly.
        </p>
      </details>
      {p.previewing ? (
        <>
          <div className="button-grid">
            <button disabled={p.busy} onClick={p.apply}>
              Apply adjustments
            </button>
            <button disabled={p.busy} onClick={p.cancel}>
              Cancel adjustments
            </button>
          </div>
          <div className="button-grid">
            <button disabled={p.busy} onClick={() => p.compare(true)}>
              Show before
            </button>
            <button disabled={p.busy} onClick={() => p.compare(false)}>
              Show after
            </button>
          </div>
        </>
      ) : (
        <div className="button-grid">
          <button
            disabled={p.disabled || p.busy}
            onClick={() => p.preview(values)}
          >
            Preview adjustments
          </button>
          <button
            disabled={p.busy}
            onClick={() => setValues({ ...neutralAdjustments })}
          >
            Reset adjustments
          </button>
        </div>
      )}
    </section>
  );
}
