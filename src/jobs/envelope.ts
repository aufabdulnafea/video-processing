import { z } from "zod";
import { s3OutputSchema, s3RefSchema, variantSpecSchema } from "../api/schemas/jobs";
import type { VariantSpec } from "../transcoder";

/** How a job entered the system -- used for metrics/event labeling only. */
export type JobSource = "rest" | "nats";

export interface TranscodeJob {
  id: string;
  source: JobSource;
  correlationId?: string;
  input: { bucket: string; key: string };
  output: { bucket: string; prefix: string };
  customVariants?: VariantSpec[];
}

/**
 * Payload shape on the Redis queue -- re-validated by the worker, not just at intake.
 * `id` isn't required to be a UUID: REST-originated jobs use one, but NATS-originated jobs
 * use a `nats-<streamSeq>` id instead (see workers/nats-consumer.ts) so redelivery of the
 * same JetStream message reuses the same job id rather than enqueueing a duplicate.
 */
export const queueEnvelopeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
  source: z.enum(["rest", "nats"]),
  correlationId: z.string().optional(),
  input: s3RefSchema,
  output: s3OutputSchema,
  customVariants: z.array(variantSpecSchema).optional(),
});
