import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Workspace, composite } from "../editor/render/adapter";
import type {
  Bridge,
  PhotoDocument,
  ImportResult,
  RecentProject,
  CheckpointInfo,
  ExportOptions,
} from "../editor/model/document";
import {
  crop,
  canvasSize,
  resize,
  rotate,
  flip,
} from "../editor/commands/geometry";
import { useProject } from "./use-project";
import { LayerControls } from "./layer-controls";
import { GuideControls } from "./guide-controls";
import { CutoutControls } from "./cutout-controls";
import { TextControls } from "./text-controls";
import { AdjustmentControls } from "./adjustment-controls";
import { ShelfControls } from "./shelf-controls";
import { VersionPreview } from "./version-preview";
import { PrintControls } from "./print-controls";
import { printSvg } from "../editor/render/print";
import { FilterControls } from "./filter-controls";
import type { PhotoFilter } from "../editor/model/filters";
import { StrokeControls } from "./stroke-controls";
import {
  adjustmentSchema,
  type Adjustments,
} from "../editor/model/adjustments";
import { textStyleSchema } from "../editor/model/text";
import { validateTypography } from "../editor/render/text";
import type { MaskBitmap } from "../editor/model/mask";
import { flattenLayers } from "../editor/model/document";
import {
  locate,
  isLocked,
  patchLayer,
  translateWorld,
  selectionRoots,
} from "../editor/commands/layers";
import "./style.css";
declare global {
  interface Window {
    photo: Bridge;
  }
}
function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
}
function App() {
  const project = useProject();
  const { doc, current, assets } = project;
  const [selected, setSelected] = useState<string[]>([]);
  const selectedRef = useRef<string[]>([]);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(
      "Open a photo or continue a saved project",
    );
  const [grid, setGrid] = useState(false),
    [zoom, setZoom] = useState(1),
    [settings, setSettings] = useState(true),
    [layers, setLayers] = useState(true);
  const [recent, setRecent] = useState<RecentProject[]>([]),
    [showRecent, setShowRecent] = useState(false),
    [showVersions, setShowVersions] = useState(false),
    [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]),
    [checkpointName, setCheckpointName] = useState("");
  const [tool, setTool] = useState<
    | "arrange"
    | "size"
    | "cutout"
    | "text"
    | "adjust"
    | "shelf"
    | "print"
    | "filters"
    | "retouch"
    | "draw"
    | "liquify"
  >("arrange");
  const [textEditing, setTextEditing] = useState(false);
  const [panelTextDraft, setPanelTextDraft] = useState(false);
  const [backdrop, setBackdrop] = useState<"checker" | "white" | "black">(
    "checker",
  );
  const [sizeMode, setSizeMode] = useState<"crop" | "resize" | "canvas">(
      "crop",
    ),
    [sizeW, setSizeW] = useState(1920),
    [sizeH, setSizeH] = useState(1200),
    [cropX, setCropX] = useState(0),
    [cropY, setCropY] = useState(0),
    [anchor, setAnchor] = useState(4),
    [fitMode, setFitMode] = useState<"stretch" | "fit" | "fill">("fit"),
    [aspect, setAspect] = useState(true);
  const [preview, setPreview] = useState<PhotoDocument>();
  const [previewKind, setPreviewKind] = useState<"size" | "adjust" | "filter">(
    "size",
  );
  const [versionPage, setVersionPage] = useState(0);
  const previewRef = useRef<PhotoDocument | undefined>(undefined);
  const [format, setFormat] = useState<ExportOptions["format"]>("png"),
    [quality, setQuality] = useState(92),
    [matte, setMatte] = useState("#ffffff");
  const workspace = useRef<Workspace | undefined>(undefined),
    host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    overlay = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const busyRef = useRef(false);
  const activeOperation = useRef<Promise<void> | undefined>(undefined);
  busyRef.current = busy;
  const actions = useRef({
    flush: project.flush,
    undo: () => {},
    redo: () => {},
    cancelPreview: () => {},
    nudge: (_axis: 4 | 5, _amount: number) => {},
  });
  actions.current.flush = project.flush;
  function run(action: () => Promise<void>) {
    setBusy(true);
    window.photo.operationActive(true);
    const task = (async () => {
      try {
        await action();
      } catch (e) {
        setMessage(errorMessage(e));
        throw e;
      } finally {
        window.photo.operationActive(false);
        setBusy(false);
      }
    })();
    activeOperation.current = task;
    // Callers show errors through the status message; close must also observe
    // rejection so a failed pending commit cannot be mistaken for a saved draft.
    return task.catch(() => {});
  }
  async function display(result: ImportResult) {
    project.adopt(result);
    selectedRef.current = result.document.layers[0]
      ? [result.document.layers[0].id]
      : [];
    setSelected(selectedRef.current);
    workspace.current!.selectedIds = selectedRef.current;
    await workspace.current!.load(result.document, result.assets);
    setSizeW(result.document.width);
    setSizeH(result.document.height);
    setCropX(0);
    setCropY(0);
    setShowRecent(false);
    setShowVersions(false);
    setRecent(await window.photo.recent());
  }
  async function open() {
    await run(async () => {
      await project.flush();
      const result = await window.photo.openImage();
      if (result) {
        await display(result);
        setMessage("Photo opened. Original preserved.");
      } else setMessage("Open cancelled");
    });
  }
  async function paste() {
    await run(async () => {
      await project.flush();
      const result = await window.photo.pasteImage();
      if (result) {
        await display(result);
        setMessage("Pasted image saved locally");
      } else setMessage("The clipboard has no image");
    });
  }
  async function importFile(file: File) {
    await run(async () => {
      await project.flush();
      if (file.size > 128 * 1024 * 1024)
        throw Error("File exceeds 128 MB limit");
      await display(
        await window.photo.importBytes(
          new Uint8Array(await file.arrayBuffer()),
          file.name,
        ),
      );
      setMessage("Dropped photo saved locally");
    });
  }
  async function exportImage() {
    await run(async () => {
      if (!current.current) return;
      if (!Number.isInteger(quality) || quality < 1 || quality > 100)
        throw Error("Choose an export quality from 1 to 100.");
      await project.flush();
      const d = current.current;
      setMessage("Rendering " + format.toUpperCase() + "…");
      const bytes = await composite(d, assets.current);
      setMessage(
        (await window.photo.exportImage(bytes, d.width, d.height, {
          format,
          quality,
          matte,
          dpi: d.dpi ?? 300,
        }))
          ? format.toUpperCase() + " exported successfully"
          : "Export cancelled",
      );
    });
  }
  async function redraw(d: PhotoDocument) {
    const ids = new Set(flattenLayers(d.layers).map((l) => l.id));
    const valid = selectedRef.current.filter((id) => ids.has(id));
    if (valid.length !== selectedRef.current.length) {
      selectedRef.current = valid.length
        ? valid
        : d.layers[0]
          ? [d.layers[0].id]
          : [];
      setSelected([...selectedRef.current]);
      workspace.current!.selectedIds = selectedRef.current;
    }
    await workspace.current!.load(d, assets.current, false);
  }
  function chooseLayer(id: string, add = false) {
    const ids = add
      ? selectedRef.current.includes(id)
        ? selectedRef.current.filter((value) => value !== id)
        : [...selectedRef.current, id]
      : [id];
    selectedRef.current = ids;
    setSelected(ids);
    workspace.current?.select(ids);
  }
  async function applyLayerChange(next: PhotoDocument) {
    await validateTypography(next, assets.current);
    const oldIds = new Set(
      flattenLayers(current.current?.layers ?? []).map((l) => l.id),
    );
    const newIds = flattenLayers(next.layers)
      .map((l) => l.id)
      .filter((id) => !oldIds.has(id));
    project.commit(next);
    const ids = flattenLayers(next.layers).map((l) => l.id);
    selectedRef.current = selectedRef.current.filter((id) => ids.includes(id));
    if (newIds.length) selectedRef.current = selectionRoots(next, newIds);
    if (!selectedRef.current.length && next.layers.length)
      selectedRef.current = [next.layers.at(-1)!.id];
    setSelected([...selectedRef.current]);
    workspace.current!.selectedIds = selectedRef.current;
    await redraw(next);
  }
  async function importFont() {
    await run(async () => {
      await project.flush();
      const id = selectedRef.current[0];
      const result = await window.photo.importFont();
      if (!result) return;
      assets.current[result.font.fontAsset!] = result.bytes;
      await applyLayerChange(
        patchLayer(current.current!, id, {
          ...result.font,
          fontPostscript: undefined,
        }),
      );
      setMessage("Font imported and saved with the project");
    });
  }
  async function applyMask(id: string, bitmap: MaskBitmap) {
    assets.current[bitmap.hash] = bitmap.bytes;
    await applyLayerChange(
      patchLayer(current.current!, id, { mask: bitmap.hash }),
    );
    setMessage("Mask updated. Original image preserved.");
  }
  async function trimTransparency() {
    await run(async () => {
      await project.flush();
      const d = current.current!;
      const bounds = await window.photo.trimBounds(
        await composite(d, assets.current),
      );
      if (!bounds) {
        setMessage("The composition is fully transparent. Nothing to trim.");
        return;
      }
      if (
        bounds.x === 0 &&
        bounds.y === 0 &&
        bounds.width === d.width &&
        bounds.height === d.height
      ) {
        setMessage("No transparent outer edges to trim.");
        return;
      }
      await changeGeometry(
        crop(d, bounds.x, bounds.y, bounds.width, bounds.height),
      );
      setMessage(
        `Trimmed to ${bounds.width} × ${bounds.height}. Undo restores the canvas.`,
      );
    });
  }
  function layerChange(operation: (d: PhotoDocument) => PhotoDocument) {
    void run(async () => {
      if (current.current) await applyLayerChange(operation(current.current));
    });
  }
  async function addImage() {
    await run(async () => {
      await project.flush();
      const result = await window.photo.addImage();
      if (!result) return;
      assets.current = result.assets;
      await applyLayerChange(result.document);
      chooseLayer(result.document.layers.at(-1)!.id);
      setMessage("Image layer added; original preserved");
    });
  }
  function addText() {
    layerChange((d) => ({
      ...d,
      schemaVersion: 2,
      layers: [
        ...d.layers,
        {
          kind: "text",
          id: crypto.randomUUID(),
          name: "Text",
          text: "Your text",
          fontFamily: "Arial",
          fontSize: 48,
          fill: "#24262a",
          visible: true,
          opacity: 1,
          transform: [1, 0, 0, 1, 40, 40],
        },
      ],
    }));
  }
  function position(axis: 4 | 5, value: number) {
    const d = current.current,
      l = d && locate(d, selectedRef.current[0])?.layer;
    if (
      !d ||
      !l ||
      selectedRef.current.length !== 1 ||
      isLocked(d, l.id) ||
      !Number.isFinite(value) ||
      Math.abs(value) > 100000
    )
      return;
    const transform = [...l.transform] as typeof l.transform;
    transform[axis] = value;
    layerChange((next) => patchLayer(next, l.id, { transform }));
  }
  async function changeGeometry(next: PhotoDocument) {
    project.commit(next);
    await redraw(next);
    setSizeW(next.width);
    setSizeH(next.height);
  }
  function history(direction: "undo" | "redo") {
    void run(async () => {
      const next = project[direction]();
      if (next) {
        await redraw(next);
        setSizeW(next.width);
        setSizeH(next.height);
        setMessage(direction === "undo" ? "Undone" : "Redone");
      }
    });
  }
  actions.current.undo = () => history("undo");
  actions.current.redo = () => history("redo");
  actions.current.nudge = (axis, amount) => {
    layerChange((d) =>
      translateWorld(
        d,
        selectedRef.current,
        axis === 4 ? amount : 0,
        axis === 5 ? amount : 0,
      ),
    );
  };
  async function cancelPreview() {
    window.photo.previewActive(false);
    previewRef.current = undefined;
    setPreview(undefined);
    if (current.current) await redraw(current.current);
  }
  actions.current.cancelPreview = () => {
    void cancelPreview();
  };
  async function sizePreview() {
    await run(async () => {
      const d = current.current;
      if (!d) return;
      if (
        !Number.isInteger(sizeW) ||
        !Number.isInteger(sizeH) ||
        sizeW < 1 ||
        sizeH < 1 ||
        sizeW > 12000 ||
        sizeH > 12000 ||
        sizeW * sizeH > 24000000
      )
        throw Error(
          "Choose whole-pixel dimensions up to 12,000 per side and 24 megapixels total.",
        );
      const next =
        sizeMode === "crop"
          ? crop(d, cropX, cropY, sizeW, sizeH)
          : sizeMode === "canvas"
            ? canvasSize(d, sizeW, sizeH, anchor)
            : resize(d, sizeW, sizeH, fitMode);
      setPreviewKind("size");
      previewRef.current = next;
      window.photo.previewActive(true);
      setPreview(next);
      await redraw(next);
      setMessage("Preview only. Apply or cancel to continue.");
    });
  }
  async function applyPreview() {
    if (!previewRef.current) return;
    const next = previewRef.current;
    window.photo.previewActive(false);
    previewRef.current = undefined;
    setPreview(undefined);
    project.commit(next);
    await redraw(next);
    setMessage(
      previewKind === "adjust"
        ? "Adjustments applied; original preserved"
        : previewKind === "filter"
          ? "Filter applied; original preserved"
          : "Size change applied",
    );
  }
  async function adjustmentPreview(settings: Adjustments) {
    await run(async () => {
      const parsed = adjustmentSchema.parse(settings);
      await project.flush();
      const d = current.current!,
        id = selectedRef.current[0];
      const result = await window.photo.adjustImage(id, parsed);
      assets.current[result.hash] = result.bytes;
      const next = patchLayer(d, id, { asset: result.hash });
      setPreviewKind("adjust");
      previewRef.current = next;
      setPreview(next);
      window.photo.previewActive(true);
      await redraw(next);
      setMessage(
        "Adjustment preview. Show before/after, then apply or cancel.",
      );
    });
  }
  async function filterPreview(settings: PhotoFilter) {
    await run(async () => {
      await project.flush();
      const d = current.current!,
        id = selectedRef.current[0];
      const result = await window.photo.filterImage(id, settings);
      assets.current[result.hash] = result.bytes;
      const next = patchLayer(d, id, { asset: result.hash });
      setPreviewKind("filter");
      previewRef.current = next;
      setPreview(next);
      window.photo.previewActive(true);
      await redraw(next);
      setMessage("Filter preview. Show before/after, then apply or cancel.");
    });
  }
  async function applyStroke(
    id: string,
    result: Awaited<ReturnType<Bridge["strokeImage"]>>,
  ) {
    assets.current[result.hash] = result.bytes;
    if (result.maskHash && result.mask)
      assets.current[result.maskHash] = result.mask;
    await applyLayerChange(
      patchLayer(current.current!, id, {
        asset: result.hash,
        ...(result.maskHash ? { mask: result.maskHash } : {}),
      }),
    );
    setMessage("Brush applied; original preserved. Undo restores the stroke.");
  }
  function newPaintLayer() {
    void run(async () => {
      await project.flush();
      const result = await window.photo.newPaintLayer();
      assets.current[result.hash] = result.bytes;
      const id = crypto.randomUUID(),
        d = current.current!;
      await applyLayerChange({
        ...d,
        schemaVersion: 2,
        layers: [
          ...d.layers,
          {
            kind: "raster",
            id,
            name: "Paint",
            visible: true,
            opacity: 1,
            transform: [1, 0, 0, 1, 0, 0],
            original: result.hash,
            asset: result.hash,
          },
        ],
      });
      chooseLayer(id);
      setMessage("Transparent paint layer added");
    });
  }
  async function insertShelf(result: ImportResult) {
    Object.assign(assets.current, result.assets);
    const item = result.document.layers[0],
      d = current.current!;
    if (item.kind === "text") {
      const target = locate(d, selectedRef.current[0])?.layer;
      if (!target || target.kind !== "text")
        throw Error("Select a text layer to apply this saved style.");
      const cleared = Object.fromEntries(
        Object.keys(textStyleSchema.shape).map((k) => [k, undefined]),
      );
      await applyLayerChange(
        patchLayer(d, target.id, {
          ...cleared,
          ...textStyleSchema.parse(item),
        }),
      );
    } else {
      const layer = { ...item, id: crypto.randomUUID() };
      await applyLayerChange({
        ...d,
        schemaVersion: 2,
        layers: [...d.layers, layer],
      });
      chooseLayer(layer.id);
    }
    setMessage("Shelf item applied");
  }
  async function checkpoint() {
    await run(async () => {
      await project.flush();
      await window.photo.checkpoint(checkpointName);
      setCheckpointName("");
      setCheckpoints(await window.photo.checkpoints());
      setMessage("Checkpoint saved");
    });
  }
  useEffect(() => {
    const w = new Workspace(canvas.current!, overlay.current!, (id, x, y) => {
      const d = current.current;
      if (!d) return;
      const found = locate(d, id);
      if (!found) return;
      const dx = x - found.layer.transform[4],
        dy = y - found.layer.transform[5];
      void run(async () => {
        try {
          await applyLayerChange(
            translateWorld(
              d,
              selectedRef.current.includes(id) ? selectedRef.current : [id],
              found.parentMatrix[0] * dx + found.parentMatrix[2] * dy,
              found.parentMatrix[1] * dx + found.parentMatrix[3] * dy,
            ),
          );
          setMessage("Placement updated");
        } catch (error) {
          await redraw(d);
          throw error;
        }
      });
    });
    workspace.current = w;
    w.onTextEditing = (value) => {
      setTextEditing(value);
      window.photo.textEditingActive(value);
    };
    w.onTextCommit = async (id, text) => {
      await run(async () => {
        const d = current.current;
        if (!d) return;
        try {
          await applyLayerChange(patchLayer(d, id, { text }));
          setMessage("Text updated");
        } catch (error) {
          await redraw(d);
          throw error;
        }
      });
    };
    w.onSelect = (id, add) => {
      if (!add && selectedRef.current.includes(id)) return;
      chooseLayer(id, add);
    };
    w.onView = () => {
      setZoom(w.zoom);
      setView({ x: w.offset.x, y: w.offset.y, z: w.zoom });
    };
    const observer = new ResizeObserver(([e]) =>
      w.resize(e.contentRect.width, e.contentRect.height),
    );
    observer.observe(host.current!);
    const key = (e: KeyboardEvent) => {
      if (busyRef.current) return;
      if (w.isTextEditing && e.type === "keydown") {
        if (
          e.key === "Escape" ||
          (e.ctrlKey && (e.key === "Enter" || e.key.toLowerCase() === "s"))
        ) {
          e.preventDefault();
          e.stopPropagation();
          void w
            .finishTextEditing(e.key === "Escape")
            .then(() =>
              e.key.toLowerCase() === "s" ? actions.current.flush() : undefined,
            )
            .catch((error) => setMessage(errorMessage(error)));
        }
        return;
      }
      if (
        !previewRef.current &&
        e.type === "keydown" &&
        e.ctrlKey &&
        e.key.toLowerCase() === "s"
      ) {
        e.preventDefault();
        if ((e.target as HTMLElement).matches("input,textarea,select"))
          (e.target as HTMLElement).blur();
        void Promise.resolve(activeOperation.current)
          .then(() => actions.current.flush())
          .catch((error) => setMessage(errorMessage(error)));
        return;
      }
      if ((e.target as HTMLElement).matches("input,textarea,select")) return;
      if (e.key === "Escape" && previewRef.current) {
        actions.current.cancelPreview();
        return;
      }
      if (previewRef.current) return;
      if (
        e.type === "keydown" &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
      ) {
        if (w.pointerTool) return;
        e.preventDefault();
        const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
        const sign = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
        actions.current.nudge(horizontal ? 4 : 5, sign * (e.shiftKey ? 10 : 1));
        return;
      }
      if (e.type === "keydown" && e.ctrlKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? actions.current.redo() : actions.current.undo();
        return;
      }
      if (e.type === "keydown" && e.ctrlKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        actions.current.redo();
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        w.space = e.type === "keydown";
        w.canvas.skipTargetFind = w.space || !!w.pointerTool;
        w.canvas.defaultCursor = w.space ? "grab" : "default";
      }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key);
    const blur = () => {
      w.space = false;
      w.canvas.skipTargetFind = !!w.pointerTool;
    };
    window.addEventListener("blur", blur);
    const off = window.photo.onClose(() => {
      if (!w.isTextEditing && document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
      void w
        .finishTextEditing()
        .then(() => activeOperation.current)
        .then(() => actions.current.flush())
        .then(() => window.photo.closeReady())
        .catch((e) => setMessage("Close paused: " + errorMessage(e)));
    });
    void window.photo
      .recent()
      .then(setRecent)
      .catch((e) => setMessage(errorMessage(e)));
    return () => {
      off();
      observer.disconnect();
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", blur);
      void w.dispose();
    };
  }, []);
  const layer =
    doc && selected.length === 1 ? locate(doc, selected[0])?.layer : undefined;
  const shown = preview ?? doc;
  const blocked = busy || !!preview || textEditing;
  return (
    <main
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (!blocked && e.dataTransfer.files[0])
          void importFile(e.dataTransfer.files[0]);
      }}
      onPaste={(e) => {
        if (!blocked && !(e.target as HTMLElement).matches("input,textarea")) {
          e.preventDefault();
          void paste();
        }
      }}
    >
      <header>
        <div className="app-name">
          <span className="app-mark">▧</span>
          <strong>Stillwell</strong>
        </div>
        <div className="project-title">
          {doc?.name ?? "Untitled workspace"}
          <span
            className={"save-state " + (project.saveError ? "error" : "")}
            role="status"
            aria-label="Save status"
          >
            {doc
              ? textEditing || panelTextDraft
                ? "Editing text…"
                : project.saveState
              : "Local project library"}
          </span>
        </div>
        <button
          disabled={blocked}
          onClick={() => {
            void run(async () => {
              await project.flush();
              setRecent(await window.photo.recent());
              setShowRecent(true);
            });
          }}
        >
          Projects
        </button>
        <button
          aria-label="Undo"
          disabled={blocked || !project.canUndo}
          onClick={() => history("undo")}
        >
          ↶
        </button>
        <button
          aria-label="Redo"
          disabled={blocked || !project.canRedo}
          onClick={() => history("redo")}
        >
          ↷
        </button>
        <button
          disabled={blocked || !doc}
          onClick={() => {
            void run(async () => {
              await project.flush();
              setCheckpoints(await window.photo.checkpoints());
              setVersionPage(0);
              setShowVersions(true);
            });
          }}
        >
          Versions
        </button>
        <button onClick={open} disabled={blocked}>
          Open photo
        </button>
        <button
          className="primary"
          onClick={exportImage}
          disabled={!doc || blocked}
        >
          Export {format.toUpperCase()} <span>↗</span>
        </button>
      </header>
      <div className="work-area">
        <nav aria-label="Workspace panels">
          <button
            className={tool === "arrange" ? "active" : ""}
            aria-label="Toggle arrange settings"
            title="Arrange settings"
            disabled={blocked}
            onClick={() => {
              setSettings(true);
              setTool("arrange");
            }}
          >
            ↖
          </button>
          <button
            aria-label="Crop and size"
            title="Crop and size"
            disabled={!doc || blocked}
            className={tool === "size" ? "active" : ""}
            onClick={() => {
              setTool("size");
              setSettings(true);
              setSizeW(doc!.width);
              setSizeH(doc!.height);
            }}
          >
            ⌗
          </button>
          <button
            aria-label="Cutout"
            title="Cutout and transparency"
            disabled={!doc || blocked}
            className={tool === "cutout" ? "active" : ""}
            onClick={() => {
              setTool("cutout");
              setSettings(true);
            }}
          >
            ✂
          </button>
          <button
            className={grid ? "active" : ""}
            aria-label="Toggle grid"
            title="Document grid"
            onClick={() => {
              setGrid(!grid);
              workspace.current!.grid = !grid;
              workspace.current!.drawOverlay();
            }}
          >
            ▦
          </button>
          <button
            aria-label="Text tool"
            title="Typography"
            disabled={!doc || blocked}
            className={tool === "text" ? "active" : ""}
            onClick={() => {
              setTool("text");
              setSettings(true);
            }}
          >
            T
          </button>
          <button
            aria-label="Adjustments"
            title="Photo adjustments"
            disabled={!doc || blocked}
            className={tool === "adjust" ? "active" : ""}
            onClick={() => {
              setTool("adjust");
              setSettings(true);
            }}
          >
            ◐
          </button>
          <button
            aria-label="Local shelf"
            title="Saved images and text styles"
            disabled={!doc || blocked}
            className={tool === "shelf" ? "active" : ""}
            onClick={() => {
              setTool("shelf");
              setSettings(true);
            }}
          >
            ▤
          </button>
          <button
            aria-label="Print settings"
            title="Physical size, borders and PDF"
            disabled={!doc || blocked}
            className={tool === "print" ? "active" : ""}
            onClick={() => {
              setTool("print");
              setSettings(true);
            }}
          >
            ▣
          </button>
          <button
            aria-label="Filters"
            title="Photo filters"
            disabled={!doc || blocked}
            className={tool === "filters" ? "active" : ""}
            onClick={() => {
              setTool("filters");
              setSettings(true);
            }}
          >
            ◒
          </button>
          <button
            aria-label="Retouch"
            title="Clone and spot heal"
            disabled={!doc || blocked}
            className={tool === "retouch" ? "active" : ""}
            onClick={() => {
              setTool("retouch");
              setSettings(true);
            }}
          >
            ⌁
          </button>
          <button
            aria-label="Draw"
            title="Paint on a separate layer"
            disabled={!doc || blocked}
            className={tool === "draw" ? "active" : ""}
            onClick={() => {
              setTool("draw");
              setSettings(true);
            }}
          >
            ✎
          </button>
          <button
            aria-label="Liquify"
            title="Push, pinch and expand"
            disabled={!doc || blocked}
            className={tool === "liquify" ? "active" : ""}
            onClick={() => {
              setTool("liquify");
              setSettings(true);
            }}
          >
            ≈
          </button>
          <div className="rail-spacer" />
          <button
            className={layers ? "active" : ""}
            aria-label="Toggle layers panel"
            title="Layers panel"
            onClick={() => setLayers(!layers)}
          >
            ▱
          </button>
        </nav>
        {settings && (
          <aside className="settings">
            <div className="panel-title">
              <h1>
                {tool === "retouch"
                  ? "Retouch"
                  : tool === "draw"
                    ? "Draw"
                    : tool === "liquify"
                      ? "Liquify"
                      : tool === "filters"
                        ? "Filters"
                        : tool === "arrange"
                          ? "Arrange"
                          : tool === "text"
                            ? "Text"
                            : tool === "cutout"
                              ? "Cutout"
                              : tool === "adjust"
                                ? "Adjustments"
                                : tool === "shelf"
                                  ? "Local shelf"
                                  : tool === "print"
                                    ? "Print & border"
                                    : "Crop & size"}
              </h1>
              <button
                aria-label="Collapse settings"
                disabled={blocked}
                className="quiet"
                onClick={() => setSettings(false)}
              >
                ×
              </button>
            </div>
            <p className="subtle">
              {tool === "arrange"
                ? "Give your photo room."
                : tool === "text"
                  ? "Words with room to breathe."
                  : tool === "cutout"
                    ? "Keep what matters. Restore anytime."
                    : tool === "adjust"
                      ? "Light, colour and detail."
                      : tool === "shelf"
                        ? "Keep useful pieces close."
                        : tool === "filters"
                          ? "Compare a look before applying it."
                          : tool === "retouch"
                            ? "Small repairs, original preserved."
                            : tool === "draw"
                              ? "Colour on a separate layer."
                              : tool === "liquify"
                                ? "Reshape locally. Undo any stroke."
                                : "Make every pixel fit."}
            </p>
            {doc?.importNote && (
              <p className="hint" role="note">
                {doc.importNote}
              </p>
            )}
            {tool === "arrange" ? (
              <>
                <section>
                  <h2>Placement</h2>
                  <p className="hint">
                    Drag your image on the canvas, or enter an exact position.
                  </p>
                  <div className="fields">
                    {([4, 5] as const).map((axis, i) => (
                      <label key={axis}>
                        {i ? "Y" : "X"}
                        <div className="input-unit">
                          <input
                            aria-label={i ? "Y position" : "X position"}
                            type="number"
                            disabled={
                              !layer ||
                              blocked ||
                              (!!doc && isLocked(doc, layer.id))
                            }
                            value={
                              Math.round((layer?.transform[axis] ?? 0) * 100) /
                              100
                            }
                            onChange={(e) =>
                              position(axis, e.target.valueAsNumber)
                            }
                          />
                          <span>px</span>
                        </div>
                      </label>
                    ))}
                  </div>
                </section>
                <section className="button-grid">
                  <button
                    disabled={!doc || blocked}
                    onClick={() => {
                      void run(() => changeGeometry(rotate(current.current!)));
                    }}
                  >
                    Rotate 90°
                  </button>
                  <button
                    disabled={!doc || blocked}
                    onClick={() => {
                      void run(() =>
                        changeGeometry(flip(current.current!, "horizontal")),
                      );
                    }}
                  >
                    Flip horizontal
                  </button>
                  <button
                    disabled={!doc || blocked}
                    onClick={() => {
                      void run(() =>
                        changeGeometry(flip(current.current!, "vertical")),
                      );
                    }}
                  >
                    Flip vertical
                  </button>
                </section>
              </>
            ) : tool === "text" && doc ? (
              <TextControls
                doc={doc}
                layer={layer?.kind === "text" ? layer : undefined}
                disabled={blocked || (!!layer && isLocked(doc, layer.id))}
                change={layerChange}
                importFont={importFont}
                editCanvas={() =>
                  layer && workspace.current!.beginTextEditing(layer.id)
                }
                addText={addText}
                draft={(active) => {
                  setPanelTextDraft(active);
                  window.photo.textEditingActive(active);
                }}
              />
            ) : tool === "adjust" && doc ? (
              <AdjustmentControls
                disabled={
                  !layer || layer.kind !== "raster" || isLocked(doc, layer.id)
                }
                busy={busy}
                previewing={!!preview && previewKind === "adjust"}
                preview={adjustmentPreview}
                apply={() => void run(applyPreview)}
                cancel={() => void run(cancelPreview)}
                compare={(before) =>
                  void run(async () => {
                    await redraw(
                      before ? current.current! : previewRef.current!,
                    );
                    setMessage(
                      before ? "Before adjustments" : "After adjustments",
                    );
                  })
                }
              />
            ) : tool === "filters" && doc ? (
              <FilterControls
                disabled={
                  !layer || layer.kind !== "raster" || isLocked(doc, layer.id)
                }
                busy={busy}
                previewing={!!preview && previewKind === "filter"}
                preview={filterPreview}
                apply={() => void run(applyPreview)}
                cancel={() => void run(cancelPreview)}
                compare={(before) =>
                  void run(async () => {
                    await redraw(
                      before ? current.current! : previewRef.current!,
                    );
                    setMessage(before ? "Before filter" : "After filter");
                  })
                }
              />
            ) : (tool === "retouch" || tool === "draw" || tool === "liquify") &&
              doc &&
              workspace.current ? (
              <StrokeControls
                key={tool}
                mode={tool}
                doc={doc}
                selected={selected}
                workspace={workspace.current}
                busy={busy}
                run={run}
                flush={project.flush}
                apply={applyStroke}
                newLayer={newPaintLayer}
              />
            ) : tool === "shelf" && doc ? (
              <ShelfControls
                layer={layer}
                disabled={blocked || (!!layer && isLocked(doc, layer.id))}
                run={run}
                flush={project.flush}
                insert={insertShelf}
              />
            ) : tool === "print" && doc ? (
              <PrintControls
                doc={doc}
                disabled={blocked}
                change={(next) => {
                  void run(async () => {
                    project.commit(next);
                    await redraw(next);
                  });
                }}
                exportPdf={() => {
                  void run(async () => {
                    await project.flush();
                    const d = current.current!;
                    setMessage("Preparing print PDF…");
                    const svg = await printSvg(d, assets.current);
                    setMessage(
                      (await window.photo.exportPdf(svg))
                        ? "Print PDF exported successfully"
                        : "PDF export cancelled",
                    );
                  });
                }}
              />
            ) : tool === "cutout" && doc && workspace.current ? (
              <CutoutControls
                doc={doc}
                selected={selected}
                workspace={workspace.current}
                busy={busy}
                run={run}
                flush={project.flush}
                apply={applyMask}
                trim={trimTransparency}
                backdrop={backdrop}
                setBackdrop={setBackdrop}
              />
            ) : (
              <section className="size-controls">
                <label>
                  Action
                  <select
                    aria-label="Size action"
                    disabled={!!preview}
                    value={sizeMode}
                    onChange={(e) =>
                      setSizeMode(e.target.value as typeof sizeMode)
                    }
                  >
                    <option value="crop">Crop</option>
                    <option value="resize">Resize image</option>
                    <option value="canvas">Canvas size</option>
                  </select>
                </label>
                <label>
                  Preset
                  <select
                    aria-label="Size preset"
                    disabled={!!preview}
                    defaultValue=""
                    onChange={(e) => {
                      if (!e.target.value) return;
                      const [w, h] = e.target.value.split("x").map(Number);
                      setSizeW(w);
                      setSizeH(h);
                      setSizeMode("resize");
                      setFitMode("fill");
                    }}
                  >
                    <option value="">Exact size</option>
                    <option value="1920x1080">Wallpaper · 1920 × 1080</option>
                    <option value="1920x1200">Wallpaper · 1920 × 1200</option>
                    <option value="2560x1440">Wallpaper · 2560 × 1440</option>
                    <option value="3840x2160">Wallpaper · 3840 × 2160</option>
                    <option value="1080x1920">Portrait · 1080 × 1920</option>
                  </select>
                </label>
                <div className="fields">
                  <label>
                    Width
                    <input
                      aria-label="Size width"
                      type="number"
                      min="1"
                      max="12000"
                      disabled={!!preview}
                      value={sizeW}
                      onChange={(e) => {
                        const v = e.target.valueAsNumber;
                        setSizeW(v);
                        if (aspect && sizeMode === "resize" && doc)
                          setSizeH(Math.round((v * doc.height) / doc.width));
                      }}
                    />
                  </label>
                  <label>
                    Height
                    <input
                      aria-label="Size height"
                      type="number"
                      min="1"
                      max="12000"
                      disabled={!!preview}
                      value={sizeH}
                      onChange={(e) => {
                        const v = e.target.valueAsNumber;
                        setSizeH(v);
                        if (aspect && sizeMode === "resize" && doc)
                          setSizeW(Math.round((v * doc.width) / doc.height));
                      }}
                    />
                  </label>
                </div>
                {sizeMode === "crop" && (
                  <div className="fields">
                    <label>
                      Left
                      <input
                        aria-label="Crop left"
                        type="number"
                        min="0"
                        value={cropX}
                        disabled={!!preview}
                        onChange={(e) => setCropX(e.target.valueAsNumber)}
                      />
                    </label>
                    <label>
                      Top
                      <input
                        aria-label="Crop top"
                        type="number"
                        min="0"
                        value={cropY}
                        disabled={!!preview}
                        onChange={(e) => setCropY(e.target.valueAsNumber)}
                      />
                    </label>
                  </div>
                )}
                {sizeMode === "resize" && (
                  <>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={aspect}
                        disabled={!!preview}
                        onChange={(e) => setAspect(e.target.checked)}
                      />
                      Lock aspect ratio
                    </label>
                    <label>
                      Image fit
                      <select
                        aria-label="Image fit"
                        value={fitMode}
                        disabled={!!preview}
                        onChange={(e) =>
                          setFitMode(e.target.value as typeof fitMode)
                        }
                      >
                        <option value="fit">Fit · transparent padding</option>
                        <option value="fill">Fill · crop the edges</option>
                        <option value="stretch">Stretch to exact size</option>
                      </select>
                    </label>
                  </>
                )}
                {sizeMode === "canvas" && (
                  <div>
                    <span>Anchor</span>
                    <div className="anchor-grid">
                      {Array.from({ length: 9 }, (_, i) => (
                        <button
                          key={i}
                          aria-label={
                            "Anchor " +
                            [
                              "top left",
                              "top centre",
                              "top right",
                              "middle left",
                              "centre",
                              "middle right",
                              "bottom left",
                              "bottom centre",
                              "bottom right",
                            ][i]
                          }
                          aria-pressed={anchor === i}
                          disabled={!!preview}
                          className={anchor === i ? "active" : ""}
                          onClick={() => setAnchor(i)}
                        >
                          {i === 4
                            ? "•"
                            : ["↖", "↑", "↗", "←", "", "→", "↙", "↓", "↘"][i]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <p className="hint">
                  {sizeMode === "crop"
                    ? "Keep the selected rectangle. Pixels outside it stay in the original."
                    : sizeMode === "resize"
                      ? "Scale the composition into new pixel dimensions."
                      : "Change the canvas boundary without scaling your image."}
                </p>
                {preview ? (
                  <div className="button-grid">
                    <button
                      className="primary"
                      onClick={() => {
                        void applyPreview();
                      }}
                    >
                      Apply
                    </button>
                    <button
                      onClick={() => {
                        void cancelPreview();
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    disabled={busy || !doc}
                    onClick={() => {
                      void sizePreview();
                    }}
                  >
                    Preview size
                  </button>
                )}
              </section>
            )}
            <section>
              <h2>Document</h2>
              <div className="dimensions">
                <span>
                  {shown ? `${shown.width} × ${shown.height}` : "— × —"}
                </span>
                <small>pixels</small>
              </div>
              <p className="hint">
                Export uses these dimensions at every zoom level.
              </p>
            </section>
            <section>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={grid}
                  onChange={(e) => {
                    setGrid(e.target.checked);
                    workspace.current!.grid = e.target.checked;
                    workspace.current!.drawOverlay();
                  }}
                />
                Document grid
              </label>
              <p className="hint">
                A placement guide. Never part of your exported image.
              </p>
            </section>
            {doc && workspace.current && (
              <GuideControls
                doc={doc}
                workspace={workspace.current}
                disabled={blocked}
                change={layerChange}
              />
            )}
            <div className="help">
              <strong>A little room to work</strong>
              <p>
                Scroll to zoom.
                <br />
                Hold Space and drag to pan.
                <br />
                Fit brings your photo back into view.
              </p>
            </div>
          </aside>
        )}
        <div className="center">
          <div className="canvas-bar">
            {textEditing ? (
              <>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void workspace.current!.finishTextEditing()}
                >
                  Done editing text
                </button>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    void workspace.current!.finishTextEditing(true)
                  }
                >
                  Cancel text edit
                </button>
              </>
            ) : (
              <>
                <span>{doc ? "Canvas" : "Your worktable"}</span>
                <span className="badge">
                  {doc ? "sRGB · transparent PNG" : "Local & offline"}
                </span>
              </>
            )}
          </div>
          <div
            ref={host}
            className={"stage " + (busy || preview ? "interaction-locked" : "")}
          >
            <div
              className={"paper backdrop-" + backdrop}
              style={{
                display: doc ? "block" : "none",
                left: view.x,
                top: view.y,
                width: (shown?.width ?? 0) * view.z,
                height: (shown?.height ?? 0) * view.z,
              }}
            />
            <canvas ref={canvas} />
            <canvas ref={overlay} className="overlay" />
            {!doc && (
              <div className="empty">
                <div className="empty-icon">▧</div>
                <h2>A fresh canvas for your photo.</h2>
                <p>
                  Open a PNG or JPEG, find its place,
                  <br />
                  and export a clean new copy.
                </p>
                <button className="primary" disabled={busy} onClick={open}>
                  Open a photo
                </button>
                <small>Your original stays untouched.</small>
                <button
                  disabled={busy}
                  onClick={() => {
                    void paste();
                  }}
                >
                  Paste image
                </button>
                {recent.length > 0 && (
                  <div className="home-recents">
                    <h3>Continue editing</h3>
                    {recent.slice(0, 3).map((r) => (
                      <button
                        key={r.id}
                        disabled={busy}
                        onClick={() => {
                          void run(async () => {
                            const result = await window.photo.loadProject(r.id);
                            await display(result);
                            setMessage(
                              result.recovered
                                ? "Recovered the last good revision"
                                : "Project reopened",
                            );
                          });
                        }}
                      >
                        {r.name}
                        <small>
                          {r.width} × {r.height}
                        </small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="canvas-footer">
            <span>
              {shown ? `${shown.width} × ${shown.height} px` : "No image open"}
            </span>
            <div>
              <button disabled={!doc} onClick={() => workspace.current!.fit()}>
                Fit
              </button>
              <button
                disabled={!doc}
                onClick={() => workspace.current!.setZoom(1)}
              >
                100%
              </button>
              <input
                className="zoom-input"
                aria-label="Zoom percent"
                type="number"
                min="5"
                max="800"
                disabled={!doc}
                value={Math.round(zoom * 100)}
                onChange={(e) => {
                  const value = e.target.valueAsNumber;
                  if (value >= 5 && value <= 800)
                    workspace.current!.setZoom(value / 100);
                }}
              />
              <span>%</span>
            </div>
          </div>
        </div>
        {layers && (
          <aside className="layers">
            {doc ? (
              <LayerControls
                doc={doc}
                selected={selected}
                disabled={blocked}
                select={chooseLayer}
                change={layerChange}
                addImage={() => {
                  void addImage();
                }}
                addText={addText}
                textPanel={tool === "text" && settings}
                openText={() => {
                  setTool("text");
                  setSettings(true);
                }}
                bounds={() => workspace.current!.bounds()}
                intrinsic={(id) => workspace.current!.intrinsic(id)}
              />
            ) : (
              <>
                <h2>Layers</h2>
                <p className="hint">Open a photo to start a composition.</p>
              </>
            )}
            <div className="export-note">
              <label>
                Export format
                <select
                  aria-label="Export format"
                  disabled={blocked}
                  value={format}
                  onChange={(e) => setFormat(e.target.value as typeof format)}
                >
                  <option value="png">PNG · transparency</option>
                  <option value="jpeg">JPEG · flattened</option>
                  <option value="webp">WebP · transparency</option>
                </select>
              </label>
              {format !== "png" && (
                <label>
                  Quality
                  <input
                    aria-label="Export quality"
                    type="number"
                    min="1"
                    max="100"
                    value={quality}
                    onChange={(e) => setQuality(e.target.valueAsNumber)}
                  />
                </label>
              )}
              {format === "jpeg" && (
                <label>
                  Background matte
                  <input
                    aria-label="JPEG matte"
                    type="color"
                    value={matte}
                    onChange={(e) => setMatte(e.target.value)}
                  />
                </label>
              )}
              <h3>
                {format === "jpeg"
                  ? "A solid background for JPEG."
                  : "Keep the clear parts clear."}
              </h3>
              <p>
                {format === "jpeg"
                  ? "Transparent pixels are flattened onto your selected matte colour."
                  : "Transparency stays in your export. The checkerboard is only a preview."}
              </p>
              <button
                disabled={blocked}
                onClick={() => {
                  void paste();
                }}
              >
                Paste image
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  void run(() => window.photo.revealLibrary());
                }}
              >
                Reveal library
              </button>
            </div>
          </aside>
        )}
      </div>
      {project.saveError && (
        <div className="save-error" role="alert">
          Save failed: {project.saveError}
          <button
            disabled={busy}
            onClick={() => {
              void run(() => project.flush());
            }}
          >
            Retry save
          </button>
        </div>
      )}
      {(showRecent || showVersions) && (
        <div className="modal-backdrop">
          <section
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={showRecent ? "Saved projects" : "Versions"}
          >
            <div className="panel-title">
              <h2>{showRecent ? "Saved projects" : "Versions"}</h2>
              <button
                aria-label="Close dialog"
                onClick={() => {
                  setShowRecent(false);
                  setShowVersions(false);
                }}
              >
                ×
              </button>
            </div>
            <div className="button-grid">
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await project.flush();
                    const result = await window.photo.openPortable();
                    if (result) {
                      await display(result);
                      setMessage("Portable project opened as a new local copy");
                    }
                  })
                }
              >
                Open portable project
              </button>
              <button
                disabled={busy || !doc}
                onClick={() =>
                  void run(async () => {
                    await project.flush();
                    setMessage(
                      (await window.photo.exportPortable())
                        ? "Portable project exported"
                        : "Portable export cancelled",
                    );
                  })
                }
              >
                Export portable project
              </button>
            </div>
            <p className="hint">
              Portable files include the current project, checkpoints, original
              images, masks and imported fonts. Installed fonts must be
              available on the receiving computer.
            </p>
            {showRecent ? (
              <>
                <p className="hint">
                  Stored on this computer. Your imported originals stay with
                  each project.
                </p>
                {recent.length === 0 ? (
                  <p>No saved projects yet.</p>
                ) : (
                  recent.map((r) => (
                    <button
                      className="project-row"
                      key={r.id}
                      disabled={busy}
                      onClick={() => {
                        void run(async () => {
                          await project.flush();
                          const result = await window.photo.loadProject(r.id);
                          await display(result);
                          setMessage(
                            result.recovered
                              ? "Recovered the last good revision"
                              : "Project reopened",
                          );
                        });
                      }}
                    >
                      <strong>{r.name}</strong>
                      <span>
                        {r.width} × {r.height} px
                      </span>
                      <small>
                        {new Date(r.updated).toLocaleString()}
                        {r.recovered ? " · recovered" : ""}
                      </small>
                    </button>
                  ))
                )}
              </>
            ) : (
              <>
                <p className="hint">
                  Restoring preserves later work as a named checkpoint. The 12
                  most recent autosaved versions also stay available. Session
                  undo is separate.
                </p>
                <div className="checkpoint-entry">
                  <input
                    aria-label="Checkpoint name"
                    placeholder="Name this moment"
                    maxLength={80}
                    value={checkpointName}
                    onChange={(e) => setCheckpointName(e.target.value)}
                  />
                  <button
                    disabled={busy || !checkpointName.trim()}
                    onClick={() => {
                      void checkpoint();
                    }}
                  >
                    Save checkpoint
                  </button>
                </div>
                {checkpoints.length === 0 ? (
                  <p className="hint">No named checkpoints yet.</p>
                ) : (
                  checkpoints
                    .slice(versionPage * 12, (versionPage + 1) * 12)
                    .map((c) => (
                      <div className="project-row version-row" key={c.id}>
                        <VersionPreview id={c.id} name={c.name} />
                        <strong>{c.name}</strong>
                        <small>
                          {c.kind === "rolling" ? "Rolling · " : "Named · "}
                          {new Date(c.created).toLocaleString()}
                        </small>
                        <button
                          disabled={busy}
                          onClick={() => {
                            void run(async () => {
                              await project.flush();
                              await display(
                                await window.photo.restoreCheckpoint(c.id),
                              );
                              setMessage(
                                "Checkpoint restored; later work preserved",
                              );
                            });
                          }}
                        >
                          Restore
                        </button>
                      </div>
                    ))
                )}
                <div className="button-grid">
                  <button
                    disabled={busy || versionPage === 0}
                    onClick={() => setVersionPage((p) => p - 1)}
                  >
                    Newer versions
                  </button>
                  <button
                    disabled={
                      busy || (versionPage + 1) * 12 >= checkpoints.length
                    }
                    onClick={() => setVersionPage((p) => p + 1)}
                  >
                    Older versions
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
      <footer role="status">
        <span className={busy ? "status-dot working" : "status-dot"} />
        {message}
        <span className="footer-end">Offline workspace · Gate 7</span>
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
