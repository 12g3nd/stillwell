import { z } from "zod";
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const fontChoiceSchema = z.object({
  fontFamily: z.string().min(1).max(120),
  fontPostscript: z.string().min(1).max(200).optional(),
  fontAsset: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const textStyleSchema = fontChoiceSchema.extend({
  fontSize: z.number().min(1).max(1000),
  fill: colour,
  wrapWidth: z.number().min(20).max(12000).optional(),
  fontWeight: z.union([z.literal(400), z.literal(700)]).optional(),
  fontStyle: z.enum(["normal", "italic"]).optional(),
  underline: z.boolean().optional(),
  lineHeight: z.number().min(0.5).max(4).optional(),
  letterSpacing: z.number().min(-20).max(200).optional(),
  textAlign: z.enum(["left", "center", "right", "justify"]).optional(),
  curve: z.number().min(-100).max(100).optional(),
  warp: z
    .object({
      kind: z.enum(["wave", "bulge"]),
      amount: z.number().min(-100).max(100),
    })
    .optional(),
  backgroundColor: colour.optional(),
  stroke: colour.optional(),
  strokeWidth: z.number().min(0).max(30).optional(),
  shadow: z
    .object({
      color: colour,
      blur: z.number().min(0).max(100),
      offsetX: z.number().min(-100).max(100),
      offsetY: z.number().min(-100).max(100),
    })
    .optional(),
});
export type TextStyle = z.infer<typeof textStyleSchema>;
export type FontChoice = z.infer<typeof fontChoiceSchema>;
export const textPresetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  style: textStyleSchema,
});
export type TextPreset = z.infer<typeof textPresetSchema>;
export type FontImport = { font: FontChoice; bytes: Uint8Array };
