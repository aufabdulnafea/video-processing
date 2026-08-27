import type { ConsumerMessages, JsMsg } from "@nats-io/jetstream";
import { createJobRequestSchema } from "../api/schemas/jobs";
import { getJetStream } from "../infrastructure/nats/client";
import { JOB_CONSUMER_DURABLE, VIDEO_JOBS_STREAM } from "../infrastructure/nats/subjects";
import { childLogger } from "../infrastructure/logging/logger";
import { jobsTotal, natsMessagesTotal } from "../infrastructure/metrics/registry";
import { enqueueJob, getJobStatus } from "../infrastructure/queue/redis";

const logger = childLogger({ component: "nats-consumer" });

/**
 * Lets other microservices submit transcode jobs over NATS instead of the REST API.
 * Accepted messages are pushed onto the same Redis queue the REST endpoint uses, so the
 * existing worker pool (workers/redis-worker.ts) handles both intake paths identically.
 */
export class NatsJobConsumer {
  private stopped = false;
  private consumerMessages: ConsumerMessages | null = null;

  async start(): Promise<void> {
    const js = getJetStream();
    if (!js) {
      logger.warn("NATS not connected -- skipping NATS job intake consumer");
      return;
    }

    const consumer = await js.consumers.get(VIDEO_JOBS_STREAM, JOB_CONSUMER_DURABLE);
    const messages = await consumer.consume();
    this.consumerMessages = messages;

    logger.info("NATS job intake consumer started");

    void (async () => {
      for await (const msg of messages) {
        if (this.stopped) break;
        await this.handleMessage(msg);
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.consumerMessages) {
      await this.consumerMessages.close();
    }
  }

  private async handleMessage(msg: JsMsg): Promise<void> {
    natsMessagesTotal.labels(msg.subject, "consume").inc();

    let parsed: ReturnType<typeof createJobRequestSchema.parse>;
    try {
      parsed = createJobRequestSchema.parse(JSON.parse(new TextDecoder().decode(msg.data)));
    } catch (err) {
      // Poison message: it can never parse successfully, so redelivering forever only
      // wastes the delivery budget. Terminate it immediately rather than retrying.
      logger.error({ err, subject: msg.subject }, "Dropping unparseable job-create message");
      msg.term();
      return;
    }

    // Derived from the stream sequence number rather than a fresh UUID: `seq` is stable
    // across redeliveries of the *same* message (e.g. if the ack is lost after we already
    // enqueued, JetStream redelivers it), so re-running this handler for a redelivery reuses
    // the same job id instead of enqueueing -- and transcoding -- the same input twice.
    const jobId = `nats-${msg.seq}`;
    const correlationId = msg.headers?.get("correlation-id") || undefined;

    try {
      const existing = await getJobStatus(jobId);
      if (existing) {
        logger.info({ jobId, status: existing.status }, "Redelivered NATS job already enqueued; skipping re-enqueue");
        msg.ack();
        return;
      }

      await enqueueJob({
        id: jobId,
        source: "nats",
        correlationId,
        input: parsed.input,
        output: parsed.output,
        customVariants: parsed.customVariants,
      });

      jobsTotal.labels("nats").inc();
      logger.info({ jobId, correlationId }, "Job enqueued via NATS");
      msg.ack();
    } catch (err) {
      logger.error({ err, jobId }, "Failed to enqueue NATS job; will redeliver");
      msg.nak(2_000);
    }
  }
}
