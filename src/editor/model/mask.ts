import { z } from "zod";
const coordinate = z.number().finite().min(-100000).max(100000);
export const pointSchema = z.object({ x: coordinate, y: coordinate });
export type PixelPoint = z.infer<typeof pointSchema>;
export const selectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["rectangle", "ellipse"]),
    start: pointSchema,
    end: pointSchema,
  }),
  z.object({
    kind: z.literal("polygon"),
    points: z.array(pointSchema).min(3).max(4096),
  }),
  z.object({
    kind: z.literal("brush"),
    points: z.array(pointSchema).min(1).max(4096),
    diameter: z.number().min(1).max(1000),
  }),
  z.object({
    kind: z.literal("wand"),
    point: pointSchema,
    tolerance: z.number().int().min(0).max(255),
    contiguous: z.boolean(),
  }),
]);
export type MaskSelection = z.infer<typeof selectionSchema>;
export const maskEditSchema = z
  .object({
    action: z.enum(["keep", "remove", "restore", "invert", "reset", "feather"]),
    selection: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    inverted: z.boolean().default(false),
    feather: z.number().finite().min(0).max(100).default(0),
  })
  .superRefine((v, ctx) => {
    if (["keep", "remove", "restore"].includes(v.action) && !v.selection)
      ctx.addIssue({ code: "custom", message: "Create a selection first" });
  });
export type MaskEdit = z.input<typeof maskEditSchema>;
export type MaskBitmap = {
  hash: string;
  bytes: Uint8Array;
  width: number;
  height: number;
};
export type TrimBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
