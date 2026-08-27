import { z } from "zod";
import { env } from "../../config/env";
import type { VariantSpec } from "../../transcoder";

export const variantSpecSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/, "name must be alphanumeric (with - or _), max 32 chars"),
  targetMaxDimension: z.number().int().min(16).max(env.MAX_VARIANT_DIMENSION),
  bitrate: z.string().regex(/^\d{2,6}k$/, "bitrate must look like '2500k'"),
  bandwidth: z.number().int().positive().max(1_000_000_000),
}) satisfies z.ZodType<VariantSpec>;

export const s3RefSchema = z.object({
  bucket: z.string().min(1).max(255),
  key: z.string().min(1).max(1024),
});

export const s3OutputSchema = z.object({
  bucket: z.string().min(1).max(255),
  prefix: z.string().min(1).max(1024),
});

export const createJobRequestSchema = z.object({
  input: s3RefSchema,
  output: s3OutputSchema,
  customVariants: z.array(variantSpecSchema).max(env.MAX_CUSTOM_VARIANTS).optional(),
});

export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;

export const jobIdParamsSchema = z.object({
  jobId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/, "invalid job id"),
});
