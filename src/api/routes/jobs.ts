import { childLogger } from "../../infrastructure/logging/logger";
import { jobsTotal } from "../../infrastructure/metrics/registry";
import { enqueueJob, getJobStatus } from "../../infrastructure/queue/redis";
import { NotFoundError } from "../../domain/errors";
import { defineRoute } from "../route-helper";
import { createJobRequestSchema, jobIdParamsSchema } from "../schemas/jobs";

const logger = childLogger({ component: "jobs-route" });

export function buildJobRoutes() {
  return {
    "/api/v1/jobs": {
      POST: defineRoute({
        routePattern: "/api/v1/jobs",
        bodySchema: createJobRequestSchema,
        handler: async ({ body, requestId }) => {
          // Job ids are always generated server-side. Trusting a client-supplied id
          // would let it be used to build the job's on-disk working directory
          // (see RedisWorkerPool.processJob), which is later recursively deleted --
          // an attacker could otherwise walk that path outside of TEMP_DIR entirely.
          const jobId = crypto.randomUUID();

          await enqueueJob({
            id: jobId,
            source: "rest",
            correlationId: requestId,
            input: body.input,
            output: body.output,
            customVariants: body.customVariants,
          });

          jobsTotal.labels("rest").inc();
          logger.info({ jobId, requestId }, "Job enqueued via REST");

          return { status: 202, data: { jobId, status: "queued" } };
        },
      }),
    },
    "/api/v1/jobs/:jobId": {
      GET: defineRoute({
        routePattern: "/api/v1/jobs/:jobId",
        paramsSchema: jobIdParamsSchema,
        handler: async ({ params }) => {
          const job = await getJobStatus(params.jobId);
          if (!job) throw new NotFoundError(`Job ${params.jobId} not found`);
          return { status: 200, data: job };
        },
      }),
    },
  };
}
