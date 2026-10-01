import React, { useEffect, useRef, useState } from "react";
import type { PhotoDocument, Matrix } from "../editor/model/document";
import type {
  MaskBitmap,
  MaskEdit,
  MaskSelection,
  PixelPoint,
} from "../editor/model/mask";
import { inverse, isLocked, locate, multiply } from "../editor/commands/layers";
import type { Workspace, PointerTool } from "../editor/render/adapter";
type Tool =
  | "rectangle"
  | "ellipse"
  | "freehand"
  | "polygon"
  | "wand"
  | "remove-brush"
  | "restore-brush";
type Props = {
  doc: PhotoDocument;
  selected: string[];
  workspace: Workspace;
  busy: boolean;
  run(action: () => Promise<void>): Promise<void>;
  flush(): Promise<void>;
  apply(id: string, bitmap: MaskBitmap): Promise<void>;
  trim(): Promise<void>;
  backdrop: string;
  setBackdrop(value: "checker" | "white" | "black"): void;
};
const mapPoint = (m: Matrix, p: PixelPoint): PixelPoint => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
});
export function CutoutControls(p: Props) {
  const [tool, setTool] = useState<Tool>("rectangle"),
    [diameter, setDiameter] = useState(32),
    [tolerance, setTolerance] = useState(24),
    [contiguous, setContiguous] = useState(true),
    [feather, setFeather] = useState(0),
    [inverted, setInverted] = useState(false),
    [hasSelection, setHasSelection] = useState(false),
    [drawing, setDrawing] = useState(false),
    [working, setWorking] = useState(false);
  const selection = useRef<MaskBitmap | undefined>(undefined),
    bitmap = useRef<HTMLCanvasElement | undefined>(undefined),
    points = useRef<PixelPoint[]>([]),
    dragging = useRef(false),
    epoch = useRef(0);
  const found =
    p.selected.length === 1 ? locate(p.doc, p.selected[0]) : undefined;
  const layer = found?.layer.kind === "raster" ? found.layer : undefined;
  const enabled =
    !!layer &&
    !isLocked(p.doc, layer.id) &&
    !!layer.visible &&
    !found?.ancestors.some((a) => !a.visible);
  const matrix = found
    ? multiply(found.parentMatrix, found.layer.transform)
    : ([1, 0, 0, 1, 0, 0] as Matrix);
  const latest = useRef({
    p,
    tool,
    diameter,
    tolerance,
    contiguous,
    feather,
    inverted,
    layer,
    enabled,
    matrix,
  });
  latest.current = {
    p,
    tool,
    diameter,
    tolerance,
    contiguous,
    feather,
    inverted,
    layer,
    enabled,
    matrix,
  };
  function clear() {
    selection.current = undefined;
    bitmap.current = undefined;
    points.current = [];
    dragging.current = false;
    setHasSelection(false);
    setInverted(false);
    setDrawing(false);
    p.workspace.drawOverlay();
  }
  async function tint(mask: MaskBitmap, invert: boolean) {
    const image = await createImageBitmap(
      new Blob([new Uint8Array(mask.bytes)], { type: "image/png" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = mask.width;
    canvas.height = mask.height;
    const ctx = canvas.getContext("2d")!;
    if (invert) {
      ctx.fillStyle = "#B93D39";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(image, 0, 0);
    } else {
      ctx.drawImage(image, 0, 0);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = "#B93D39";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    image.close();
    return canvas;
  }
  async function operate(action: (token: number) => Promise<void>) {
    const token = ++epoch.current;
    setWorking(true);
    await latest.current.p.run(async () => {
      try {
        await latest.current.p.flush();
        if (token !== epoch.current) throw Error("Mask operation cancelled");
        await action(token);
      } finally {
        setWorking(false);
      }
    });
  }
  async function select(
    input: MaskSelection,
    brushAction?: "remove" | "restore",
  ) {
    const { layer, p, feather } = latest.current;
    if (!layer) return;
    await operate(async (token) => {
      const selected = await window.photo.createSelection(layer.id, input);
      if (token !== epoch.current) throw Error("Mask operation cancelled");
      if (brushAction) {
        const result = await window.photo.editMask(layer.id, {
          action: brushAction,
          selection: selected.hash,
          feather,
        });
        if (token !== epoch.current) throw Error("Mask operation cancelled");
        await p.apply(layer.id, result);
        clear();
      } else {
        const view = await tint(selected, false);
        if (token !== epoch.current) throw Error("Mask operation cancelled");
        selection.current = selected;
        bitmap.current = view;
        setHasSelection(true);
        setInverted(false);
        p.workspace.drawOverlay();
      }
    });
  }
  async function edit(action: MaskEdit["action"]) {
    if (!layer) return;
    await operate(async (token) => {
      const result = await window.photo.editMask(layer.id, {
        action,
        selection: selection.current?.hash,
        inverted,
        feather,
      });
      if (token !== epoch.current) throw Error("Mask operation cancelled");
      await p.apply(layer.id, result);
      clear();
    });
  }
  function finishPolygon() {
    if (latest.current.p.busy || points.current.length < 3) return;
    const shape = points.current.slice();
    points.current = [];
    dragging.current = false;
    setDrawing(false);
    void select({ kind: "polygon", points: shape });
  }
  const controller = useRef<PointerTool | undefined>(undefined);
  if (!controller.current)
    controller.current = {
      down(world) {
        const c = latest.current;
        if (!c.enabled || c.p.busy) return;
        const point = mapPoint(inverse(c.matrix), world);
        if (c.tool === "rectangle" || c.tool === "ellipse") {
          point.x = Math.round(point.x);
          point.y = Math.round(point.y);
        }
        if (c.tool === "wand") {
          clear();
          void select({
            kind: "wand",
            point,
            tolerance: c.tolerance,
            contiguous: c.contiguous,
          });
          return;
        }
        if (c.tool === "polygon") {
          if (points.current.length >= 4096) return;
          if (!points.current.length) clear();
          points.current.push(point);
          setDrawing(true);
          c.p.workspace.drawOverlay();
          return;
        }
        clear();
        points.current = [point];
        dragging.current = true;
        setDrawing(true);
        c.p.workspace.drawOverlay();
      },
      move(world) {
        const c = latest.current;
        if (!dragging.current || c.p.busy) return;
        const point = mapPoint(inverse(c.matrix), world),
          previous = points.current.at(-1)!;
        if (c.tool === "rectangle" || c.tool === "ellipse") {
          point.x = Math.round(point.x);
          point.y = Math.round(point.y);
        }
        if (c.tool === "rectangle" || c.tool === "ellipse")
          points.current = [points.current[0], point];
        else if (
          points.current.length < 4096 &&
          Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.5
        )
          points.current.push(point);
        c.p.workspace.drawOverlay();
      },
      up(world) {
        const c = latest.current;
        if (!dragging.current || c.p.busy) return;
        controller.current!.move(world);
        dragging.current = false;
        setDrawing(false);
        const path = points.current.slice();
        points.current = [];
        const input: MaskSelection | undefined =
          c.tool === "rectangle" || c.tool === "ellipse"
            ? { kind: c.tool, start: path[0], end: path.at(-1)! }
            : c.tool === "freehand"
              ? path.length >= 3
                ? { kind: "polygon", points: path }
                : undefined
              : { kind: "brush", points: path, diameter: c.diameter };
        if (input)
          queueMicrotask(
            () =>
              void select(
                input,
                c.tool === "remove-brush"
                  ? "remove"
                  : c.tool === "restore-brush"
                    ? "restore"
                    : undefined,
              ),
          );
        c.p.workspace.drawOverlay();
      },
      finish() {
        if (latest.current.tool === "polygon") finishPolygon();
      },
      draw(ctx) {
        const c = latest.current,
          w = c.p.workspace;
        if (!c.enabled) return;
        ctx.save();
        ctx.translate(w.offset.x, w.offset.y);
        ctx.scale(w.zoom, w.zoom);
        ctx.transform(...c.matrix);
        if (bitmap.current) {
          ctx.globalAlpha = 0.35;
          ctx.drawImage(bitmap.current, 0, 0);
          ctx.globalAlpha = 1;
        }
        const path = points.current;
        if (path.length) {
          ctx.strokeStyle = "#b93d39";
          ctx.fillStyle = "#b93d3940";
          ctx.lineWidth =
            1.5 /
            (w.zoom * Math.max(0.01, Math.hypot(c.matrix[0], c.matrix[1])));
          ctx.beginPath();
          const first = path[0],
            end = path.at(-1)!;
          if (c.tool === "rectangle")
            ctx.rect(first.x, first.y, end.x - first.x, end.y - first.y);
          else if (c.tool === "ellipse")
            ctx.ellipse(
              (first.x + end.x) / 2,
              (first.y + end.y) / 2,
              Math.abs(end.x - first.x) / 2,
              Math.abs(end.y - first.y) / 2,
              0,
              0,
              Math.PI * 2,
            );
          else {
            ctx.moveTo(first.x, first.y);
            for (const point of path.slice(1)) ctx.lineTo(point.x, point.y);
          }
          if (c.tool.endsWith("brush")) {
            ctx.lineWidth = c.diameter;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.globalAlpha = 0.4;
            if (path.length === 1) {
              ctx.arc(first.x, first.y, c.diameter / 2, 0, Math.PI * 2);
              ctx.fill();
            }
          }
          ctx.stroke();
        }
        ctx.restore();
      },
    };
  useEffect(() => {
    p.workspace.setPointerTool(controller.current);
    const key = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement).matches("input,textarea,select") ||
        latest.current.p.busy
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        clear();
      }
      if (event.key === "Enter" && latest.current.tool === "polygon") {
        event.preventDefault();
        finishPolygon();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      epoch.current++;
      p.workspace.setPointerTool();
      window.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    clear();
  }, [p.doc.id, layer?.id, layer?.asset, layer?.mask]);
  useEffect(() => {
    p.workspace.drawOverlay();
  }, [p.doc, inverted]);
  const disabled = !enabled || p.busy;
  return (
    <section className="cutout-controls" aria-label="Cutout controls">
      <p className="mask-target">
        {layer ? `Mask · ${layer.name}` : "Select one image layer in Layers"}
      </p>
      {!enabled && layer && (
        <p className="hint">
          Show and unlock the image and its parent groups to edit its mask.
        </p>
      )}
      <label>
        Selection tool
        <select
          aria-label="Cutout tool"
          value={tool}
          disabled={p.busy}
          onChange={(e) => {
            clear();
            setTool(e.target.value as Tool);
          }}
        >
          <option value="rectangle">Rectangle</option>
          <option value="ellipse">Ellipse</option>
          <option value="freehand">Freehand</option>
          <option value="polygon">Polygon</option>
          <option value="wand">Colour wand</option>
          <option value="remove-brush">Remove brush</option>
          <option value="restore-brush">Restore brush</option>
        </select>
      </label>
      <p className="hint">
        {tool === "polygon"
          ? "Click vertices, then Finish polygon or Enter. Escape clears."
          : tool === "wand"
            ? "Click a colour in the original working image. The tint shows selected pixels."
            : tool.endsWith("brush")
              ? "Paint on the image. Each stroke is one undo step. Restore keeps the source's original alpha."
              : "Drag on the image to select. The tint is an overlay and never exports."}
      </p>
      {tool === "polygon" && (
        <button disabled={disabled || !drawing} onClick={finishPolygon}>
          Finish polygon
        </button>
      )}
      {tool.endsWith("brush") && (
        <label>
          Brush diameter (image px)
          <input
            aria-label="Brush diameter"
            type="number"
            min="1"
            max="1000"
            value={diameter}
            disabled={p.busy}
            onChange={(e) =>
              setDiameter(
                Math.max(1, Math.min(1000, e.target.valueAsNumber || 1)),
              )
            }
          />
        </label>
      )}
      {tool === "wand" && (
        <>
          <label>
            Tolerance · 0–255
            <input
              aria-label="Wand tolerance"
              type="number"
              min="0"
              max="255"
              value={tolerance}
              disabled={p.busy}
              onChange={(e) =>
                setTolerance(
                  Math.round(
                    Math.max(0, Math.min(255, e.target.valueAsNumber || 0)),
                  ),
                )
              }
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={contiguous}
              disabled={p.busy}
              onChange={(e) => setContiguous(e.target.checked)}
            />
            Contiguous pixels only
          </label>
        </>
      )}
      <label>
        Feather (image px)
        <input
          aria-label="Mask feather"
          type="number"
          min="0"
          max="100"
          value={feather}
          disabled={p.busy}
          onChange={(e) =>
            setFeather(Math.max(0, Math.min(100, e.target.valueAsNumber || 0)))
          }
        />
      </label>
      <output aria-label="Selection status">
        {hasSelection
          ? inverted
            ? "Outside selection"
            : "Selection ready"
          : drawing
            ? "Drawing selection"
            : "No selection"}
      </output>
      <div className="button-grid">
        <button
          disabled={disabled || !hasSelection}
          onClick={() => void edit("keep")}
        >
          Keep selected
        </button>
        <button
          disabled={disabled || !hasSelection}
          onClick={() => void edit("remove")}
        >
          Remove selected
        </button>
        <button
          disabled={disabled || !hasSelection}
          onClick={() => void edit("restore")}
        >
          Restore selected
        </button>
        <button
          disabled={disabled || !hasSelection}
          onClick={() => {
            const value = !inverted,
              mask = selection.current!;
            setInverted(value);
            void tint(mask, value).then((view) => {
              if (selection.current === mask) {
                bitmap.current = view;
                p.workspace.drawOverlay();
              }
            });
          }}
        >
          Invert selection
        </button>
        <button
          disabled={p.busy || (!hasSelection && !drawing)}
          onClick={clear}
        >
          Clear selection
        </button>
        <button
          disabled={disabled || !layer?.mask || feather === 0}
          onClick={() => void edit("feather")}
        >
          Feather mask
        </button>
        <button disabled={disabled} onClick={() => void edit("invert")}>
          Invert mask
        </button>
        <button
          disabled={disabled || !layer?.mask}
          onClick={() => void edit("reset")}
        >
          Restore entire image
        </button>
      </div>
      {working && (
        <button
          className="primary"
          onClick={() => {
            epoch.current++;
            window.photo.cancelMaskJob();
          }}
        >
          Cancel mask operation
        </button>
      )}
      <label>
        Transparency view
        <select
          aria-label="Transparency view"
          value={p.backdrop}
          onChange={(e) =>
            p.setBackdrop(e.target.value as "checker" | "white" | "black")
          }
        >
          <option value="checker">Checker</option>
          <option value="white">White</option>
          <option value="black">Black</option>
        </select>
      </label>
      <button disabled={p.busy} onClick={() => void p.trim()}>
        Trim transparent edges
      </button>
      <p className="hint">
        Trim uses the visible composition, keeps every nonzero alpha pixel, and
        can be undone. Masks never alter original image bytes.
      </p>
    </section>
  );
}
