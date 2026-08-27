import { getJetStream, isNatsConnected } from "../infrastructure/nats/client";
import { eventSubject } from "../infrastructure/nats/subjects";
import { natsMessagesTotal } from "../infrastructure/metrics/registry";
import { childLogger } from "../infrastructure/logging/logger";
import type { TranscodeJob } from "./envelope";

const logger = childLogger({ component: "job-publisher" });
const encoder = new TextEncoder();

export type JobEventStatus = "queued" | "processing" | "completed" | "failed";

/** Publishes a job lifecycle event; a no-op when NATS is unreachable. */
export async function publishJobEvent(
  status: JobEventStatus,
  job: TranscodeJob,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!isNatsConnected()) return;

  const js = getJetStream();
  if (!js) return;

  const subject = eventSubject(status);
  const payload = {
    jobId: job.id,
    status,
    source: job.source,
    correlationId: job.correlationId,
    output: job.output,
    timestamp: new Date().toISOString(),
    ...extra,
  };

  try {
    await js.publish(subject, encoder.encode(JSON.stringify(payload)));
    natsMessagesTotal.labels(subject, "publish").inc();
  } catch (err) {
    logger.warn({ err, subject, jobId: job.id }, "Failed to publish job event to NATS");
  }
}
