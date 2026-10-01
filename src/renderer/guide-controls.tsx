import React, { useState } from "react";
import type { PhotoDocument } from "../editor/model/document";
import type { Workspace } from "../editor/render/adapter";
export function GuideControls({
  doc,
  workspace,
  disabled,
  change,
}: {
  doc: PhotoDocument;
  workspace: Workspace;
  disabled: boolean;
  change: (fn: (doc: PhotoDocument) => PhotoDocument) => void;
}) {
  const [axis, setAxis] = useState<"x" | "y">("x"),
    [position, setPosition] = useState(100),
    [, refresh] = useState(0);
  return (
    <section className="guides">
      <h2>Guides & snapping</h2>
      {(
        [
          ["guidesVisible", "Show guides"],
          ["snapGrid", "Snap to grid"],
          ["snapGuides", "Snap to guides"],
          ["snapLayers", "Snap to layers"],
        ] as const
      ).map(([key, label]) => (
        <label className="toggle" key={key}>
          <input
            type="checkbox"
            checked={workspace[key]}
            onChange={(e) => {
              workspace[key] = e.target.checked;
              workspace.drawOverlay();
              refresh((v) => v + 1);
            }}
          />
          {label}
        </label>
      ))}
      <label>
        Grid spacing
        <input
          aria-label="Grid spacing"
          type="number"
          min="4"
          max="1000"
          value={workspace.gridSize}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (Number.isInteger(v) && v >= 4 && v <= 1000) {
              workspace.gridSize = v;
              workspace.drawOverlay();
              refresh((n) => n + 1);
            }
          }}
        />
      </label>
      <div className="fields">
        <label>
          Guide axis
          <select
            aria-label="Guide axis"
            value={axis}
            onChange={(e) => setAxis(e.target.value as "x" | "y")}
          >
            <option value="x">Vertical</option>
            <option value="y">Horizontal</option>
          </select>
        </label>
        <label>
          Position
          <input
            aria-label="Guide position"
            type="number"
            value={position}
            onChange={(e) => setPosition(e.target.valueAsNumber)}
          />
        </label>
      </div>
      <button
        disabled={disabled || !Number.isFinite(position)}
        onClick={() =>
          change((d) => ({
            ...d,
            schemaVersion: 2,
            guides: [
              ...(d.guides ?? []),
              { id: crypto.randomUUID(), axis, position },
            ],
          }))
        }
      >
        Add guide
      </button>
      {(doc.guides ?? []).map((g) => (
        <div className="guide-row" key={g.id}>
          <span>
            {g.axis === "x" ? "Vertical" : "Horizontal"} · {g.position} px
          </span>
          <button
            aria-label={"Remove guide " + g.position}
            disabled={disabled}
            onClick={() =>
              change((d) => ({
                ...d,
                guides: d.guides?.filter((item) => item.id !== g.id),
              }))
            }
          >
            ×
          </button>
        </div>
      ))}
      <p className="hint">
        Guides are saved with the project and never exported. Snapping is
        independent of visibility.
      </p>
    </section>
  );
}
