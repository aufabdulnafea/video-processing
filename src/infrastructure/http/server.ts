import type { Server } from "bun";
import { buildHealthRoutes } from "../../api/routes/health";
import { buildJobRoutes } from "../../api/routes/jobs";
import { jsonResponse } from "../../api/response";
import { env } from "../../config/env";
import { childLogger } from "../logging/logger";
import { withCorsPreflight } from "./cors";

const logger = childLogger({ component: "http-server" });

export function createServer(): Server<undefined> {
  const routes: Record<string, Record<string, unknown>> = {
    ...buildHealthRoutes(),
    ...buildJobRoutes(),
  };

  const server = Bun.serve({
    port: env.PORT,
    idleTimeout: Math.ceil(env.HTTP_REQUEST_TIMEOUT_MS / 1000),
    maxRequestBodySize: env.MAX_REQUEST_BODY_BYTES,
    routes: withCorsPreflight(routes),
    fetch() {
      return jsonResponse(JSON.stringify({ error: { code: "NOT_FOUND", message: "No such route" } }), 404);
    },
    error(err) {
      logger.error({ err }, "Uncaught Bun.serve error");
      return jsonResponse(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }), 500);
    },
  });

  logger.info({ port: server.port }, `HTTP server listening on port ${server.port}`);
  return server;
}
