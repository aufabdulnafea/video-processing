import { env } from "./config/env";
import { createServer } from "./infrastructure/http/server";
import { logger } from "./infrastructure/logging/logger";
import { queueDepthGauge } from "./infrastructure/metrics/registry";
import { closeNats, connectNats } from "./infrastructure/nats/client";
import { createWorkerRedisClients, queueDepth, statusRedisClient } from "./infrastructure/queue/redis";
import { startOtel, stopOtel } from "./telemetry/otel";
import { NatsJobConsumer } from "./workers/nats-consumer";
import { RedisWorkerPool } from "./workers/redis-worker";

async function main(): Promise<void> {
  logger.info({ nodeEnv: env.NODE_ENV }, "Starting video-processing");

  startOtel();

  const natsConnected = await connectNats();
  const natsConsumer = new NatsJobConsumer();
  if (natsConnected) {
    await natsConsumer.start();
  } else {
    logger.warn("Starting without NATS -- cross-service job intake via NATS is disabled");
  }

  const workerPool = new RedisWorkerPool(createWorkerRedisClients(env.CONCURRENCY));
  workerPool.start();

  const queueDepthTimer = setInterval(() => {
    queueDepth()
      .then((depth) => queueDepthGauge.set(depth))
      .catch((err) => logger.warn({ err }, "Failed to sample queue depth"));
  }, 15_000);
  queueDepthTimer.unref();

  const server = createServer();

  logger.info(
    { port: server.port, queue: env.QUEUE_NAME, concurrency: env.CONCURRENCY, nats: natsConnected },
    "video-processing started",
  );

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "Shutting down gracefully");

    const shutdownTimer = setTimeout(() => {
      logger.error("Graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    shutdownTimer.unref();

    try {
      clearInterval(queueDepthTimer);
      server.stop();
      await natsConsumer.stop();
      await workerPool.stop();
      statusRedisClient.close();
      await closeNats();
      await stopOtel();

      logger.info("Shutdown complete");
      clearTimeout(shutdownTimer);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during graceful shutdown");
      clearTimeout(shutdownTimer);
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start video-processing");
  process.exit(1);
});
