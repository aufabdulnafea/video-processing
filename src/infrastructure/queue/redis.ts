import { RedisClient } from "bun";
import { env } from "../../config/env";
import type { TranscodeJob } from "../../jobs/envelope";

/**
 * A dedicated connection for status/queue-depth reads and enqueues. Worker loops get their
 * own separate connections (see workers/redis-worker.ts) because BRPOP blocks the
 * connection it's issued on, and a client shared with hset/lpush calls would stall those
 * under load.
 */
export const statusRedisClient = new RedisClient(env.REDIS_URL);

export function createWorkerRedisClients(count: number): RedisClient[] {
  return Array.from({ length: count }, () => new RedisClient(env.REDIS_URL));
}

export type JobStatus = "queued" | "processing" | "completed" | "failed";

/**
 * Job status hashes are never otherwise deleted, so without a TTL they'd accumulate in Redis
 * forever. Refreshed on every write; a job's total lifetime (queued -> processing ->
 * terminal) is bounded by FFMPEG_TIMEOUT_MS, far shorter than this, so it never expires
 * out from under an in-flight job.
 */
const JOB_STATUS_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days, matching the NATS stream's retention

export async function setJobStatus(jobId: string, status: JobStatus, extra: Record<string, string> = {}): Promise<void> {
  const key = `job:${jobId}`;
  await statusRedisClient.hset(key, {
    status,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
  await statusRedisClient.expire(key, JOB_STATUS_TTL_SECONDS);
}

export async function getJobStatus(jobId: string): Promise<Record<string, string> | null> {
  const data = await statusRedisClient.hgetall(`job:${jobId}`);
  if (!data || Object.keys(data).length === 0) return null;
  return data;
}

export async function enqueueJob(job: TranscodeJob): Promise<void> {
  const key = `job:${job.id}`;
  await statusRedisClient.hset(key, {
    id: job.id,
    status: "queued",
    source: job.source,
    createdAt: new Date().toISOString(),
  });
  await statusRedisClient.expire(key, JOB_STATUS_TTL_SECONDS);

  await statusRedisClient.lpush(env.QUEUE_NAME, JSON.stringify(job));
}

export async function queueDepth(): Promise<number> {
  return statusRedisClient.llen(env.QUEUE_NAME);
}
