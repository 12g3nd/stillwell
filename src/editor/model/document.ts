import { z } from "zod";
import {
  textStyleSchema,
  fontChoiceSchema,
  textPresetSchema,
  type TextStyle,
  type FontImport,
} from "./text";
import type { MaskSelection, MaskEdit, MaskBitmap, TrimBounds } from "./mask";
import type { Adjustments } from "./adjustments";
import type { PhotoFilter } from "./filters";
import type { Stroke } from "./strokes";
export const MAX_PIXELS = 24_000_000;
export type Matrix = [number, number, number, number, number, number];
export type Blend = "source-over" | "multiply" | "screen";
export interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  transform: Matrix;
  locked?: boolean;
  aspectLocked?: boolean;
  blend?: Blend;
}
export interface RasterLayer extends LayerBase {
  kind: "raster";
  original: string;
  asset: string;
  mask?: string;
}
export interface TextLayer extends LayerBase, TextStyle {
  kind: "text";
  text: string;
}
export interface GroupLayer extends LayerBase {
  kind: "group";
  children: Layer[];
}
export type Layer = RasterLayer | TextLayer | GroupLayer;
const id = z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  number = z.number().finite().min(-100000).max(100000);
const base = {
  id,
  name: z.string().min(1).max(200),
  visible: z.boolean(),
  opacity: z.number().min(0).max(1),
  transform: z.tuple([number, number, number, number, number, number]),
  locked: z.boolean().optional(),
  aspectLocked: z.boolean().optional(),
  blend: z.enum(["source-over", "multiply", "screen"]).optional(),
};
const layerSchema: z.ZodType<Layer> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      ...base,
      kind: z.literal("raster"),
      original: hash,
      asset: hash,
      mask: hash.optional(),
    }),
    z.object({
      ...base,
      ...textStyleSchema.shape,
      kind: z.literal("text"),
      text: z.string().max(10000),
    }),
    z.object({
      ...base,
      kind: z.literal("group"),
      children: z.array(layerSchema).min(1).max(30),
    }),
  ]),
);
const checkedDocumentSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    id,
    name: z.string().max(200),
    importNote: z.string().max(500).optional(),
    width: z.number().int().min(1).max(12000),
    height: z.number().int().min(1).max(12000),
    colourSpace: z.literal("srgb"),
    dpi: z.number().int().min(36).max(1200).optional(),
    border: z
      .object({
        width: z.number().int().min(0).max(2000),
        colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .optional(),
    layers: z.array(layerSchema).max(30),
    fontFavourites: z.array(fontChoiceSchema).max(30).optional(),
    textPresets: z.array(textPresetSchema).max(30).optional(),
    guides: z
      .array(z.object({ id, axis: z.enum(["x", "y"]), position: number }))
      .max(40)
      .optional(),
  })
  .superRefine((doc, ctx) => {
    const ids = new Set<string>();
    let count = 0,
      groups = 0;
    function visit(layers: Layer[], depth: number) {
      for (const l of layers) {
        count++;
        if (ids.has(l.id))
          ctx.addIssue({ code: "custom", message: "Layer IDs must be unique" });
        ids.add(l.id);
        if (
          Math.abs(
            l.transform[0] * l.transform[3] - l.transform[1] * l.transform[2],
          ) < 1e-8
        )
          ctx.addIssue({
            code: "custom",
            message: "Layer transforms must be invertible",
          });
        if (l.kind === "group") {
          groups++;
          if (depth >= 4)
            ctx.addIssue({
              code: "custom",
              message: "Groups are limited to four levels",
            });
          visit(l.children, depth + 1);
        }
      }
    }
    visit(doc.layers, 0);
    if (count > 30 || groups > 8)
      ctx.addIssue({
        code: "custom",
        message: "Limit: 30 layers, including at most 8 groups",
      });
    if (groups && doc.schemaVersion !== 2)
      ctx.addIssue({
        code: "custom",
        message: "Groups require document schema 2",
      });
    if (doc.width * doc.height > MAX_PIXELS)
      ctx.addIssue({
        code: "custom",
        message: "Canvas exceeds the 24 megapixel limit",
      });
    if (
      new Set(doc.guides?.map((g) => g.id)).size !== (doc.guides?.length ?? 0)
    )
      ctx.addIssue({ code: "custom", message: "Guide IDs must be unique" });
  });
