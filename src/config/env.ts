import { z } from "zod";

/**
 * `z.coerce.boolean()` coerces via `Boolean(value)`, so the *string* "false" (as found in
 * any .env file) becomes `true` -- a classic footgun. This treats common falsy spellings
 * explicitly instead.
 */
const booleanFromEnv = z
  .string()
  .optional()
  .transform((v) => v !== undefined && ["true", "1", "yes"].includes(v.toLowerCase()));

/**
 * All configuration is validated once at process startup. If anything required is missing
 * or malformed, the process must fail fast rather than limp along with insecure defaults.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  HTTP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  INSTANCE_ID: z
    .string()
    .min(1)
    .default(() => `instance-${crypto.randomUUID().slice(0, 8)}`),

  REDIS_URL: z.string().default("redis://localhost:6379"),
  QUEUE_NAME: z.string().default("video-transcode"),

  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.string().optional(), // For MinIO/LocalStack/R2 support
  S3_FORCE_PATH_STYLE: booleanFromEnv,
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),

  // Shared secret required on every HTTP API request (Authorization: Bearer <key>).
  API_KEY: z.string().min(16, "API_KEY must be set to a random value of at least 16 characters"),

  // Number of jobs the worker pool processes concurrently.
  CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),

  TEMP_DIR: z.string().default("/tmp/transcoder"),

  // Hard resource ceilings, primarily to bound worst-case CPU/disk/memory usage per job.
  MAX_REQUEST_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(64 * 1024), // 64 KiB
  MAX_INPUT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024 * 1024), // 5 GiB
  MAX_CUSTOM_VARIANTS: z.coerce.number().int().min(1).max(20).default(6),
  MAX_VARIANT_DIMENSION: z.coerce.number().int().positive().default(2160), // 4K ceiling
  MAX_STORYBOARD_FRAMES: z.coerce.number().int().positive().default(500),
  FFPROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  FFMPEG_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000), // 30 minutes

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  // NATS is a supplementary transport for cross-service job intake/events -- not a hard
  // dependency of the transcoding pipeline (Redis + S3 are). See infrastructure/nats/client.ts.
  NATS_URL: z.string().min(1).default("nats://127.0.0.1:4222"),
  NATS_USER: z.string().optional(),
  NATS_PASSWORD: z.string().optional(),
  NATS_TLS: booleanFromEnv,

  CORS_ALLOWED_ORIGINS: z.string().default(""),

  OTEL_ENABLED: booleanFromEnv,
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export const corsAllowedOrigins = env.CORS_ALLOWED_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);
