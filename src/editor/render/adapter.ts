import {
  Canvas,
  StaticCanvas,
  FabricImage,
  IText,
  FabricObject,
  Group,
  util,
  Point,
  Rect,
  config,
} from "fabric";
import { MAX_PIXELS, type PhotoDocument, type Layer } from "../model/document";
import { snapDelta, type Bounds } from "../commands/layers";
import { textObject } from "./text";
import type { PixelPoint } from "../model/mask";
export type PointerTool = {
  down(point: PixelPoint): void;
  move(point: PixelPoint): void;
  up(point: PixelPoint): void;
  finish(): void;
  draw(ctx: CanvasRenderingContext2D): void;
};
export type Assets = Record<string, Uint8Array>;
// Isolate every group, including nested groups: opacity is applied once to the
// composed children, and child blends see only their group's transparent backdrop.
class IsolatedGroup extends Group {
  override needsItsOwnCache() {
    return true;
  }
}
config.perfLimitSizeTotal = MAX_PIXELS;
config.maxCacheSideLimit = 12000;
export type RenderObject = FabricObject & {
  layerId: string;
  sourceCenter: { x: number; y: number };
};
async function bitmap(bytes: Uint8Array) {
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], { type: "image/png" }),
  );
  try {
    return await FabricImage.fromURL(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function objectFor(
  layer: Layer,
  assets: Assets,
  locked = false,
): Promise<RenderObject> {
  let object: FabricObject;
  let center: Point;
  if (layer.kind === "group") {
    const children = [];
    for (const child of layer.children)
      children.push(await objectFor(child, assets, locked || !!layer.locked));
    object = new IsolatedGroup(children, {
      subTargetCheck: false,
      objectCaching: true,
    });
    center = object.getRelativeCenterPoint();
  } else {
    if (layer.kind === "text") object = await textObject(layer, assets);
    else {
      let raster = await bitmap(assets[layer.asset]);
      if (layer.mask) {
        const mask = await bitmap(assets[layer.mask]);
        const element = document.createElement("canvas");
        element.width = raster.width;
        element.height = raster.height;
        const ctx = element.getContext("2d")!;
        ctx.drawImage(raster.getElement(), 0, 0);
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(mask.getElement(), 0, 0);
        raster = new FabricImage(element);
      }
      object = raster;
    }
    const offset = (
      object as FabricObject & { textOffset?: { x: number; y: number } }
    ).textOffset;
    center = new Point(
      object.width / 2 + (offset?.x ?? 0),
      object.height / 2 + (offset?.y ?? 0),
    );
  }
  object.set({
    originX: "left",
    originY: "top",
    visible: layer.visible,
    opacity: layer.opacity,
    globalCompositeOperation: layer.blend ?? "source-over",
    selectable: !locked && !layer.locked,
    evented: !locked && !layer.locked,
    hasControls: false,
    borderColor: "#B93D39",
    objectCaching: layer.kind === "group",
    strokeWidth:
      object instanceof IText && layer.kind === "text" && layer.stroke
        ? (layer.strokeWidth ?? 1)
        : 0,
  });
  if (object instanceof IText) object.editable = !locked && !layer.locked;
  util.applyTransformToObject(
    object,
    util.multiplyTransformMatrices(layer.transform, [
      1,
      0,
      0,
      1,
      center.x,
      center.y,
    ]),
  );
  const result = object as RenderObject;
  result.layerId = layer.id;
  result.sourceCenter = center;
  return result;
}
export async function project(
  canvas: StaticCanvas,
  doc: PhotoDocument,
  assets: Assets,
) {
  canvas.clear();
  for (const layer of doc.layers) canvas.add(await objectFor(layer, assets));
  if (doc.border?.width) {
    const w = Math.min(doc.border.width, doc.width / 2, doc.height / 2);
    for (const [left, top, width, height] of [
      [0, 0, doc.width, w],
      [0, doc.height - w, doc.width, w],
      [0, w, w, doc.height - 2 * w],
      [doc.width - w, w, w, doc.height - 2 * w],
    ])
      canvas.add(
        new Rect({
          left,
          top,
          width,
          height,
          fill: doc.border.colour,
          strokeWidth: 0,
          selectable: false,
          evented: false,
          objectCaching: false,
        }),
      );
  }
  canvas.renderAll();
}
export async function composite(doc: PhotoDocument, assets: Assets) {
  const element = document.createElement("canvas");
  const canvas = new StaticCanvas(element, {
    width: doc.width,
    height: doc.height,
    enableRetinaScaling: false,
    renderOnAddRemove: false,
  });
  try {
    await project(canvas, doc, assets);
    const blob = await new Promise<Blob>((res, rej) =>
      element.toBlob(
        (b) => (b ? res(b) : rej(Error("PNG encoding failed"))),
        "image/png",
      ),
    );
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    await canvas.dispose();
  }
}
export class Workspace {
  onTextEditing?: (editing: boolean) => void;
  onTextCommit?: (id: string, text: string) => Promise<void>;
  private editing?: { object: IText & RenderObject; before: string };
  private textCommit: Promise<void> = Promise.resolve();
  private textExit = new WeakSet<FabricObject>();
  get isTextEditing() {
    return !!this.editing;
  }
  beginTextEditing(id: string) {
    const object = this.objects().find((o) => o.layerId === id);
    if (!(object instanceof IText) || !object.editable) return;
    this.canvas.setActiveObject(object);
    object.enterEditing();
    object.selectAll();
    this.canvas.requestRenderAll();
  }
  finishTextEditing(cancel = false): Promise<void> {
    if (this.editing) {
      const { object, before } = this.editing;
      if (cancel) object.set("text", before);
      object.exitEditing();
      this.canvas.requestRenderAll();
    }
    return this.textCommit;
  }
  pointerTool?: PointerTool;
  setPointerTool(tool?: PointerTool) {
    this.pointerTool = tool;
    this.canvas.discardActiveObject();
    this.canvas.skipTargetFind = !!tool || this.space;
    this.canvas.defaultCursor = tool ? "crosshair" : "default";
    this.drawOverlay();
  }
  canvas: Canvas;
  doc?: PhotoDocument;
  grid = false;
  zoom = 1;
  offset = { x: 0, y: 0 };
  onView?: () => void;
  onSelect?: (id: string, add: boolean) => void;
  selectedIds: string[] = [];
  guidesVisible = true;
  snapGrid = false;
  snapGuides = false;
  snapLayers = false;
  gridSize = 32;
  private pan?: { x: number; y: number };
  space = false;
  constructor(
    element: HTMLCanvasElement,
    private overlay: HTMLCanvasElement,
    private changed: (id: string, x: number, y: number) => void,
  ) {
    this.canvas = new Canvas(element, {
      selection: false,
      renderOnAddRemove: false,
      preserveObjectStacking: true,
    });
    this.canvas.on("object:modified", ({ target }) => {
      if (!target) return;
      if (this.textExit.delete(target)) return;
      const object = target as RenderObject;
      const matrix = target.calcOwnMatrix();
      const point = util.transformPoint(
        new Point(-object.sourceCenter.x, -object.sourceCenter.y),
        matrix,
      );
      const x = Math.round(point.x),
        y = Math.round(point.y);
      target.set({
        left: target.left + x - point.x,
        top: target.top + y - point.y,
      });
      target.setCoords();
      // Finish Fabric's pointer release before replacing its object tree.
      queueMicrotask(() => this.changed(object.layerId, x, y));
      this.canvas.requestRenderAll();
      this.drawOverlay();
    });
    this.canvas.on("text:editing:entered", ({ target }) => {
      this.editing = {
        object: target as IText & RenderObject,
        before: target.text,
      };
      if (target.hiddenTextarea) {
        target.hiddenTextarea.maxLength = 10000;
        target.hiddenTextarea.setAttribute("aria-label", "Canvas text editor");
      }
      this.onTextEditing?.(true);
    });
    this.canvas.on("text:editing:exited", ({ target }) => {
      const before = this.editing?.before;
      this.editing = undefined;
      if (before !== target.text) this.textExit.add(target);
      this.onTextEditing?.(false);
      this.textCommit = Promise.resolve().then(async () => {
        if (before !== target.text)
          await this.onTextCommit?.(
            (target as IText & RenderObject).layerId,
            target.text,
          );
      });
    });
    this.canvas.on("object:moving", ({ target }) => {
      if (!target || !this.doc) return;
      const others = this.canvas
        .getObjects()
        .filter(
          (o) =>
            o !== target &&
            o.visible &&
            !this.selectedIds.includes((o as RenderObject).layerId),
        )
        .map((o) => o.getBoundingRect());
      const { dx, dy } = snapDelta(
        target.getBoundingRect(),
        others,
        this.doc.guides ?? [],
        {
          grid: this.snapGrid,
          guides: this.snapGuides,
          layers: this.snapLayers,
          step: this.gridSize,
          zoom: this.zoom,
        },
      );
      target.set({ left: target.left + dx, top: target.top + dy });
      target.setCoords();
      this.drawOverlay();
    });
    this.canvas.on("mouse:down", ({ e, target }) => {
      const event = e as MouseEvent;
      if (this.space || event.button === 1) {
        this.pan = { x: event.clientX, y: event.clientY };
        this.canvas.skipTargetFind = true;
      } else if (this.pointerTool && event.button === 0) {
        this.pointerTool.down(this.canvas.getScenePoint(e));
      } else if (target)
        this.onSelect?.(
          (target as RenderObject).layerId,
          event.ctrlKey || event.metaKey || event.shiftKey,
        );
    });
    this.canvas.on("mouse:move", ({ e }) => {
      if (!this.pan) {
        this.pointerTool?.move(this.canvas.getScenePoint(e));
        return;
      }
      const event = e as MouseEvent;
      this.offset.x += event.clientX - this.pan.x;
      this.offset.y += event.clientY - this.pan.y;
      this.pan = { x: event.clientX, y: event.clientY };
      this.view();
    });
    this.canvas.on("mouse:up", ({ e }) => {
      if (!this.pan && (e as MouseEvent).button === 0)
        this.pointerTool?.up(this.canvas.getScenePoint(e));
      this.pan = undefined;
      this.canvas.skipTargetFind = this.space || !!this.pointerTool;
    });
    this.canvas.on("mouse:dblclick", () => this.pointerTool?.finish());
    this.canvas.on("mouse:wheel", ({ e }) => {
      e.preventDefault();
      e.stopPropagation();
      const p = new Point(e.offsetX, e.offsetY),
        next = Math.max(
          0.05,
          Math.min(8, this.zoom * Math.pow(0.999, e.deltaY)),
        );
      this.offset = {
        x: p.x - ((p.x - this.offset.x) * next) / this.zoom,
        y: p.y - ((p.y - this.offset.y) * next) / this.zoom,
      };
      this.zoom = next;
      this.view();
    });
  }
  objects() {
    const all: RenderObject[] = [];
    function walk(objects: FabricObject[]) {
      for (const o of objects) {
        if ((o as RenderObject).layerId) all.push(o as RenderObject);
        if (o instanceof Group) walk(o.getObjects());
      }
    }
    walk(this.canvas.getObjects());
    return all;
  }
  bounds(): Record<string, Bounds> {
    return Object.fromEntries(
      this.objects().map((o) => [o.layerId, o.getBoundingRect()]),
    );
  }
  intrinsic(id: string) {
    const object = this.objects().find((o) => o.layerId === id);
    return object ? { width: object.width, height: object.height } : undefined;
  }
  select(ids: string[]) {
    this.selectedIds = ids;
    this.canvas.discardActiveObject();
    const first = this.canvas
      .getObjects()
      .find((o) => (o as RenderObject).layerId === ids[0]);
    if (first && first.selectable && first.visible)
      this.canvas.setActiveObject(first);
    this.canvas.requestRenderAll();
    this.drawOverlay();
  }
  async load(doc: PhotoDocument, assets: Assets, fit = true) {
    this.doc = doc;
    await project(this.canvas, doc, assets);
    this.canvas.clipPath = new Rect({
      left: 0,
      top: 0,
      originX: "left",
      originY: "top",
      width: doc.width,
      height: doc.height,
      absolutePositioned: true,
    });
    this.select(this.selectedIds);
    if (fit) this.fit();
    else this.view();
  }
  resize(width: number, height: number) {
    this.canvas.setDimensions({ width, height });
    this.overlay.width = width;
    this.overlay.height = height;
    this.view();
  }
  fit() {
    if (!this.doc) return;
    this.zoom = Math.min(
      (this.canvas.width - 100) / this.doc.width,
      (this.canvas.height - 100) / this.doc.height,
      1,
    );
    this.offset = {
      x: (this.canvas.width - this.doc.width * this.zoom) / 2,
      y: (this.canvas.height - this.doc.height * this.zoom) / 2,
    };
    this.view();
  }
  setZoom(z: number) {
    const x = this.canvas.width / 2,
      y = this.canvas.height / 2;
    this.offset = {
      x: x - ((x - this.offset.x) * z) / this.zoom,
      y: y - ((y - this.offset.y) * z) / this.zoom,
    };
    this.zoom = z;
    this.view();
  }
  view() {
    this.canvas.setViewportTransform([
      this.zoom,
      0,
      0,
      this.zoom,
      this.offset.x,
      this.offset.y,
    ]);
    this.canvas.requestRenderAll();
    this.drawOverlay();
    this.onView?.();
  }
  drawOverlay() {
    const ctx = this.overlay.getContext("2d")!;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!this.doc) return;
    const { x, y } = this.offset,
      w = this.doc.width * this.zoom,
      h = this.doc.height * this.zoom;
    ctx.strokeStyle = "#ffffffaa";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    if (this.grid) {
      ctx.strokeStyle = "#265d69aa";
      const step =
        Math.max(
          this.gridSize,
          Math.ceil(16 / this.zoom / this.gridSize) * this.gridSize,
        ) * this.zoom;
      ctx.beginPath();
      for (let i = step; i < w; i += step) {
        ctx.moveTo(x + i, y);
        ctx.lineTo(x + i, y + h);
      }
      for (let i = step; i < h; i += step) {
        ctx.moveTo(x, y + i);
        ctx.lineTo(x + w, y + i);
      }
      ctx.stroke();
    }
    if (this.guidesVisible) {
      ctx.strokeStyle = "#8a3eb8";
      ctx.setLineDash([5, 3]);
      for (const guide of this.doc.guides ?? []) {
        ctx.beginPath();
        if (guide.axis === "x") {
          ctx.moveTo(x + guide.position * this.zoom, y);
          ctx.lineTo(x + guide.position * this.zoom, y + h);
        } else {
          ctx.moveTo(x, y + guide.position * this.zoom);
          ctx.lineTo(x + w, y + guide.position * this.zoom);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.strokeStyle = "#b93d39";
    ctx.setLineDash([4, 3]);
    for (const object of this.objects()) {
      if (!this.selectedIds.includes(object.layerId) || !object.visible)
        continue;
      const b = object.getBoundingRect();
      ctx.strokeRect(
        x + b.left * this.zoom,
        y + b.top * this.zoom,
        b.width * this.zoom,
        b.height * this.zoom,
      );
    }
    ctx.setLineDash([]);
    this.pointerTool?.draw(ctx);
  }
  move(layer: Layer, x: number, y: number) {
    const object = this.canvas
      .getObjects()
      .find((o) => (o as RenderObject).layerId === layer.id) as
      RenderObject | undefined;
    if (object) {
      const matrix = [...layer.transform] as typeof layer.transform;
      matrix[4] = x;
      matrix[5] = y;
      util.applyTransformToObject(
        object,
        util.multiplyTransformMatrices(matrix, [
          1,
          0,
          0,
          1,
          object.sourceCenter.x,
          object.sourceCenter.y,
        ]),
      );
      object.setCoords();
      this.canvas.requestRenderAll();
      this.drawOverlay();
    }
  }
  dispose() {
    return this.canvas.dispose();
  }
}
