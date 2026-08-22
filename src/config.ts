import { z } from "zod";

const envSchema = z.object({
    NODE_ENV: z.string().default("development"),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    QUEUE_NAME: z.string().default("video-transcode"),
    S3_REGION: z.string().default("us-east-1"),
    S3_ENDPOINT: z.string().optional(), // For MinIO/LocalStack support
    S3_FORCE_PATH_STYLE: z
        .string()
        .transform((v) => v === "true")
        .default(false),
    AWS_ACCESS_KEY_ID: z.string(),
    AWS_SECRET_ACCESS_KEY: z.string(),

    // Shared secret required on every HTTP API request (Authorization: Bearer <key>).
    API_KEY: z
        .string()
        .min(16, "API_KEY must be set to a random value of at least 16 characters"),

    // Number of jobs the worker pool processes concurrently.
    CONCURRENCY: z
        .string()
        .transform((v) => parseInt(v, 10))
        .pipe(z.number().int().min(1).max(32))
        .default(2),

    TEMP_DIR: z.string().default("/tmp/transcoder"),

    // Hard resource ceilings, primarily to bound worst-case CPU/disk/memory usage per job.
    MAX_REQUEST_BODY_BYTES: z
        .string()
        .transform((v) => parseInt(v, 10))
        .pipe(z.number().int().positive())
        .default(64 * 1024), // 64 KiB is generous for a job payload
    MAX_INPUT_BYTES: z
        .string()
        .transform((v) => parseInt(v, 10))
        .pipe(z.number().int().positive())
        .default(5 * 1024 * 1024 * 1024), // 5 GiB
    MAX_CUSTOM_VARIANTS: z
        .string()
        .transform((v) => parseInt(v, 10))
        .pipe(z.number().int().min(1).max(20))
        .default(6),
    MAX_VARIANT_DIMENSION: z
        .string()
        .transform((v) => parseInt(v, 10))
        .pipe(z.number().int().positive())
        .default(2160), // 4K ceiling
    MAX_STORYBOARD_FRAMES: z
        .string()
        .transform((v) => parseInt(v, 10))
        .pipe(z.number().int().positive())
        .default(500),
    FFPROBE_TIMEOUT_MS: z
        .string()
        .transform((v) => parseInt(v, 10))
        .pipe(z.number().int().positive())
        .default(30_000),
    FFMPEG_TIMEOUT_MS: z
        .string()
        .transform((v) => parseInt(v, 10))
        .pipe(z.number().int().positive())
        .default(30 * 60 * 1000), // 30 minutes per ffmpeg invocation
});

export const config = envSchema.parse(process.env);
