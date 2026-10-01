import React, { useEffect, useRef, useState } from "react";
import type { PhotoDocument, Matrix } from "../editor/model/document";
import type { Stroke } from "../editor/model/strokes";
import type { PixelPoint } from "../editor/model/mask";
import { inverse, isLocked, locate, multiply } from "../editor/commands/layers";
import type { Workspace, PointerTool } from "../editor/render/adapter";
type Props = {
  mode: "retouch" | "draw" | "liquify";
  doc: PhotoDocument;
  selected: string[];
  workspace: Workspace;
  busy: boolean;
  run(action: () => Promise<void>): Promise<void>;
  flush(): Promise<void>;
  apply(
    id: string,
    result: Awaited<ReturnType<Window["photo"]["strokeImage"]>>,
  ): Promise<void>;
  newLayer(): void;
};
const mapPoint = (m: Matrix, p: PixelPoint) => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
});
export function StrokeControls(p: Props) {
  const [kind, setKind] = useState<Stroke["kind"]>(
      p.mode === "retouch" ? "clone" : p.mode === "draw" ? "paint" : "push",
    ),
    [diameter, setDiameter] = useState(32),
    [hardness, setHardness] = useState(0.5),
    [opacity, setOpacity] = useState(1),
    [colour, setColour] = useState("#b93d39"),
    [picking, setPicking] = useState(false),
    [source, setSource] = useState<PixelPoint>(),
    [draft, setDraft] = useState(false);
  const points = useRef<PixelPoint[]>([]),
    dragging = useRef(false),
    tooLong = useRef(false),
    working = useRef(false);
  const generation = useRef(0);
  function cancel() {
    generation.current++;
    clear();
    setPicking(false);
    window.photo.cancelStroke();
  }
  const found =
      p.selected.length === 1 ? locate(p.doc, p.selected[0]) : undefined,
    layer = found?.layer.kind === "raster" ? found.layer : undefined;
  const enabled =
    !!layer &&
    !isLocked(p.doc, layer.id) &&
    layer.visible &&
    !found?.ancestors.some((l) => !l.visible);
  const matrix = found
    ? multiply(found.parentMatrix, found.layer.transform)
    : ([1, 0, 0, 1, 0, 0] as Matrix);
  const latest = useRef({
    p,
    layer,
    enabled,
    matrix,
    kind,
    diameter,
    hardness,
    opacity,
    colour,
    picking,
    source,
  });
  latest.current = {
    p,
    layer,
    enabled,
    matrix,
    kind,
    diameter,
    hardness,
    opacity,
    colour,
    picking,
    source,
  };
  function clear() {
    points.current = [];
    dragging.current = false;
    tooLong.current = false;
    setDraft(false);
    window.photo.previewActive(false);
    p.workspace.drawOverlay();
  }
  async function submit(path: PixelPoint[]) {
    const c = latest.current;
    if (!c.layer || working.current) return;
    working.current = true;
    const token = ++generation.current;
    await c.p.run(async () => {
      try {
        await c.p.flush();
        if (token !== generation.current)
          throw Error("Brush operation cancelled");
        const result = await window.photo.strokeImage(c.layer!.id, {
          kind: c.kind,
          points: path,
          source: c.source,
          diameter: c.diameter,
          hardness: c.hardness,
          opacity: c.opacity,
          colour: c.colour,
        });
        if (token !== generation.current)
          throw Error("Brush operation cancelled");
        await c.p.apply(c.layer!.id, result);
      } finally {
        working.current = false;
      }
    });
  }
  const controller = useRef<PointerTool | undefined>(undefined);
  if (!controller.current)
    controller.current = {
      down(world) {
        const c = latest.current;
        if (!c.enabled || c.p.busy || working.current) return;
        const point = mapPoint(inverse(c.matrix), world);
        if (c.picking) {
          setSource(point);
          setPicking(false);
          return;
        }
        if (c.kind === "clone" && !c.source) {
          void c.p.run(async () => {
            throw Error("Choose Pick clone source, then click the image.");
          });
          return;
        }
        if (c.kind === "heal") {
          void submit([point]);
          return;
        }
        clear();
        points.current = [point];
        dragging.current = true;
        setDraft(true);
        window.photo.previewActive(true);
        c.p.workspace.drawOverlay();
      },
      move(world) {
        const c = latest.current;
        if (!dragging.current || c.p.busy) return;
        const point = mapPoint(inverse(c.matrix), world),
          last = points.current.at(-1)!;
        if (Math.hypot(point.x - last.x, point.y - last.y) >= 0.5) {
          if (points.current.length >= 1024) tooLong.current = true;
          else points.current.push(point);
        }
        c.p.workspace.drawOverlay();
      },
      up(world) {
        if (!dragging.current) return;
        controller.current!.move(world);
        const path = points.current.slice(),
          invalid = tooLong.current;
        clear();
        if (invalid) {
          void latest.current.p.run(async () => {
            throw Error("Stroke is too long. Use shorter strokes.");
          });
          return;
        }
        queueMicrotask(() => void submit(path));
      },
      finish() {},
      draw(ctx) {
        const c = latest.current,
          w = c.p.workspace;
        if (!c.enabled) return;
        ctx.save();
        ctx.translate(w.offset.x, w.offset.y);
        ctx.scale(w.zoom, w.zoom);
        ctx.transform(...c.matrix);
        ctx.strokeStyle = c.kind === "paint" ? c.colour : "#b93d39";
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = c.diameter;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (points.current.length) {
          const first = points.current[0];
          ctx.beginPath();
          ctx.moveTo(first.x, first.y);
          for (const point of points.current.slice(1))
            ctx.lineTo(point.x, point.y);
          if (points.current.length === 1) ctx.lineTo(first.x + 0.01, first.y);
          ctx.stroke();
        }
        if (c.source && c.kind === "clone") {
          ctx.globalAlpha = 1;
          ctx.lineWidth =
            1 / Math.max(0.01, w.zoom * Math.hypot(c.matrix[0], c.matrix[1]));
          ctx.beginPath();
          ctx.arc(c.source.x, c.source.y, 5, 0, Math.PI * 2);
          ctx.moveTo(c.source.x - 8, c.source.y);
          ctx.lineTo(c.source.x + 8, c.source.y);
          ctx.moveTo(c.source.x, c.source.y - 8);
          ctx.lineTo(c.source.x, c.source.y + 8);
          ctx.stroke();
        }
        ctx.restore();
      },
    };
  useEffect(() => {
    p.workspace.setPointerTool(controller.current);
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !(e.target as HTMLElement).matches("input,textarea,select")
      )
        cancel();
    };
    const blur = () => clear();
    window.addEventListener("keydown", key);
    window.addEventListener("blur", blur);
    return () => {
      clear();
      p.workspace.setPointerTool();
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    clear();
    setSource(undefined);
    setPicking(false);
  }, [p.doc.id, layer?.id]);
  useEffect(() => {
    clear();
  }, [layer?.asset, layer?.mask]);
  useEffect(() => {
    p.workspace.drawOverlay();
  }, [source, p.doc]);
  return (
    <section aria-label="Brush controls">
      <p>
        {layer
          ? `${p.mode === "draw" ? "Paint" : "Image"} · ${layer.name}`
          : "Select one image layer"}
      </p>
      <p className="hint">
        {p.mode === "retouch"
          ? "Clone copies from a picked source; each stroke starts there. Spot heal borrows nearby texture for small blemishes. Alpha and cutout masks stay intact."
          : p.mode === "draw"
            ? "Paint on the selected image, or start a separate transparent layer. Use Cutout’s remove/restore brush for reversible erasing."
            : "Deform the selected image and its cutout mask together. Push drags pixels; Pinch and Expand reshape a local area."}{" "}
        Release to apply one undo step. Escape cancels an unfinished stroke.
        Brush sizes use image pixels.
      </p>
      {p.mode === "draw" && (
        <button disabled={p.busy || draft} onClick={p.newLayer}>
          New paint layer
        </button>
      )}
      <fieldset disabled={!enabled || p.busy || draft}>
        {p.mode !== "draw" && (
          <label>
            Brush tool
            <select
              aria-label="Brush tool"
              value={kind}
              onChange={(e) => {
                clear();
                setPicking(false);
                setKind(e.target.value as Stroke["kind"]);
              }}
            >
              {p.mode === "retouch" ? (
                <>
                  <option value="clone">Clone</option>
                  <option value="heal">Spot heal</option>
                </>
              ) : (
                <>
                  <option value="push">Push</option>
                  <option value="pinch">Pinch</option>
                  <option value="expand">Expand</option>
                </>
              )}
            </select>
          </label>
        )}
        {kind === "clone" && (
          <button onClick={() => setPicking(!picking)}>
            {picking ? "Cancel source pick" : "Pick clone source"}
          </button>
        )}
        {kind === "clone" && (
          <p role="status" aria-label="Clone source">
            {picking
              ? "Click the source on the image"
              : source
                ? `Source ${source.x.toFixed(1)}, ${source.y.toFixed(1)}`
                : "No source selected"}
          </p>
        )}
        <label>
          Brush size (px)
          <input
            aria-label="Brush size"
            type="number"
            min="1"
            max="256"
            value={diameter}
            onChange={(e) => setDiameter(e.target.valueAsNumber)}
          />
        </label>
        <label>
          Hardness (%)
          <input
            aria-label="Brush hardness"
            type="number"
            min="0"
            max="100"
            value={hardness * 100}
            onChange={(e) => setHardness(e.target.valueAsNumber / 100)}
          />
        </label>
        <label>
          {p.mode === "liquify" ? "Strength (%)" : "Opacity (%)"}
          <input
            aria-label="Brush strength"
            type="number"
            min="1"
            max="100"
            value={opacity * 100}
            onChange={(e) => setOpacity(e.target.valueAsNumber / 100)}
          />
        </label>
        {p.mode === "draw" && (
          <label>
            Colour
            <input
              aria-label="Brush colour"
              type="color"
              value={colour}
              onChange={(e) => setColour(e.target.value)}
            />
          </label>
        )}
      </fieldset>
      {!enabled && (
        <p className="hint">
          Show and unlock one image and its parent groups to use this tool.
        </p>
      )}
      {p.busy && (
        <>
          <p role="status" aria-label="Brush progress">
            Applying brush…
          </p>
          <button onClick={cancel}>Cancel brush operation</button>
        </>
      )}
    </section>
  );
}
