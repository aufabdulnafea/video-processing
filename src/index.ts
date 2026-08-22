import { timingSafeEqual } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { RedisClient } from "bun";
import { z } from "zod";
import { config } from "./config";
import { logger } from "./logger";
import { downloadFromS3, uploadDirectoryToS3 } from "./s3";
import { processVideoPipeline, type VariantSpec } from "./transcoder";

const variantSpecSchema = z.object({
    name: z
        .string()
        .regex(
            /^[a-zA-Z0-9_-]{1,32}$/,
            "name must be alphanumeric (with - or _), max 32 chars",
        ),
    targetMaxDimension: z.number().int().min(16).max(config.MAX_VARIANT_DIMENSION),
    bitrate: z.string().regex(/^\d{2,6}k$/, "bitrate must look like '2500k'"),
    bandwidth: z.number().int().positive().max(1_000_000_000),
}) satisfies z.ZodType<VariantSpec>;

const s3RefSchema = z.object({
    bucket: z.string().min(1).max(255),
    key: z.string().min(1).max(1024),
});

const s3OutputSchema = z.object({
    bucket: z.string().min(1).max(255),
    prefix: z.string().min(1).max(1024),
});

const createJobSchema = z.object({
    input: s3RefSchema,
    output: s3OutputSchema,
    customVariants: z.array(variantSpecSchema).max(config.MAX_CUSTOM_VARIANTS).optional(),
});

interface TranscodeJob {
    id: string;

    input: {
        bucket: string;
        key: string;
    };

    output: {
        bucket: string;
        prefix: string;
    };

    customVariants?: VariantSpec[];
}

const queueSchema = z.object({
    id: z.string().uuid(),
    input: s3RefSchema,
    output: s3OutputSchema,
    customVariants: z.array(variantSpecSchema).optional(),
});

/**
 * The HTTP API and the worker pool use separate Redis connections:
 * BRPOP blocks the connection it's issued on, so a client shared with
 * hset/lpush calls would stall those under load.
 */
const redisClient = new RedisClient(config.REDIS_URL);
const workerRedisClients: RedisClient[] = Array.from(
    { length: config.CONCURRENCY },
    () => new RedisClient(config.REDIS_URL),
);

let shuttingDown = false;

type Logger = typeof logger;

async function updateJobStatus(
    jobId: string,
    status: "processing" | "completed" | "failed",
    extra: Record<string, string> = {},
) {
    const fields: Record<string, string> = {
        status,
        updatedAt: new Date().toISOString(),
        ...extra,
    };

    await redisClient.hset(`job:${jobId}`, fields);
}

function isAuthorized(req: Request): boolean {
    const header = req.headers.get("authorization") ?? "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
        return false;
    }

    const expected = Buffer.from(config.API_KEY);
    const actual = Buffer.from(token);

    // Reject unequal-length inputs before timingSafeEqual, which throws on
    // mismatched buffer lengths rather than returning false.
    if (actual.length !== expected.length) {
        return false;
    }

    return timingSafeEqual(actual, expected);
}

/**
 * Blocks on the queue for one job. Returns null on a transient redis error,
 * an empty pop, or a payload that fails schema validation -- in every case
 * the caller should just loop around and try again.
 */
async function receiveJob(
    redis: RedisClient,
    workerLogger: Logger,
): Promise<TranscodeJob | null> {
    let result: [string, string] | null;

    try {
        result = await redis.brpop(config.QUEUE_NAME, 0);
    } catch (err) {
        if (shuttingDown) {
            return null;
        }

        workerLogger.error(
            {
                err: err instanceof Error ? err : new Error(String(err)),
            },
            "Worker loop failure",
        );

        await new Promise((resolve) => setTimeout(resolve, 2000));
        return null;
    }

    if (!result) {
        return null;
    }

    const rawPayload = result[1];

    try {
        return queueSchema.parse(JSON.parse(rawPayload));
    } catch (err) {
        workerLogger.error(
            {
                err: err instanceof Error ? err : new Error(String(err)),
                rawPayloadPreview: rawPayload.slice(0, 200),
            },
            "Discarding malformed job payload from queue",
        );

        return null;
    }
}

