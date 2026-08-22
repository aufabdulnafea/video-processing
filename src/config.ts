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
    CONCURRENCY: z
        .string()
        .transform((v) => parseInt(v, 10))
        .default(2),
    TEMP_DIR: z.string().default("/tmp/transcoder"),
});

export const config = envSchema.parse(process.env);
