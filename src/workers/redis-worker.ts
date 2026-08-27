import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RedisClient } from "bun";
import { env } from "../config/env";
import { childLogger, type Logger } from "../infrastructure/logging/logger";
import { jobDurationSeconds, jobsFailedTotal, jobsSuccessTotal } from "../infrastructure/metrics/registry";
import { setJobStatus } from "../infrastructure/queue/redis";
import { queueEnvelopeSchema, type TranscodeJob } from "../jobs/envelope";
import { publishJobEvent } from "../jobs/publisher";
import { downloadFromS3, uploadDirectoryToS3 } from "../s3";
import { withSpan } from "../telemetry/otel";
import { processVideoPipeline } from "../transcoder";

const logger = childLogger({ component: "redis-worker" });

/** BRPOP-driven worker pool: pulls jobs off the Redis queue and runs them through S3 download -> ffmpeg -> S3 upload, regardless of whether they were enqueued via REST or NATS. */
export class RedisWorkerPool {
  private shuttingDown = false;
  private pool: Promise<void>[] = [];

  constructor(private readonly clients: RedisClient[]) {}

  start(): void {
    this.shuttingDown = false;
    this.pool = this.clients.map((redis, index) =>
      this.runWorkerLoop(index, redis).catch((err) => {
        logger.fatal({ workerId: index, err }, "Worker terminated unexpectedly");
        process.exit(1);
      }),
    );
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;

    // Closing the blocked BRPOP connections unblocks each worker loop so it can observe
    // `shuttingDown` and exit instead of hanging forever.
    for (const redis of this.clients) redis.close();

    await Promise.allSettled(this.pool);
  }

  private async runWorkerLoop(workerId: number, redis: RedisClient): Promise<void> {
    const workerLogger = logger.child({ workerId });
    workerLogger.info({ queue: env.QUEUE_NAME }, "Transcoder worker started");

    while (!this.shuttingDown) {
      const job = await this.receiveJob(redis, workerLogger);
      if (!job) continue;
      await this.processJob(job, workerLogger.child({ jobId: job.id }));
    }

    workerLogger.info("Worker loop exited");
  }

  private async receiveJob(redis: RedisClient, workerLogger: Logger): Promise<TranscodeJob | null> {
    let result: [string, string] | null;

    try {
      result = await redis.brpop(env.QUEUE_NAME, 0);
    } catch (err) {
      if (this.shuttingDown) return null;

      workerLogger.error({ err }, "Worker loop failure");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return null;
    }

    if (!result) return null;

    const rawPayload = result[1];

    try {
      return queueEnvelopeSchema.parse(JSON.parse(rawPayload));
    } catch (err) {
      workerLogger.error({ err, rawPayloadPreview: rawPayload.slice(0, 200) }, "Discarding malformed job payload from queue");
      return null;
    }
  }

  private async processJob(job: TranscodeJob, jobLogger: Logger): Promise<void> {
    jobLogger.info("Job picked up from queue");

    const jobWorkingDir = join(env.TEMP_DIR, job.id);
    const inputFilePath = join(jobWorkingDir, "source_input");
    const hlsOutputDir = join(jobWorkingDir, "output_hls");

    const endTimer = jobDurationSeconds.startTimer({ source: job.source });
    const startedAt = performance.now();

    try {
      await setJobStatus(job.id, "processing");
      await publishJobEvent("processing", job);

      await mkdir(jobWorkingDir, { recursive: true });

      jobLogger.info({ bucket: job.input.bucket, key: job.input.key }, "Downloading source video");
      await downloadFromS3(job.input.bucket, job.input.key, inputFilePath);

      jobLogger.info("Starting FFmpeg transcoding");
      await withSpan("job.transcode", { "job.id": job.id, "job.source": job.source }, () =>
        processVideoPipeline({
          jobId: job.id,
          inputPath: inputFilePath,
          outputDir: hlsOutputDir,
          customVariants: job.customVariants,
        }),
      );

      jobLogger.info({ bucket: job.output.bucket, prefix: job.output.prefix }, "Uploading HLS output");
      await uploadDirectoryToS3(hlsOutputDir, job.output.bucket, job.output.prefix);

      const durationMs = Math.round(performance.now() - startedAt);
      const manifestUrl = `s3://${job.output.bucket}/${job.output.prefix}/master.m3u8`;

      await setJobStatus(job.id, "completed", { manifestUrl });
      await publishJobEvent("completed", job, { manifestUrl, durationMs });
      jobsSuccessTotal.labels(job.source).inc();

      jobLogger.info({ durationMs, output: job.output }, "Job completed successfully");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const durationMs = Math.round(performance.now() - startedAt);

      jobLogger.error({ err: error, durationMs }, "Transcoding pipeline failed");
      jobsFailedTotal.labels(job.source).inc();

      try {
        await setJobStatus(job.id, "failed", { error: error.message });
        await publishJobEvent("failed", job, { error: error.message });
      } catch (statusError) {
        jobLogger.error({ err: statusError }, "Failed to update job status");
      }
    } finally {
      endTimer();

      try {
        await rm(jobWorkingDir, { recursive: true, force: true });
        jobLogger.debug("Job working directory cleaned up");
      } catch (cleanupError) {
        jobLogger.warn({ err: cleanupError }, "Failed to clean up job working directory");
      }
    }
  }
}
