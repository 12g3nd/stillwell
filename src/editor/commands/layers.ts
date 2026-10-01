import {
  documentSchema,
  flattenLayers,
  type PhotoDocument,
  type Layer,
  type Matrix,
} from "../model/document";
export const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ].map((v) => (v === 0 ? 0 : v)) as Matrix;
}
export function inverse(m: Matrix): Matrix {
  const d = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(d) < 1e-8) throw Error("Transform is not invertible");
  return [
    m[3] / d,
    -m[1] / d,
    -m[2] / d,
    m[0] / d,
    (m[2] * m[5] - m[3] * m[4]) / d,
    (m[1] * m[4] - m[0] * m[5]) / d,
  ];
}
export function locate(doc: PhotoDocument, id: string) {
  let result:
    | {
        layer: Layer;
        siblings: Layer[];
        parent?: Layer;
        ancestors: Layer[];
        parentMatrix: Matrix;
      }
    | undefined;
  function walk(layers: Layer[], ancestors: Layer[], matrix: Matrix) {
    for (const layer of layers) {
      if (layer.id === id)
        result = {
          layer,
          siblings: layers,
          parent: ancestors.at(-1),
          ancestors,
          parentMatrix: matrix,
        };
      if (layer.kind === "group")
        walk(
          layer.children,
          [...ancestors, layer],
          multiply(matrix, layer.transform),
        );
    }
  }
  walk(doc.layers, [], identity());
  return result;
}
export function isLocked(doc: PhotoDocument, id: string) {
  const found = locate(doc, id);
  return !found || [...found.ancestors, found.layer].some((l) => l.locked);
}
export function selectionRoots(doc: PhotoDocument, ids: string[]) {
  return [...new Set(ids)].filter((id) => {
    const found = locate(doc, id);
    return found && !found.ancestors.some((a) => ids.includes(a.id));
  });
}
function mutate(doc: PhotoDocument, action: (copy: PhotoDocument) => void) {
  const next = structuredClone(doc);
  next.schemaVersion = 2;
  action(next);
  return documentSchema.parse(next);
}
export function patchLayer(
  doc: PhotoDocument,
  id: string,
  patch: Partial<Layer>,
) {
  return mutate(doc, (next) => {
    const found = locate(next, id);
    if (!found) throw Error("Layer no longer exists");
    const unlock = Object.keys(patch).every((k) => k === "locked");
    if (
      found.ancestors.some((l) => l.locked) ||
      (found.layer.locked && !unlock)
    )
      throw Error("Unlock the layer or its group first");
    Object.assign(found.layer, patch);
  });
}
export function renameLayer(doc: PhotoDocument, id: string, name: string) {
  const value = name.trim();
  if (!value) throw Error("Give the layer a name");
  return patchLayer(doc, id, { name: value });
}
export function duplicate(doc: PhotoDocument, ids: string[]) {
  return mutate(doc, (next) => {
    for (const id of selectionRoots(next, ids)) {
      const found = locate(next, id)!;
      if (isLocked(next, id)) throw Error("Unlock layers before duplicating");
      const copy = structuredClone(found.layer);
      for (const l of flattenLayers([copy])) l.id = crypto.randomUUID();
      copy.name = (copy.name + " copy").slice(0, 200);
      copy.transform[4] += 16;
      copy.transform[5] += 16;
      found.siblings.splice(found.siblings.indexOf(found.layer) + 1, 0, copy);
    }
  });
}
export function reorder(doc: PhotoDocument, id: string, direction: -1 | 1) {
  return mutate(doc, (next) => {
    const f = locate(next, id);
    if (!f || isLocked(next, id))
      throw Error("Unlock the layer before reordering");
    const index = f.siblings.indexOf(f.layer),
      target = index + direction;
    if (target < 0 || target >= f.siblings.length) return;
    f.siblings.splice(index, 1);
    f.siblings.splice(target, 0, f.layer);
  });
}
export function moveBefore(doc: PhotoDocument, id: string, targetId: string) {
  return mutate(doc, (next) => {
    const f = locate(next, id),
      target = locate(next, targetId);
    if (!f || !target || f.siblings !== target.siblings)
      throw Error("Reorder within the same group");
    if (isLocked(next, id)) throw Error("Unlock the layer before reordering");
    if (id === targetId) return;
    f.siblings.splice(f.siblings.indexOf(f.layer), 1);
    f.siblings.splice(f.siblings.indexOf(target.layer) + 1, 0, f.layer);
  });
}
export function groupLayers(doc: PhotoDocument, ids: string[]) {
  return mutate(doc, (next) => {
    const roots = selectionRoots(next, ids);
    if (roots.length < 2) throw Error("Select at least two sibling layers");
    const first = locate(next, roots[0])!;
    if (roots.some((id) => locate(next, id)!.siblings !== first.siblings))
      throw Error("Group layers from the same parent");
    if (roots.some((id) => isLocked(next, id)))
      throw Error("Unlock layers before grouping");
    const children = first.siblings.filter((l) => roots.includes(l.id));
    const index = Math.max(...children.map((l) => first.siblings.indexOf(l)));
    first.siblings.splice(index + 1, 0, {
      id: crypto.randomUUID(),
      kind: "group",
      name: "Group",
      visible: true,
      opacity: 1,
      transform: identity(),
      children,
    });
    for (const child of children)
      first.siblings.splice(first.siblings.indexOf(child), 1);
  });
}
export function ungroup(doc: PhotoDocument, id: string) {
  return mutate(doc, (next) => {
    const f = locate(next, id);
    if (!f || f.layer.kind !== "group" || isLocked(next, id))
      throw Error("Select an unlocked group");
    if (
      f.layer.opacity !== 1 ||
      (f.layer.blend ?? "source-over") !== "source-over" ||
      f.layer.children.some(
        (child) => (child.blend ?? "source-over") !== "source-over",
      )
    )
      throw Error(
        "Set group opacity to 100% and blend to Normal on the group and its direct children before ungrouping",
      );
    const group = f.layer;
    const children = group.children.map((l) => ({
      ...l,
      visible: group.visible && l.visible,
      transform: multiply(group.transform, l.transform),
    }));
    f.siblings.splice(f.siblings.indexOf(group), 1, ...children);
  });
}
export function translateWorld(
  doc: PhotoDocument,
  ids: string[],
  dx: number,
  dy: number,
) {
  return mutate(doc, (next) => {
    for (const id of selectionRoots(next, ids)) {
      const f = locate(next, id)!;
      if (isLocked(next, id))
        throw Error("Unlock selected layers before moving");
      const inv = inverse(f.parentMatrix);
      f.layer.transform[4] += inv[0] * dx + inv[2] * dy;
      f.layer.transform[5] += inv[1] * dx + inv[3] * dy;
    }
  });
}
export type Bounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export function align(
  doc: PhotoDocument,
  ids: string[],
  bounds: Record<string, Bounds>,
  mode: "left" | "centerX" | "right" | "top" | "centerY" | "bottom",
) {
  const roots = selectionRoots(doc, ids);
  if (!roots.length) throw Error("Select layers to align");
  const boxes = roots.map((id) => bounds[id]);
  if (boxes.some((b) => !b)) throw Error("Layer bounds are unavailable");
  const axis = ["left", "centerX", "right"].includes(mode) ? "x" : "y";
  const start = axis === "x" ? "left" : "top",
    size = axis === "x" ? "width" : "height";
  const min = roots.length === 1 ? 0 : Math.min(...boxes.map((b) => b[start]));
  const max =
    roots.length === 1
      ? axis === "x"
        ? doc.width
        : doc.height
      : Math.max(...boxes.map((b) => b[start] + b[size]));
  const fraction = mode.startsWith("center")
    ? 0.5
    : ["right", "bottom"].includes(mode)
      ? 1
      : 0;
  let next = doc;
  roots.forEach((id, i) => {
    const delta =
      min +
      (max - min) * fraction -
      (boxes[i][start] + boxes[i][size] * fraction);
    next = translateWorld(
      next,
      [id],
      axis === "x" ? delta : 0,
      axis === "y" ? delta : 0,
    );
  });
  return next;
}
export function distribute(
  doc: PhotoDocument,
  ids: string[],
  bounds: Record<string, Bounds>,
  axis: "x" | "y",
) {
  const roots = selectionRoots(doc, ids);
  if (roots.length < 3)
    throw Error("Select at least three layers to distribute");
  const start = axis === "x" ? "left" : "top",
    size = axis === "x" ? "width" : "height";
  if (roots.some((id) => !bounds[id])) throw Error("Layer bounds unavailable");
  roots.sort((a, b) => bounds[a][start] - bounds[b][start]);
  const first = bounds[roots[0]],
    last = bounds[roots.at(-1)!];
  const gap =
    (last[start] +
      last[size] -
      first[start] -
      roots.reduce((sum, id) => sum + bounds[id][size], 0)) /
    (roots.length - 1);
  let cursor = first[start],
    next = doc;
  for (const id of roots) {
    const delta = cursor - bounds[id][start];
    next = translateWorld(
      next,
      [id],
      axis === "x" ? delta : 0,
      axis === "y" ? delta : 0,
    );
    cursor += bounds[id][size] + gap;
  }
  return next;
}
export function snapDelta(
  moving: Bounds,
  others: Bounds[],
  guides: { axis: "x" | "y"; position: number }[],
  options: {
    grid: boolean;
    guides: boolean;
    layers: boolean;
    step: number;
    zoom: number;
  },
) {
  const threshold = 6 / options.zoom;
  let dx = 0,
    dy = 0;
  for (const axis of ["x", "y"] as const) {
    const start = axis === "x" ? moving.left : moving.top,
      size = axis === "x" ? moving.width : moving.height;
    const probes = [start, start + size / 2, start + size];
    const targets: number[] = [];
    if (options.grid)
      targets.push(Math.round(start / options.step) * options.step);
    if (options.guides)
      targets.push(
        ...guides.filter((g) => g.axis === axis).map((g) => g.position),
      );
    if (options.layers)
      for (const b of others) {
        const p = axis === "x" ? b.left : b.top,
          s = axis === "x" ? b.width : b.height;
        targets.push(p, p + s / 2, p + s);
      }
    let best = threshold + 1;
    for (const p of probes)
      for (const t of targets)
        if (Math.abs(t - p) < Math.abs(best)) best = t - p;
    if (Math.abs(best) <= threshold) {
      if (axis === "x") dx = best;
      else dy = best;
    }
  }
  return { dx, dy };
}
