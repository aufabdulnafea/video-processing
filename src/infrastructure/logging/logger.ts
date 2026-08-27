import pino from "pino";
import pinoPretty from "pino-pretty";
import { env } from "../../config/env";

const isDevelopment = env.NODE_ENV !== "production";

// Create the stream inline so Bun doesn't spawn worker threads
const stream = isDevelopment
  ? pinoPretty({
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
      singleLine: false,
      levelFirst: true,
      messageFormat: "{msg}",
    })
  : pino.destination(1); // Write directly to stdout in production

export const logger = pino(
  {
    level: env.LOG_LEVEL,
    base: {
      service: "video-processing",
      instanceId: env.INSTANCE_ID,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "*.password",
        "*.apiKey",
        "*.api_key",
        "*.token",
        "*.authorization",
        "*.headers.authorization",
        "req.headers.authorization",
        "*.accessKeyId",
        "*.secretAccessKey",
      ],
      censor: "[REDACTED]",
    },
  },
  stream,
);

export type Logger = typeof logger;

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
