import type { z } from "zod";
import { toAppError, ValidationError } from "../domain/errors";
import { childLogger } from "../infrastructure/logging/logger";
import { httpRequestDurationSeconds, httpRequestsTotal } from "../infrastructure/metrics/registry";
import { corsHeadersFor } from "../infrastructure/http/cors";
import { withSpan } from "../telemetry/otel";
import { authenticate } from "./middleware/auth";
import { errorBody, jsonResponse, successBody } from "./response";

const logger = childLogger({ component: "http" });

export interface RouteContext<TParams, TBody> {
  params: TParams;
  body: TBody;
  requestId: string;
}

export interface RouteResult {
  status: number;
  data?: unknown;
}

export interface RouteConfig<TParams, TBody> {
  /**
   * The route's registered path pattern (e.g. "/api/v1/jobs/:jobId"), used as the Prometheus
   * `route` label. Using the resolved `url.pathname` instead would mint a new label value
   * (and permanent time series) per job id, growing metric cardinality without bound.
   */
  routePattern: string;
  paramsSchema?: z.ZodType<TParams>;
  bodySchema?: z.ZodType<TBody>;
  handler: (ctx: RouteContext<TParams, TBody>) => Promise<RouteResult>;
}

function parseWith<T>(schema: z.ZodType<T> | undefined, value: unknown, label: string): T {
  if (!schema) return value as T;

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      `Invalid ${label}: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  return result.data;
}

/**
 * Wraps a handler with auth, request parsing/validation, a request-scoped span, structured
 * error mapping, and metrics -- every authenticated route (see api/routes/) goes through
 * this so those concerns live in exactly one place. Public routes (health/ready/metrics)
 * bypass this entirely and build their own `Response` directly.
 */
export function defineRoute<TParams = Record<string, string>, TBody = unknown>(config: RouteConfig<TParams, TBody>) {
  return async (req: Request & { params?: Record<string, string> }): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const url = new URL(req.url);
    const timer = httpRequestDurationSeconds.startTimer({ method: req.method, route: config.routePattern });
    let status = 500;

    try {
      authenticate(req);

      const params = parseWith(config.paramsSchema, req.params ?? {}, "path parameters");

      let rawBody: unknown;
      if (req.method !== "GET" && req.method !== "DELETE") {
        const text = await req.text();
        if (text.length > 0) {
          try {
            rawBody = JSON.parse(text);
          } catch {
            throw new ValidationError("Request body must be valid JSON");
          }
        }
      }
      const body = parseWith(config.bodySchema, rawBody, "request body");

      const result = await withSpan("http.request", { method: req.method, route: url.pathname, requestId }, () =>
        config.handler({ params, body, requestId }),
      );

      status = result.status;
      return jsonResponse(successBody(result.data ?? {}, requestId), result.status, {
        "X-Request-Id": requestId,
        ...corsHeadersFor(req),
      });
    } catch (err) {
      const appError = toAppError(err);
      status = appError.httpStatus;

      if (status >= 500) {
        logger.error({ err, requestId, path: url.pathname }, "Unhandled request error");
      } else {
        logger.warn({ requestId, path: url.pathname, code: appError.code }, appError.message);
      }

      return jsonResponse(errorBody(appError.code, appError.message, requestId), status, {
        "X-Request-Id": requestId,
        ...corsHeadersFor(req),
      });
    } finally {
      timer({ status: String(status) });
      httpRequestsTotal.labels(req.method, config.routePattern, String(status)).inc();
    }
  };
}
