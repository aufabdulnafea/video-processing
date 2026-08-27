import { isNatsConnected } from "../../infrastructure/nats/client";
import { registry } from "../../infrastructure/metrics/registry";
import { statusRedisClient } from "../../infrastructure/queue/redis";
import { jsonResponse } from "../response";

const REDIS_HEALTH_CHECK_TIMEOUT_MS = 2_000;

/**
 * `RedisClient.ping()` has no built-in timeout -- against an unreachable host it can hang
 * indefinitely rather than rejecting, which would make `/ready` hang instead of reporting
 * not-ready. Race it against a timeout so readiness always fails fast.
 */
async function checkRedisHealth(): Promise<boolean> {
  try {
    await Promise.race([
      statusRedisClient.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Redis health check timed out")), REDIS_HEALTH_CHECK_TIMEOUT_MS),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** NATS is a supplementary dependency (see infrastructure/nats/client.ts), so `/ready` reflects it in the body but does not fail readiness on its own. */
export function buildHealthRoutes() {
  return {
    "/health": {
      GET: async () => jsonResponse(JSON.stringify({ status: "ok" }), 200),
    },
    "/ready": {
      GET: async () => {
        const redisOk = await checkRedisHealth();
        return jsonResponse(
          JSON.stringify({ status: redisOk ? "ready" : "not_ready", redis: redisOk, nats: isNatsConnected() }),
          redisOk ? 200 : 503,
        );
      },
    },
    "/metrics": {
      GET: async () => {
        const body = await registry.metrics();
        return new Response(body, { status: 200, headers: { "Content-Type": registry.contentType } });
      },
    },
  };
}
