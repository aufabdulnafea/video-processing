import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "@prometheus-io/client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [registry],
});

export const jobsTotal = new Counter({
  name: "video_jobs_total",
  help: "Total transcode jobs accepted, labeled by intake source",
  labelNames: ["source"] as const,
  registers: [registry],
});

export const jobsSuccessTotal = new Counter({
  name: "video_jobs_success_total",
  help: "Total transcode jobs completed successfully",
  labelNames: ["source"] as const,
  registers: [registry],
});

export const jobsFailedTotal = new Counter({
  name: "video_jobs_failed_total",
  help: "Total transcode jobs that failed",
  labelNames: ["source"] as const,
  registers: [registry],
});

export const jobDurationSeconds = new Histogram({
  name: "video_job_duration_seconds",
  help: "Transcode job duration in seconds, from queue pickup to upload completion",
  labelNames: ["source"] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
  registers: [registry],
});

export const queueDepthGauge = new Gauge({
  name: "video_queue_depth",
  help: "Current depth of the Redis transcode job queue",
  registers: [registry],
});

export const natsMessagesTotal = new Counter({
  name: "nats_messages_total",
  help: "Total NATS messages published/consumed",
  labelNames: ["subject", "direction"] as const,
  registers: [registry],
});
