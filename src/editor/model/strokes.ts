import { z } from "zod";
import { pointSchema } from "./mask";
export const strokeSchema = z
  .object({
    kind: z.enum(["clone", "heal", "paint", "push", "pinch", "expand"]),
    points: z.array(pointSchema).min(1).max(1024),
    source: pointSchema.optional(),
    diameter: z.number().finite().min(1).max(256),
    hardness: z.number().finite().min(0).max(1),
    opacity: z.number().finite().min(0.01).max(1),
    colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .superRefine((s, ctx) => {
    if (s.kind === "clone" && !s.source)
      ctx.addIssue({ code: "custom", message: "Pick a clone source first" });
    if (s.kind === "heal" && s.points.length !== 1)
      ctx.addIssue({
        code: "custom",
        message: "Spot heal uses one click at a time",
      });
  });
export type Stroke = z.infer<typeof strokeSchema>;
