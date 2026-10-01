import { z } from "zod";
export const filterSchema = z.object({
  kind: z.enum(["mono", "sepia", "blur", "pixelate", "vignette"]),
  amount: z.number().finite().min(0).max(100),
  radius: z.number().int().min(1).max(64),
});
export type PhotoFilter = z.infer<typeof filterSchema>;