export const documentSchema = z.preprocess((input, ctx) => {
  if (
    input &&
    typeof input === "object" &&
    "layers" in input &&
    Array.isArray(input.layers)
  ) {
    const stack = input.layers.map((layer) => ({ layer, depth: 0 }));
    let count = 0;
    const seen = new WeakSet<object>();
    while (stack.length) {
      const { layer, depth } = stack.pop()!;
      if (
        ++count > 30 ||
        depth > 4 ||
        (layer && typeof layer === "object" && seen.has(layer))
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "Layer tree exceeds its size/depth limit or contains a cycle",
        });
        return z.NEVER;
      }
      if (layer && typeof layer === "object") {
        seen.add(layer);
        if (layer.kind === "group" && Array.isArray(layer.children))
          for (const child of layer.children)
            stack.push({ layer: child, depth: depth + 1 });
      }
    }
  }
  return input;
}, checkedDocumentSchema);
export type PhotoDocument = z.infer<typeof documentSchema>;
export function flattenLayers(layers: Layer[]): Layer[] {
  return layers.flatMap((l) =>
    l.kind === "group" ? [l, ...flattenLayers(l.children)] : [l],
  );
}
export type ImportResult = {
  document: PhotoDocument;
  assets: Record<string, Uint8Array>;
};
export interface Bridge {
  strokeImage(
    id: string,
    stroke: Stroke,
  ): Promise<{
    hash: string;
    bytes: Uint8Array;
    maskHash?: string;
    mask?: Uint8Array;
  }>;
  newPaintLayer(): Promise<{ hash: string; bytes: Uint8Array }>;
  cancelStroke(): void;
  filterImage(
    id: string,
    settings: PhotoFilter,
  ): Promise<{ hash: string; bytes: Uint8Array }>;
  exportPdf(svg: string): Promise<boolean>;
  adjustImage(
    layerId: string,
    settings: Adjustments,
  ): Promise<{ hash: string; bytes: Uint8Array }>;
  checkpointPreview(id: string): Promise<ImportResult>;
  exportPortable(): Promise<boolean>;
  openPortable(): Promise<ImportResult | null>;
  shelfList(): Promise<RecentProject[]>;
  shelfRemove(id: string): Promise<void>;
  shelfSave(layerId: string, name: string): Promise<void>;
  shelfLoad(id: string): Promise<ImportResult>;
  textEditingActive(value: boolean): void;
  operationActive(value: boolean): void;
  importFont(): Promise<FontImport | null>;
  createSelection(
    layerId: string,
    selection: MaskSelection,
  ): Promise<MaskBitmap>;
  editMask(layerId: string, edit: MaskEdit): Promise<MaskBitmap>;
  trimBounds(bytes: Uint8Array): Promise<TrimBounds | null>;
  cancelMaskJob(): void;
  openImage(): Promise<ImportResult | null>;
  addImage(): Promise<ImportResult | null>;
  exportPng(bytes: Uint8Array, width: number, height: number): Promise<boolean>;
  importBytes(bytes: Uint8Array, name: string): Promise<ImportResult>;
  pasteImage(): Promise<ImportResult | null>;
  exportImage(
    bytes: Uint8Array,
    width: number,
    height: number,
    options: ExportOptions,
  ): Promise<boolean>;
  recent(): Promise<RecentProject[]>;
  loadProject(id: string): Promise<ImportResult & { recovered: boolean }>;
  saveProject(document: PhotoDocument, version: number): Promise<void>;
  markDirty(version: number): void;
  checkpoints(): Promise<CheckpointInfo[]>;
  checkpoint(name: string): Promise<void>;
  restoreCheckpoint(id: string): Promise<ImportResult>;
  revealLibrary(): Promise<void>;
  onClose(callback: () => void): () => void;
  closeReady(): void;
  previewActive(value: boolean): void;
}
export type ExportOptions = {
  dpi?: number;
  format: "png" | "jpeg" | "webp";
  quality: number;
  matte: string;
};
export type RecentProject = {
  id: string;
  name: string;
  width: number;
  height: number;
  updated: string;
  recovered: boolean;
};
export type CheckpointInfo = {
  kind?: "named" | "rolling";
  id: string;
  name: string;
  revision: string;
  created: string;
};