/**
 * Downloads, transcodes, and uploads a single job, updating its Redis status
 * throughout and always cleaning up its working directory afterwards.
 */
async function processJob(job: TranscodeJob, jobLogger: Logger): Promise<void> {
    jobLogger.info("Job picked up from queue");

    const jobWorkingDir = join(config.TEMP_DIR, job.id);
    const inputFilePath = join(jobWorkingDir, "source_input");
    const hlsOutputDir = join(jobWorkingDir, "output_hls");

    const startedAt = performance.now();

    try {
        await updateJobStatus(job.id, "processing");

        await mkdir(jobWorkingDir, { recursive: true });

        jobLogger.info(
            {
                bucket: job.input.bucket,
                key: job.input.key,
            },
            "Downloading source video",
        );

        await downloadFromS3(job.input.bucket, job.input.key, inputFilePath);

        jobLogger.info("Starting FFmpeg transcoding");

        await processVideoPipeline({
            jobId: job.id,
            inputPath: inputFilePath,
            outputDir: hlsOutputDir,
            customVariants: job.customVariants,
        });

        jobLogger.info(
            {
                bucket: job.output.bucket,
                prefix: job.output.prefix,
            },
            "Uploading HLS output",
        );

        await uploadDirectoryToS3(hlsOutputDir, job.output.bucket, job.output.prefix);

        const durationMs = Math.round(performance.now() - startedAt);

        await updateJobStatus(job.id, "completed", {
            manifestUrl: `s3://${job.output.bucket}/${job.output.prefix}/master.m3u8`,
        });

        jobLogger.info(
            {
                durationMs,
                output: {
                    bucket: job.output.bucket,
                    prefix: job.output.prefix,
                },
            },
            "Job completed successfully",
        );
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));

        const durationMs = Math.round(performance.now() - startedAt);

        jobLogger.error(
            {
                err: error,
                durationMs,
            },
            "Transcoding pipeline failed",
        );

        try {
            await updateJobStatus(job.id, "failed", {
                error: error.message,
            });
        } catch (statusError) {
            jobLogger.error(
                {
                    err:
                        statusError instanceof Error
                            ? statusError
                            : new Error(String(statusError)),
                },
                "Failed to update job status",
            );
        }
    } finally {
        try {
            await rm(jobWorkingDir, {
                recursive: true,
                force: true,
            });

            jobLogger.debug("Job working directory cleaned up");
        } catch (cleanupError) {
            jobLogger.warn(
                {
                    err:
                        cleanupError instanceof Error
                            ? cleanupError
                            : new Error(String(cleanupError)),
                },
                "Failed to clean up job working directory",
            );
        }
    }
}

async function startWorker(workerId: number, redis: RedisClient) {
    const workerLogger = logger.child({ workerId });

    workerLogger.info(
        {
            queue: config.QUEUE_NAME,
        },
        "Transcoder worker started",
    );

    while (!shuttingDown) {
        const job = await receiveJob(redis, workerLogger);

        if (!job) {
            continue;
        }

        await processJob(job, workerLogger.child({ jobId: job.id }));
    }

    workerLogger.info("Worker loop exited");
}

async function handleHealthCheck(): Promise<Response> {
    try {
        await redisClient.ping();
        return Response.json({ status: "ok" });
    } catch (err) {
        logger.error(
            {
                err: err instanceof Error ? err : new Error(String(err)),
            },
            "Health check failed",
        );

        return Response.json({ status: "error" }, { status: 503 });
    }
}

