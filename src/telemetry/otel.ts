import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { trace, type Span, type Tracer } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { env } from "../config/env";
import { logger } from "../infrastructure/logging/logger";

/**
 * Deliberately minimal: no auto-instrumentation packages (would pull in a large dependency
 * tree we'd have to audit), just a tracer provider plus manual spans at the two boundaries
 * that matter most operationally -- HTTP requests and job processing (see
 * api/route-helper.ts / workers/redis-worker.ts). Fully inert unless `OTEL_ENABLED=true`.
 */
let sdk: NodeSDK | null = null;

export function startOtel(): void {
  if (!env.OTEL_ENABLED) return;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "video-processing",
      [ATTR_SERVICE_VERSION]: "1.0.0",
    }),
    traceExporter: new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT }),
  });
  sdk.start();
  logger.info("OpenTelemetry tracing enabled");
}

export async function stopOtel(): Promise<void> {
  if (sdk) await sdk.shutdown();
}

const noopTracer: Tracer = trace.getTracer("noop");

export function getTracer(): Tracer {
  return env.OTEL_ENABLED ? trace.getTracer("video-processing") : noopTracer;
}

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}
