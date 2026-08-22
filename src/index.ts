import { RedisClient } from "bun";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import {
    downloadFromS3,
    uploadDirectoryToS3,
} from "./s3";
import {
    processVideoPipeline,
    type VariantSpec,
} from "./transcoder";
import { logger } from "./logger";

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

const redisClient = new RedisClient(config.REDIS_URL);
const redisWorkerClient = new RedisClient(config.REDIS_URL);

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

async function startWorker() {
    logger.info(
        {
            queue: config.QUEUE_NAME,
        },
        "Transcoder worker started",
    );

    while (true) {
        try {
            const result = await redisWorkerClient.brpop(
                config.QUEUE_NAME,
                0,
            );

            if (!result) {
                continue;
            }

            const rawPayload = result[1];
            const job: TranscodeJob = JSON.parse(rawPayload);

            // Create a child logger for this job.
            // Every subsequent log automatically contains jobId.
            const jobLogger = logger.child({
                jobId: job.id,
            });

            jobLogger.info(
                "Job picked up from queue",
            );

            const jobWorkingDir = join(
                config.TEMP_DIR,
                job.id,
            );

            const inputFilePath = join(
                jobWorkingDir,
                "source_input",
            );

            const hlsOutputDir = join(
                jobWorkingDir,
                "output_hls",
            );

            const startedAt = performance.now();

            try {
                await updateJobStatus(
                    job.id,
                    "processing",
                );

                await mkdir(
                    jobWorkingDir,
                    {
                        recursive: true,
                    },
                );

                jobLogger.info(
                    {
                        bucket: job.input.bucket,
                        key: job.input.key,
                    },
                    "Downloading source video",
                );

                await downloadFromS3(
                    job.input.bucket,
                    job.input.key,
                    inputFilePath,
                );

                jobLogger.info(
                    "Starting FFmpeg transcoding",
                );

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

                await uploadDirectoryToS3(
                    hlsOutputDir,
                    job.output.bucket,
                    job.output.prefix,
                );

                const durationMs =
                    Math.round(
                        performance.now() -
                        startedAt,
                    );

                await updateJobStatus(
                    job.id,
                    "completed",
                    {
                        manifestUrl:
                            `s3://${job.output.bucket}/${job.output.prefix}/master.m3u8`,
                    },
                );

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
                const error =
                    err instanceof Error
                        ? err
                        : new Error(String(err));

                const durationMs =
                    Math.round(
                        performance.now() -
                        startedAt,
                    );

                jobLogger.error(
                    {
                        err: error,
                        durationMs,
                    },
                    "Transcoding pipeline failed",
                );

                try {
                    await updateJobStatus(
                        job.id,
                        "failed",
                        {
                            error: error.message,
                        },
                    );
                } catch (statusError) {
                    jobLogger.error(
                        {
                            err:
                                statusError instanceof Error
                                    ? statusError
                                    : new Error(
                                        String(statusError),
                                    ),
                        },
                        "Failed to update job status",
                    );
                }
            } finally {
                try {
                    await rm(
                        jobWorkingDir,
                        {
                            recursive: true,
                            force: true,
                        },
                    );

                    jobLogger.debug(
                        "Job working directory cleaned up",
                    );
                } catch (cleanupError) {
                    jobLogger.warn(
                        {
                            err:
                                cleanupError instanceof Error
                                    ? cleanupError
                                    : new Error(
                                        String(cleanupError),
                                    ),
                        },
                        "Failed to clean up job working directory",
                    );
                }
            }
        } catch (loopErr) {
            logger.error(
                {
                    err:
                        loopErr instanceof Error
                            ? loopErr
                            : new Error(String(loopErr)),
                },
                "Worker loop failure",
            );

            await new Promise((resolve) =>
                setTimeout(resolve, 2000),
            );
        }
    }
}

/**
 * HTTP API
 */
const server = Bun.serve({
    port: parseInt(
        process.env.PORT || "3000",
        10,
    ),

    async fetch(req) {
        const url = new URL(req.url);

        /**
         * POST /jobs
         */
        if (
            req.method === "POST" &&
            url.pathname === "/jobs"
        ) {
            try {
                const body =
                    (await req.json()) as Partial<TranscodeJob>;

                if (
                    !body.input?.bucket ||
                    !body.input?.key ||
                    !body.output?.bucket ||
                    !body.output?.prefix
                ) {
                    logger.warn(
                        {
                            method: req.method,
                            path: url.pathname,
                        },
                        "Invalid job creation request",
                    );

                    return Response.json(
                        {
                            error:
                                "Missing required S3 parameters.",
                        },
                        {
                            status: 400,
                        },
                    );
                }

                const jobId =
                    body.id ||
                    crypto.randomUUID();

                const payload: TranscodeJob = {
                    id: jobId,
                    input: body.input,
                    output: body.output,
                    customVariants:
                        body.customVariants,
                };

                await redisClient.hset(
                    `job:${jobId}`,
                    {
                        id: jobId,
                        status: "queued",
                        createdAt:
                            new Date().toISOString(),
                    },
                );

                await redisClient.lpush(
                    config.QUEUE_NAME,
                    JSON.stringify(payload),
                );

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
                    {
                        status: 201,
                    },
                );
            } catch (err) {
                const error =
                    err instanceof Error
                        ? err
                        : new Error(String(err));

                logger.error(
                    {
                        err,
                        method: req.method,
                        path: url.pathname,
                    },
                    "Failed to enqueue job",
                );

                return Response.json(
                    {
                        error: error.message,
                    },
                    {
                        status: 500,
                    },
                );
            }
        }

        /**
         * GET /jobs/:id
         */
        if (
            req.method === "GET" &&
            url.pathname.startsWith("/jobs/")
        ) {
            const jobId =
                url.pathname.split("/")[2];

            const jobData =
                await redisClient.hgetall(
                    `job:${jobId}`,
                );

            if (
                !jobData ||
                Object.keys(jobData).length === 0
            ) {
                logger.debug(
                    {
                        jobId,
                    },
                    "Job not found",
                );

                return Response.json(
                    {
                        error: "Job not found",
                    },
                    {
                        status: 404,
                    },
                );
            }

            return Response.json(jobData);
        }

        logger.debug(
            {
                method: req.method,
                path: url.pathname,
            },
            "Route not found",
        );

        return Response.json(
            {
                error: "Route not found",
            },
            {
                status: 404,
            },
        );
    },
});

logger.info(
    {
        port: server.port,
        queue: config.QUEUE_NAME,
    },
    "HTTP API gateway started",
);

startWorker().catch((err) => {
    logger.fatal(
        {
            err:
                err instanceof Error
                    ? err
                    : new Error(String(err)),
        },
        "Worker terminated unexpectedly",
    );

    process.exit(1);
});