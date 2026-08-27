# video-processing

A microservice that transcodes uploaded video into adaptive-bitrate HLS (HTTP
Live Streaming): multiple resolution/bitrate variants, a hover-preview
storyboard sprite sheet + WebVTT cue file, and a master playlist — ready to
serve straight from S3-compatible object storage.

It exposes a small, versioned HTTP API for submitting and polling jobs, an
optional NATS JetStream transport so other microservices can submit jobs and
subscribe to job lifecycle events without going through REST, and a
background worker pool that pulls jobs off a Redis queue, downloads the
source from S3, runs the job through `ffmpeg`/`ffprobe`, and uploads the
result back to S3.

## Contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [Cross-service communication (NATS)](#cross-service-communication-nats)
- [Observability](#observability)
- [Output layout](#output-layout)
- [Running with Docker](#running-with-docker)
- [Development](#development)
- [CI/CD](#cicd)
- [Operational notes](#operational-notes)
- [License](#license)

## Architecture

```
      POST /api/v1/jobs          GET /api/v1/jobs/:id      video.jobs.create
             │                          │                   (other services)
             ▼                          ▼                          │
      ┌───────────────────────────────────────┐                   ▼
      │           HTTP API (Bun.serve)         │        ┌───────────────────┐
      └────────────────┬──────────┬────────────┘        │  NATS JetStream   │
                        │ LPUSH    │ HGETALL/HSET         │ (job intake +     │
                        ▼          ▲                      │  lifecycle events)│
                  ┌───────────────────┐                   └─────────┬─────────┘
                  │   Redis (queue +   │◄──────── LPUSH ─────────────┘
                  │   job status hash) │
                  └─────────┬──────────┘
                             │ BRPOP
                             ▼
              ┌──────────────────────────────┐    video.events.*
              │   Worker pool (CONCURRENCY)   │───────────────────► other services
              │  download → ffmpeg → upload   │    (via NATS)
              └──────┬────────────────┬───────┘
                     │                │
                     ▼                ▼
              S3 (source object)  S3 (HLS output)
```

- **`src/index.ts`** — composition root: starts OpenTelemetry, connects to
  NATS (best-effort), starts the Redis worker pool and the NATS job-intake
  consumer, starts the HTTP server, and wires graceful shutdown.
- **`src/api/`** — the versioned REST API: route definitions
  (`api/routes/`), Zod request schemas (`api/schemas/`), auth middleware
  (`api/middleware/`), and `route-helper.ts`'s `defineRoute()`, which every
  authenticated route goes through for parsing, auth, structured errors,
  tracing, and metrics.
- **`src/jobs/`** — the job envelope shared by both intake paths
  (`envelope.ts`) and the NATS event publisher (`publisher.ts`).
- **`src/workers/`** — `redis-worker.ts` (the BRPOP-driven pool that actually
  runs S3 download → `ffmpeg` → S3 upload) and `nats-consumer.ts` (a
  JetStream durable consumer that feeds the same Redis queue from
  `video.jobs.create` messages).
- **`src/transcoder.ts`** — the actual `ffmpeg`/`ffprobe` pipeline: metadata
  probing, variant selection, HLS encoding, storyboard generation, and master
  playlist authoring.
- **`src/s3.ts`** — streaming download/upload against any S3-compatible
  endpoint (AWS S3, Cloudflare R2, MinIO, LocalStack, ...).
- **`src/infrastructure/`** — Redis queue helpers, the NATS client, the
  Prometheus registry, and the raw `Bun.serve` HTTP server wiring.
- **`src/config/env.ts`** — the single source of truth for every environment
  variable, validated with `zod` at startup (the process refuses to start
  with an invalid or incomplete configuration).

One process runs the HTTP API, the NATS consumer, and the worker pool —
there's no separate "worker" deployment to manage. Scale by running more
replicas of the same image behind a load balancer, and/or raising
`CONCURRENCY`. NATS is a supplementary transport, not a hard dependency: if
it's unreachable at startup, the service logs a warning and keeps serving
REST + Redis normally.

## Requirements

| Tool                    | Version                           | Needed for                                                   |
| ----------------------- | --------------------------------- | ------------------------------------------------------------ |
| [Bun](https://bun.sh)   | `>= 1.4.0` (see `.bun-version`)   | running/building the service                                 |
| `ffmpeg` + `ffprobe`    | any recent build with libx264/aac | local (non-Docker) dev only — the Docker image bundles these |
| Redis                   | 6+                                | the job queue and job-status store                           |
| An S3-compatible bucket | —                                 | job input/output storage                                     |
| NATS (JetStream)        | 2.10+                             | optional — cross-service job intake/events, see below        |

Docker is not required for development — `bun src/index.ts` runs the whole
service directly, as long as `ffmpeg`/`ffprobe` are on `PATH` and Redis is
reachable. NATS is optional even then: if it's unreachable, the service logs
a warning and runs on REST + Redis alone.

## Quick start

```bash
bun install
cp .env.example .env
# edit .env: set API_KEY, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, S3_ENDPOINT, ...
bun run dev
```

The service refuses to boot if required configuration is missing — check the
zod error on startup if it exits immediately.

## Configuration

All configuration is environment variables, validated by `src/config/env.ts`.
`.env` is loaded automatically (Bun does this natively — no `dotenv`
dependency). See `.env.example` for a ready-to-copy template.

| Variable                      | Default                    | Description                                                                                                                                                                                                                                                                              |
| ----------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                    | `development`              | `production` switches logs to structured JSON; anything else uses pretty-printed logs.                                                                                                                                                                                                   |
| `PORT`                        | `3000`                     | HTTP listen port.                                                                                                                                                                                                                                                                        |
| `SHUTDOWN_TIMEOUT_MS`         | `15000`                    | Forces `process.exit(1)` if graceful shutdown hasn't finished within this long.                                                                                                                                                                                                          |
| `HTTP_REQUEST_TIMEOUT_MS`     | `30000`                    | `Bun.serve`'s idle timeout for in-flight requests.                                                                                                                                                                                                                                       |
| `INSTANCE_ID`                 | random                     | Included in every log line and the NATS connection name; useful for correlating logs/traces across replicas.                                                                                                                                                                             |
| `REDIS_URL`                   | `redis://localhost:6379`   | Redis connection string for the queue and job-status hash.                                                                                                                                                                                                                               |
| `QUEUE_NAME`                  | `video-transcode`          | Redis list key used as the job queue.                                                                                                                                                                                                                                                    |
| `S3_REGION`                   | `us-east-1`                | S3 region. Cloudflare R2 and most S3-compatible providers accept `auto`.                                                                                                                                                                                                                 |
| `S3_ENDPOINT`                 | _(unset → AWS S3)_         | Custom endpoint for R2 / MinIO / LocalStack / etc.                                                                                                                                                                                                                                       |
| `S3_FORCE_PATH_STYLE`         | `false`                    | Set `true` for providers that require path-style bucket addressing.                                                                                                                                                                                                                      |
| `AWS_ACCESS_KEY_ID`           | **required**               | S3 credentials.                                                                                                                                                                                                                                                                          |
| `AWS_SECRET_ACCESS_KEY`       | **required**               | S3 credentials.                                                                                                                                                                                                                                                                          |
| `API_KEY`                     | **required**, min 16 chars | Shared secret. Every request (except `/health`, `/ready`, `/metrics`) must send `Authorization: Bearer <API_KEY>`. Generate one with `openssl rand -hex 32`.                                                                                                                             |
| `CONCURRENCY`                 | `2`                        | Number of independent worker loops pulling from the queue in parallel (each on its own Redis connection). This bounds how many jobs run at once — raise it in step with available CPU/memory, since each job itself may spawn several parallel `ffmpeg` processes (one per HLS variant). |
| `TEMP_DIR`                    | `/tmp/transcoder`          | Scratch directory for in-flight jobs. Each job gets its own `TEMP_DIR/<jobId>` subdirectory, always cleaned up (success, failure, or crash-recovery on next start won't auto-clean stale dirs — see [Operational notes](#operational-notes)).                                            |
| `MAX_REQUEST_BODY_BYTES`      | `65536` (64 KiB)           | Hard cap on a `POST /api/v1/jobs` body (enforced by `Bun.serve`).                                                                                                                                                                                                                        |
| `MAX_INPUT_BYTES`             | `5368709120` (5 GiB)       | Hard cap on the source object size, checked via an S3 `HEAD` before downloading.                                                                                                                                                                                                         |
| `MAX_CUSTOM_VARIANTS`         | `6`                        | Max number of entries in a job's `customVariants` array.                                                                                                                                                                                                                                 |
| `MAX_VARIANT_DIMENSION`       | `2160`                     | Max allowed `targetMaxDimension` for a custom variant (4K ceiling).                                                                                                                                                                                                                      |
| `MAX_STORYBOARD_FRAMES`       | `500`                      | Caps the hover-storyboard frame count; the sampling interval widens automatically for very long videos instead of growing frame count unbounded.                                                                                                                                         |
| `FFPROBE_TIMEOUT_MS`          | `30000`                    | Kill `ffprobe` (SIGKILL) if metadata inspection hangs this long.                                                                                                                                                                                                                         |
| `FFMPEG_TIMEOUT_MS`           | `1800000` (30 min)         | Kill an `ffmpeg` invocation (SIGKILL) if it hangs this long — protects a worker slot from being wedged forever by one bad input.                                                                                                                                                         |
| `LOG_LEVEL`                   | `info`                     | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent` (pino levels).                                                                                                                                                                                                  |
| `NATS_URL`                    | `nats://127.0.0.1:4222`    | NATS server URL. See [Cross-service communication](#cross-service-communication-nats) — optional, the service degrades gracefully if unreachable.                                                                                                                                        |
| `NATS_USER` / `NATS_PASSWORD` | _(unset)_                  | NATS credentials, if the server requires auth.                                                                                                                                                                                                                                           |
| `NATS_TLS`                    | `false`                    | Set `true` to connect over TLS.                                                                                                                                                                                                                                                          |
| `CORS_ALLOWED_ORIGINS`        | _(empty → no CORS)_        | Comma-separated list of origins allowed to call the API from a browser.                                                                                                                                                                                                                  |
| `OTEL_ENABLED`                | `false`                    | Enables OpenTelemetry tracing — see [Observability](#observability).                                                                                                                                                                                                                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(unset)_                  | OTLP/HTTP trace collector endpoint. Required if `OTEL_ENABLED=true`.                                                                                                                                                                                                                     |

## HTTP API

Every endpoint under `/api/v1/` requires:

```
Authorization: Bearer <API_KEY>
```

Requests without it, or with the wrong key, get a `401` in the envelope
below. `/health`, `/ready`, and `/metrics` are public (no auth) — meant for
orchestrator probes and Prometheus scrapers, which can't always attach a
bearer token.

Every `/api/v1/` response is wrapped in a common envelope, and every
response carries an `X-Request-Id` header (also embedded in the body) for
correlating a request across logs/traces:

```json
// success
{ "data": { "...": "..." }, "requestId": "9c1e...uuid" }
// error
{ "error": { "code": "VALIDATION_ERROR", "message": "..." }, "requestId": "9c1e...uuid" }
```

### `GET /health`

Liveness check — always `200` if the process is up. No auth required (used
by the Docker `HEALTHCHECK` and orchestrator liveness probes).

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

### `GET /ready`

Readiness check — `200` only if Redis (the hard dependency) is reachable;
`503` otherwise. NATS is reported in the body but never fails readiness on
its own, since it's a supplementary transport (see below).

```bash
curl http://localhost:3000/ready
# {"status":"ready","redis":true,"nats":true}
```

### `GET /metrics`

Prometheus exposition format — see [Observability](#observability).

### `POST /api/v1/jobs`

Enqueues a transcode job. The job id is always generated server-side (a
client-supplied `id` is ignored) — this is deliberate, not an oversight: see
[Operational notes](#operational-notes). A job submitted here is queued
identically to one submitted over NATS (see below) — both feed the same
Redis queue and worker pool.

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input":  { "bucket": "my-bucket", "key": "uploads/source.mov" },
    "output": { "bucket": "my-bucket", "prefix": "processed/video-123" },
    "customVariants": [
      { "name": "720p", "targetMaxDimension": 720, "bitrate": "2500k", "bandwidth": 2800000 },
      { "name": "480p", "targetMaxDimension": 480, "bitrate": "1000k", "bandwidth": 1200000 }
    ]
  }'
```

```json
{ "data": { "jobId": "9c1e...uuid", "status": "queued" }, "requestId": "..." }
```

| Field                            | Required | Notes                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `input.bucket`, `input.key`      | yes      | Source object location.                                                                                                                                                                                                                                                                                                                                                                          |
| `output.bucket`, `output.prefix` | yes      | Where the HLS output tree is uploaded.                                                                                                                                                                                                                                                                                                                                                           |
| `customVariants`                 | no       | Overrides the default 1080p/720p/480p/360p ladder. Each entry: `name` (`^[a-zA-Z0-9_-]{1,32}$`), `targetMaxDimension` (16–`MAX_VARIANT_DIMENSION`), `bitrate` (e.g. `"2500k"`), `bandwidth` (bits/sec, used in the HLS manifest's `BANDWIDTH` attribute). Variants larger than the source are dropped automatically; if none fit, a single variant matching the source's own resolution is used. |

`targetMaxDimension` always caps the **longest** side of the frame, not
specifically height — for a landscape 16:9 source, a `720` variant is
720×404, not the conventional 1280×720. This matches how the pipeline also
handles portrait/vertical sources (where "720" should cap height, not width)
with one consistent rule.

Returns `400` (`VALIDATION_ERROR`) on invalid input, `413` if the body
exceeds `MAX_REQUEST_BODY_BYTES`.

### `GET /api/v1/jobs/:jobId`

```bash
curl http://localhost:3000/api/v1/jobs/9c1e...uuid -H "Authorization: Bearer $API_KEY"
```

```json
{
  "data": {
    "id": "9c1e...uuid",
    "status": "completed",
    "source": "rest",
    "createdAt": "2026-08-22T12:00:00.000Z",
    "updatedAt": "2026-08-22T12:00:42.000Z",
    "manifestUrl": "s3://my-bucket/processed/video-123/master.m3u8"
  },
  "requestId": "..."
}
```

`status` is one of `queued` → `processing` → `completed` | `failed`. A
`failed` job includes an `error` field. `source` is `rest` or `nats`,
reflecting how the job was submitted. `404` (`NOT_FOUND`) if the id is
unknown.

## Cross-service communication (NATS)

NATS JetStream lets other microservices in this stack submit transcode jobs
and observe their lifecycle without calling the REST API — useful for a
service that already talks to the rest of the system over NATS. It's
entirely optional: `NATS_URL` defaults to a local broker, and if it's
unreachable at startup this service logs a warning and keeps serving REST +
Redis normally (see `src/infrastructure/nats/client.ts`).

**Stream:** `VIDEO_JOBS` (created idempotently on startup if it doesn't
exist).

### Submitting a job: `video.jobs.create`

Publish the same JSON shape as `POST /api/v1/jobs`'s body to the
`video.jobs.create` subject. This service consumes it via a durable
JetStream consumer (`video-jobs-worker`) and pushes it onto the same Redis
queue the REST endpoint uses — one worker pool handles both intake paths
identically.

```ts
await js.publish(
  "video.jobs.create",
  encoder.encode(
    JSON.stringify({
      input: { bucket: "my-bucket", key: "uploads/source.mov" },
      output: { bucket: "my-bucket", prefix: "processed/video-123" },
    }),
  ),
);
```

There's no synchronous reply — the job id is generated server-side, so track
the job via the lifecycle events below (or poll `GET /api/v1/jobs/:jobId`
once you learn the id from a `queued` event).

### Job lifecycle events: `video.events.*`

Published by this service as a job moves through the pipeline:
`video.events.queued`, `.processing`, `.completed`, `.failed`. Payload:

```json
{
  "jobId": "9c1e...uuid",
  "status": "completed",
  "source": "nats",
  "output": { "bucket": "my-bucket", "prefix": "processed/video-123" },
  "timestamp": "2026-08-22T12:00:42.000Z",
  "manifestUrl": "s3://my-bucket/processed/video-123/master.m3u8",
  "durationMs": 41823
}
```

(`.failed` events carry `error` instead of `manifestUrl`/`durationMs`.)
Event publishing is best-effort: a NATS outage never fails or blocks the
transcoding pipeline itself.

## Observability

- **Structured logs** (`pino`) — JSON in production, pretty-printed in
  development, gated by `LOG_LEVEL`. Every line carries `service`,
  `instanceId`, and component bindings (`http`, `redis-worker`,
  `nats-consumer`, ...). Auth headers and credential-shaped fields are
  redacted (`src/infrastructure/logging/logger.ts`).
- **Prometheus metrics** at `GET /metrics`
  (`src/infrastructure/metrics/registry.ts`): Node/process defaults plus
  `http_requests_total`, `http_request_duration_seconds`, `video_jobs_total`,
  `video_jobs_success_total`, `video_jobs_failed_total` (all labeled by
  `source`: `rest` | `nats`), `video_job_duration_seconds`,
  `video_queue_depth` (sampled every 15s), and `nats_messages_total`.
- **OpenTelemetry tracing** (`src/telemetry/otel.ts`), off by default. Set
  `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT` to export spans over
  OTLP/HTTP. Deliberately minimal — no auto-instrumentation packages, just
  manual spans at the two boundaries that matter operationally: each HTTP
  request (`api/route-helper.ts`) and each job's transcode pipeline
  (`workers/redis-worker.ts`).

## Output layout

Uploaded to `output.bucket`/`output.prefix`:

```
<prefix>/
├── master.m3u8              # top-level HLS manifest (variant playlist)
├── thumbnails.vtt            # WebVTT cues pointing at storyboard sprites
├── storyboard/
│   ├── storyboard_001.jpg    # 5x5 tile sprite sheets
│   └── ...
├── 1080p/index.m3u8 + segment_*.ts
├── 720p/...
└── ...
```

## Running with Docker

```bash
docker compose up --build
```

This starts Redis, NATS, and the service together (`docker-compose.yml`),
reading S3/AWS/API_KEY config from `.docker.env`. The API is at
`http://localhost:3000`.

To build the image standalone:

```bash
docker build -t video-processing .
```

The image is a multi-stage build — see [Docker image](#docker-image) below
for what's actually in it and why.

### Docker image

The final image is plain `alpine` + `ffmpeg` + a standalone compiled binary —
**no Bun runtime ships in production**. `bun build --compile` bakes the app
and its runtime into a single executable at build time; the production stage
only ever needs that binary plus `ffmpeg`.

Notable choices, in case they need revisiting later:

- **Cross-compiled to musl explicitly** (`--target=bun-linux-$ARCH-musl`,
  arch selected from Docker's `TARGETARCH` build arg) instead of relying on
  `--compile`'s implicit target inference. This is what makes `gcompat`
  (glibc emulation on musl) unnecessary — verified by running the compiled
  binary on bare Alpine with only `libstdc++` present. Being explicit here
  also means a future change to the builder's base image (e.g. someone
  swapping it for a glibc-based image) fails loudly at build time instead of
  silently producing a binary the runtime stage can't load.
- **`bun install --production` in the discarded `deps` stage** — skips
  `biome`/`fallow`/`typescript`/`@types/*`, which `bun build --compile` never
  touches anyway. Doesn't change the shipped image (that never included
  `node_modules`), but takes the intermediate install from ~300MB to ~33MB,
  which speeds up builds and CI cache.
- **`--minify` on the compile step.** `--bytecode` was deliberately **not**
  added: it trades ~3MB of image size for faster cold starts, which mostly
  benefits short-lived CLI invocations — not a server process that starts
  once and runs indefinitely.
- **`ffmpeg`'s own dependency tree (not this Dockerfile) dominates image
  size** — its codec/container/filter libraries (h264, hevc, vp9, av1, opus,
  aac, ...) are what let uploads from real phones/cameras/browsers transcode
  correctly. Trimming that tree is a real usability risk (silently breaking
  some codec) for a small, inconsistent size win, so it's intentionally left
  as the stock Alpine `ffmpeg` package rather than a hand-picked minimal
  build or a third-party static binary (which would also mean losing
  Alpine's own security patching cadence for it).
- Runs as a non-root user (uid `10001`), uses `tini` as PID 1 for correct
  signal forwarding/zombie reaping into the app's own graceful-shutdown
  handling (see [Operational notes](#operational-notes)), and has a
  `HEALTHCHECK` against `/health`.

## Development

```bash
bun install          # install dependencies
bun run dev           # run the service (bun --hot works too for local iteration)
bun test              # unit tests (bun:test) — pure pipeline logic, no ffmpeg/Redis/S3/NATS needed
bun run typecheck      # tsc --noEmit
bun run lint           # biome check . (lint only -- formatting is Prettier's job, see below)
bun run format         # prettier --write .
bun run check          # biome check --write . + prettier --write . in one shot
bunx fallow            # dead code / duplication / complexity analysis
```

- **Biome** (`biome.json`) is lint-only here — its formatter and import-sort
  assist are both disabled. **Prettier** (`.prettierrc.json`: 130-char
  width, trailing commas, double quotes) owns formatting instead. `bun run
lint` / `bun run format` run each standalone; `bun run check` does both
  with fixes applied.
- **Fallow** (installed as a dev dependency) analyzes dead code, duplication,
  and complexity hotspots. `bunx fallow audit --base main` scopes it to just
  the files your branch changed.
- **Tests** (`tests/*.test.ts`) cover the pure, side-effect-free parts of the
  pipeline (metadata parsing, variant selection, dimension math, storyboard
  config) directly — they don't spin up ffmpeg, Redis, S3, or NATS, so they
  run fast and need no external services. They do still import
  `src/config/env.ts` transitively, so `API_KEY`/`AWS_ACCESS_KEY_ID`/
  `AWS_SECRET_ACCESS_KEY` must be set (any placeholder value works locally
  via `.env`; CI sets dummy ones explicitly). Every other new env var has a
  usable default, so no NATS/OTel setup is needed just to run the suite.

## CI/CD

`.github/workflows/ci.yml`, on every push to `main`/`v*` tags and every PR
into `main`:

1. **`test` job** — typecheck, `biome ci` (lint), `prettier --check` (format),
   `bun test`, a build sanity check, and (PRs only, non-blocking) `fallow
audit` scoped to the diff.
2. **`docker` job** (only after `test` passes) — builds the image on every
   PR (build-only, not pushed), and on pushes to `main`/`v*` tags, **builds
   and pushes to GHCR**
   (`ghcr.io/aufabdulnafea/video-processing`) using the repo's built-in
   `GITHUB_TOKEN` — no extra secrets to configure. Tags: short commit SHA,
   branch name, semver (for `v*` tags), and `latest` on the default branch.

## Operational notes

- **No client-supplied job IDs.** Neither `POST /api/v1/jobs` nor the NATS
  `video.jobs.create` intake accept a client-supplied id. A job id becomes
  part of a filesystem path (`TEMP_DIR/<jobId>`) that gets recursively
  deleted on job completion — accepting one from the request would allow
  path traversal into an arbitrary path the process can reach.
- **NATS is best-effort everywhere it touches.** A failed connection at
  startup, a publish failure for a lifecycle event, or the consumer being
  unavailable never fails a REST request or a worker's job processing —
  only `isNatsConnected()`/`/ready`'s `nats` field reflect its state.
- **Graceful shutdown.** `SIGTERM`/`SIGINT` stop the HTTP server, close the
  blocking Redis connections (unblocking each worker's `BRPOP` so it can
  exit its loop instead of hanging), and wait for in-flight workers to
  return before exiting. An in-progress job's `ffmpeg` children are not
  specially awaited — plan orchestrator/rolling-deploy grace periods
  accordingly for long transcodes.
- **No stale-tempdir sweep on startup.** A hard kill (`SIGKILL`, OOM, host
  crash) mid-job skips the working-directory cleanup in the `finally` block.
  `TEMP_DIR` is not currently swept on process start — if the service runs
  somewhere prone to hard kills, add an external cleanup (e.g. a tmpfiles
  rule or a cron) for directories older than `FFMPEG_TIMEOUT_MS` and unknown
  to Redis.
- **Scaling.** One process = one HTTP listener + `CONCURRENCY` worker loops.
  Horizontal scaling is running more replicas of the same image pointed at
  the same Redis; there's no leader election or per-replica coordination
  needed since `BRPOP` already fairly distributes queue items across
  connections.

## License

MIT — see [`LICENSE`](LICENSE).

Every package bundled into the compiled binary (`pino`, `pino-pretty`,
`zod`, the `@nats-io/*` clients, the `@opentelemetry/*` SDK, and
`@prometheus-io/client`, plus their full transitive dependency trees) is
MIT, ISC, BSD-3-Clause, or Apache-2.0; dev-only tooling (`biome`, `fallow`,
`typescript`, `prettier`) adds nothing further since none of it ships in the
built artifact. All of it is permissive and compatible with MIT.

The Docker image separately bundles `ffmpeg`, which Alpine builds with
`--enable-gpl` (GPL-licensed, via `libx264` and friends). It's invoked as an
external subprocess — never linked into the compiled binary — which is the
standard "mere aggregation" boundary that keeps this project's own MIT-licensed
source unaffected. The image itself is still, in effect, a GPL+MIT
aggregate: redistributing the _image_ means redistributing GPL-licensed
binaries alongside MIT-licensed ones, same as any other tool that ships
ffmpeg in a container.
