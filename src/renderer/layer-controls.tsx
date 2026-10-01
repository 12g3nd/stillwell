import React from "react";
import {
  flattenLayers,
  type PhotoDocument,
  type Layer,
  type Matrix,
} from "../editor/model/document";
import {
  locate,
  isLocked,
  patchLayer,
  renameLayer,
  duplicate,
  reorder,
  moveBefore,
  groupLayers,
  ungroup,
  align,
  distribute,
  type Bounds,
} from "../editor/commands/layers";
type Props = {
  doc: PhotoDocument;
  selected: string[];
  disabled: boolean;
  select: (id: string, add: boolean) => void;
  change: (operation: (doc: PhotoDocument) => PhotoDocument) => void;
  addImage: () => void;
  addText: () => void;
  textPanel: boolean;
  openText: () => void;
  bounds: () => Record<string, Bounds>;
  intrinsic: (id: string) => { width: number; height: number } | undefined;
};
export function LayerControls(p: Props) {
  const one =
    p.selected.length === 1 ? locate(p.doc, p.selected[0])?.layer : undefined;
  const locked = !!one && isLocked(p.doc, one.id);
  const editable = !!one && !locked && !p.disabled;
  function patch(value: Partial<Layer>) {
    if (one) p.change((doc) => patchLayer(doc, one.id, value));
  }
  function numeric(kind: "width" | "height" | "angle", value: number) {
    if (!one || !Number.isFinite(value)) return;
    const size = p.intrinsic(one.id);
    if (!size) return;
    const t = [...one.transform] as Matrix;
    const sx = Math.hypot(t[0], t[1]),
      sy = Math.hypot(t[2], t[3]);
    if (kind === "angle") {
      const delta = (value * Math.PI) / 180 - Math.atan2(t[1], t[0]),
        cos = Math.cos(delta),
        sin = Math.sin(delta);
      [t[0], t[1], t[2], t[3]] = [
        cos * t[0] - sin * t[1],
        sin * t[0] + cos * t[1],
        cos * t[2] - sin * t[3],
        sin * t[2] + cos * t[3],
      ];
    } else {
      if (value <= 0) return;
      const factor =
        value / (kind === "width" ? size.width * sx : size.height * sy);
      if (kind === "width" || one.aspectLocked) {
        t[0] *= factor;
        t[1] *= factor;
      }
      if (kind === "height" || one.aspectLocked) {
        t[2] *= factor;
        t[3] *= factor;
      }
    }
    patch({ transform: t });
  }
  function rows(layers: Layer[], depth = 0): React.ReactNode {
    return [...layers].reverse().map((l) => {
      const f = locate(p.doc, l.id)!;
      const inherited = f.ancestors.some((a) => a.locked);
      return (
        <React.Fragment key={l.id}>
          <div
            className={
              "layer-row " + (p.selected.includes(l.id) ? "selected" : "")
            }
            style={{ paddingLeft: depth * 12 + 6 }}
            draggable={!p.disabled && !isLocked(p.doc, l.id)}
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-photo-layer", l.id);
              e.stopPropagation();
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("application/x-photo-layer")) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            onDrop={(e) => {
              const source = e.dataTransfer.getData(
                "application/x-photo-layer",
              );
              if (source) {
                e.preventDefault();
                e.stopPropagation();
                p.change((doc) => moveBefore(doc, source, l.id));
              }
            }}
          >
            <button
              className="layer-pick"
              aria-label={"Select " + l.name}
              aria-pressed={p.selected.includes(l.id)}
              disabled={p.disabled}
              onClick={(e) =>
                p.select(l.id, e.ctrlKey || e.metaKey || e.shiftKey)
              }
            >
              <span>
                {l.kind === "group" ? "▱" : l.kind === "text" ? "T" : "▧"}
              </span>
              <strong>{l.name}</strong>
            </button>
            <button
              className="layer-state"
              aria-label={(l.visible ? "Hide " : "Show ") + l.name}
              disabled={p.disabled || isLocked(p.doc, l.id)}
              onClick={() =>
                p.change((doc) =>
                  patchLayer(doc, l.id, { visible: !l.visible }),
                )
              }
            >
              {l.visible ? "◉" : "○"}
            </button>
            <button
              className="layer-state"
              aria-label={(l.locked ? "Unlock " : "Lock ") + l.name}
              disabled={p.disabled || inherited}
              onClick={() =>
                p.change((doc) => patchLayer(doc, l.id, { locked: !l.locked }))
              }
            >
              {l.locked || inherited ? "●" : "◇"}
            </button>
          </div>
          {l.kind === "group" && rows(l.children, depth + 1)}
        </React.Fragment>
      );
    });
  }
  const size = one ? p.intrinsic(one.id) : undefined;
  return (
    <>
      <div className="panel-title">
        <h2>Layers</h2>
        <span className="count">{flattenLayers(p.doc.layers).length}</span>
      </div>
      <div className="layer-add">
        <button disabled={p.disabled} onClick={p.addImage}>
          Add image
        </button>
        <button disabled={p.disabled} onClick={p.addText}>
          Add text
        </button>
      </div>
      <div className="layer-list" role="group" aria-label="Layer stack">
        {rows(p.doc.layers)}
      </div>
      <p className="hint">
        Ctrl/Shift-click to select several. Drag rows to reorder within a group.
      </p>
      <div className="layer-actions">
        <button
          disabled={p.disabled || !p.selected.length}
          onClick={() => p.change((doc) => duplicate(doc, p.selected))}
        >
          Duplicate
        </button>
        <button
          aria-label="Move layer up"
          disabled={!editable}
          onClick={() => p.change((doc) => reorder(doc, one!.id, 1))}
        >
          Up
        </button>
        <button
          aria-label="Move layer down"
          disabled={!editable}
          onClick={() => p.change((doc) => reorder(doc, one!.id, -1))}
        >
          Down
        </button>
        <button
          disabled={p.disabled || p.selected.length < 2}
          onClick={() => p.change((doc) => groupLayers(doc, p.selected))}
        >
          Group
        </button>
        <button
          disabled={!editable || one?.kind !== "group"}
          onClick={() => p.change((doc) => ungroup(doc, one!.id))}
        >
          Ungroup
        </button>
      </div>
      {one && (
        <div className="layer-properties">
          <label>
            Name
            <input
              key={one.id + one.name}
              aria-label="Layer name"
              defaultValue={one.name}
              disabled={!editable}
              maxLength={200}
              onBlur={(e) => {
                const name = e.target.value;
                if (name !== one.name)
                  p.change((doc) => renameLayer(doc, one.id, name));
              }}
            />
          </label>
          <div className="fields">
            {(["width", "height"] as const).map((kind) => (
              <label key={kind}>
                {kind === "width" ? "Width" : "Height"}
                <input
                  key={one.id + one.transform.join(",") + kind}
                  aria-label={"Layer " + kind}
                  type="number"
                  min="1"
                  defaultValue={
                    size
                      ? Math.round(
                          size[kind] *
                            Math.hypot(
                              ...(kind === "width"
                                ? [one.transform[0], one.transform[1]]
                                : [one.transform[2], one.transform[3]]),
                            ) *
                            100,
                        ) / 100
                      : 0
                  }
                  disabled={!editable}
                  onBlur={(e) => numeric(kind, e.target.valueAsNumber)}
                />
              </label>
            ))}
          </div>
          <label className="toggle">
            <input
              aria-label="Layer aspect lock"
              type="checkbox"
              disabled={!editable}
              checked={!!one.aspectLocked}
              onChange={(e) => patch({ aspectLocked: e.target.checked })}
            />
            Lock aspect ratio
          </label>
          <div className="fields">
            <label>
              Angle
              <input
                key={one.id + one.transform.join(",") + "angle"}
                aria-label="Layer angle"
                type="number"
                defaultValue={
                  Math.round(
                    ((Math.atan2(one.transform[1], one.transform[0]) * 180) /
                      Math.PI) *
                      100,
                  ) / 100
                }
                disabled={!editable}
                onBlur={(e) => numeric("angle", e.target.valueAsNumber)}
              />
            </label>
            <label>
              Opacity %
              <input
                key={one.id + "opacity" + one.opacity}
                aria-label="Layer opacity"
                type="number"
                min="0"
                max="100"
                defaultValue={one.opacity * 100}
                disabled={!editable}
                onBlur={(e) => {
                  if (Number.isFinite(e.target.valueAsNumber))
                    patch({ opacity: e.target.valueAsNumber / 100 });
                }}
              />
            </label>
          </div>
          <label>
            Blend
            <select
              aria-label="Layer blend"
              disabled={!editable}
              value={one.blend ?? "source-over"}
              onChange={(e) =>
                patch({ blend: e.target.value as Layer["blend"] })
              }
            >
              <option value="source-over">Normal</option>
              <option value="multiply">Multiply</option>
              <option value="screen">Screen</option>
            </select>
          </label>
          {one.kind === "text" && !p.textPanel && (
            <label>
              Text content
              <textarea
                aria-label="Text content"
                key={one.id + one.text}
                defaultValue={one.text}
                disabled={!editable}
                maxLength={10000}
                onBlur={(e) => patch({ text: e.target.value })}
              />
            </label>
          )}
          {one.kind === "text" && (
            <button disabled={p.disabled} onClick={p.openText}>
              Typography
            </button>
          )}
          {one.kind === "group" && (
            <p className="hint">
              Isolated group: opacity applies once to the combined children.
              Ungroup needs 100% group opacity and Normal blend on the group and
              direct children.
            </p>
          )}
          {locked && (
            <p className="hint">
              Unlock this layer or its parent group to edit it.
            </p>
          )}
        </div>
      )}
      <div className="alignment">
        <h3>Align & distribute</h3>
        <div className="layer-actions">
          {(
            ["left", "centerX", "right", "top", "centerY", "bottom"] as const
          ).map((mode) => (
            <button
              key={mode}
              disabled={p.disabled || !p.selected.length}
              onClick={() =>
                p.change((doc) => align(doc, p.selected, p.bounds(), mode))
              }
            >
              {
                {
                  left: "Left",
                  centerX: "Centre X",
                  right: "Right",
                  top: "Top",
                  centerY: "Centre Y",
                  bottom: "Bottom",
                }[mode]
              }
            </button>
          ))}
          <button
            disabled={p.disabled || p.selected.length < 3}
            onClick={() =>
              p.change((doc) => distribute(doc, p.selected, p.bounds(), "x"))
            }
          >
            Space horizontally
          </button>
          <button
            disabled={p.disabled || p.selected.length < 3}
            onClick={() =>
              p.change((doc) => distribute(doc, p.selected, p.bounds(), "y"))
            }
          >
            Space vertically
          </button>
        </div>
        <p className="hint">
          One layer aligns to the canvas; multiple layers align to their
          combined bounds.
        </p>
      </div>
    </>
  );
}
