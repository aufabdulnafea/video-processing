import {
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager,
} from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { env } from "../../config/env";
import { childLogger } from "../logging/logger";
import { EVENTS_SUBJECT_PREFIX, JOB_CONSUMER_DURABLE, JOB_CREATE_SUBJECT, VIDEO_JOBS_STREAM } from "./subjects";

const logger = childLogger({ component: "nats-client" });

let connection: NatsConnection | null = null;
let jetStreamClient: JetStreamClient | null = null;
let jetStreamManager: JetStreamManager | null = null;

/**
 * NATS is a supplementary transport for cross-service job intake/events, not a hard
 * dependency of the transcoding pipeline (Redis + S3 are). A failed connection here is
 * logged and swallowed so the REST API and Redis worker pool stay fully functional.
 */
export async function connectNats(): Promise<boolean> {
  try {
    connection = await connect({
      servers: env.NATS_URL,
      user: env.NATS_USER,
      pass: env.NATS_PASSWORD,
      tls: env.NATS_TLS ? {} : undefined,
      name: `video-processing-${env.INSTANCE_ID}`,
      reconnect: true,
      maxReconnectAttempts: -1,
    });

    connection.closed().then((err) => {
      if (err) logger.error({ err }, "NATS connection closed with error");
      connection = null;
      jetStreamClient = null;
      jetStreamManager = null;
    });

    jetStreamClient = jetstream(connection);
    jetStreamManager = await jetstreamManager(connection);
    await ensureJetStreamTopology(jetStreamManager);

    logger.info({ url: env.NATS_URL }, "Connected to NATS");
    return true;
  } catch (err) {
    logger.error({ err, url: env.NATS_URL }, "Failed to connect to NATS -- continuing without it");
    connection = null;
    return false;
  }
}

/**
 * Idempotently ensures the durable stream + worker consumer exist. Safe to call on every
 * startup / every instance.
 *
 * Checks with `.info()` before creating rather than calling `.add()` and swallowing
 * whatever error comes back: a blind catch-all can't distinguish "already exists" (benign)
 * from a real failure (bad permissions, JetStream disabled, quota exceeded), so it would
 * silently leave the topology half-configured while logging as if everything were fine. Real
 * errors from `.add()` here are left to propagate to `connectNats`'s catch, which correctly
 * treats a failed NATS connection as "continue without it" rather than "pretend it worked".
 */
async function ensureJetStreamTopology(jsm: JetStreamManager): Promise<void> {
  const streamExists = await jsm.streams
    .info(VIDEO_JOBS_STREAM)
    .then(() => true)
    .catch(() => false);

  if (!streamExists) {
    await jsm.streams.add({
      name: VIDEO_JOBS_STREAM,
      subjects: [JOB_CREATE_SUBJECT, `${EVENTS_SUBJECT_PREFIX}.>`],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days, in nanoseconds
      num_replicas: 1,
    });
  }

  const consumerExists = await jsm.consumers
    .info(VIDEO_JOBS_STREAM, JOB_CONSUMER_DURABLE)
    .then(() => true)
    .catch(() => false);

  if (!consumerExists) {
    await jsm.consumers.add(VIDEO_JOBS_STREAM, {
      durable_name: JOB_CONSUMER_DURABLE,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      ack_wait: 60 * 1_000_000_000, // 60s, in nanoseconds
      filter_subject: JOB_CREATE_SUBJECT,
    });
  }
}

export async function closeNats(): Promise<void> {
  if (connection) {
    await connection.drain();
    connection = null;
    jetStreamClient = null;
    jetStreamManager = null;
  }
}

export function getJetStream(): JetStreamClient | null {
  return jetStreamClient;
}

export function isNatsConnected(): boolean {
  return connection !== null && !connection.isClosed();
}