async function handleCreateJob(req: Request, url: URL): Promise<Response> {
    const contentLength = Number(req.headers.get("content-length") ?? "0");

    if (contentLength > config.MAX_REQUEST_BODY_BYTES) {
        return Response.json({ error: "Request body too large" }, { status: 413 });
    }

    try {
        const rawBody = await req.json();
        const parsed = createJobSchema.safeParse(rawBody);

        if (!parsed.success) {
            logger.warn(
                {
                    method: req.method,
                    path: url.pathname,
                    issues: parsed.error.issues,
                },
                "Invalid job creation request",
            );

            return Response.json(
                {
                    error: "Invalid request body",
                    issues: parsed.error.issues,
                },
                { status: 400 },
            );
        }

        // Job ids are always generated server-side. Trusting a
        // client-supplied id here would let it be used to build the
        // job's on-disk working directory (see `processJob`'s
        // `jobWorkingDir`), which is later recursively deleted -- an
        // attacker supplying something like "../../etc" could otherwise walk
        // that path outside of TEMP_DIR entirely.
        const jobId = crypto.randomUUID();

        const payload: TranscodeJob = {
            id: jobId,
            input: parsed.data.input,
            output: parsed.data.output,
            customVariants: parsed.data.customVariants,
        };

        await redisClient.hset(`job:${jobId}`, {
            id: jobId,
            status: "queued",
            createdAt: new Date().toISOString(),
        });

        await redisClient.lpush(config.QUEUE_NAME, JSON.stringify(payload));

        logger.info(
            {
                jobId,
                queue: config.QUEUE_NAME,
            },
            "Job enqueued",
        );

        return Response.json(
            {
                jobId,
                status: "queued",
            },
            { status: 201 },
        );
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));

        logger.error(
            {
                err,
                method: req.method,
                path: url.pathname,
            },
            "Failed to enqueue job",
        );

        return Response.json({ error: error.message }, { status: 500 });
    }
}

async function handleGetJob(jobId: string | undefined): Promise<Response> {
    if (!jobId || !/^[a-zA-Z0-9-]{1,64}$/.test(jobId)) {
        return Response.json({ error: "Job not found" }, { status: 404 });
    }

    const jobData = await redisClient.hgetall(`job:${jobId}`);

    if (!jobData || Object.keys(jobData).length === 0) {
        logger.debug({ jobId }, "Job not found");

        return Response.json({ error: "Job not found" }, { status: 404 });
    }

    return Response.json(jobData);
}

/**
 * HTTP API
 */
const server = Bun.serve({
    port: parseInt(process.env.PORT || "3000", 10),

    async fetch(req) {
        const url = new URL(req.url);

        if (req.method === "GET" && url.pathname === "/health") {
            return handleHealthCheck();
        }

        if (!isAuthorized(req)) {
            logger.warn(
                {
                    method: req.method,
                    path: url.pathname,
                },
                "Unauthorized request rejected",
            );

            return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        if (req.method === "POST" && url.pathname === "/jobs") {
            return handleCreateJob(req, url);
        }

        if (req.method === "GET" && url.pathname.startsWith("/jobs/")) {
            return handleGetJob(url.pathname.split("/")[2]);
        }

        logger.debug(
            {
                method: req.method,
                path: url.pathname,
            },
            "Route not found",
        );

        return Response.json({ error: "Route not found" }, { status: 404 });
    },
});

logger.info(
    {
        port: server.port,
        queue: config.QUEUE_NAME,
        concurrency: config.CONCURRENCY,
    },
    "HTTP API gateway started",
);

const workerPool = workerRedisClients.map((redis, index) =>
    startWorker(index, redis).catch((err) => {
        logger.fatal(
            {
                workerId: index,
                err: err instanceof Error ? err : new Error(String(err)),
            },
            "Worker terminated unexpectedly",
        );

        process.exit(1);
    }),
);

async function shutdown(signal: string) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    logger.info({ signal }, "Shutting down gracefully");

    server.stop();

    // Closing the blocked BRPOP connections unblocks each worker loop so it
    // can observe `shuttingDown` and exit instead of hanging forever.
    for (const redis of workerRedisClients) {
        redis.close();
    }

    await Promise.allSettled(workerPool);

    redisClient.close();

    logger.info("Shutdown complete");

    process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
