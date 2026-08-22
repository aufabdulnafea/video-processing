# video-processing

A microservice that transcodes uploaded video into adaptive-bitrate HLS (HTTP
Live Streaming): multiple resolution/bitrate variants, a hover-preview
storyboard sprite sheet + WebVTT cue file, and a master playlist — ready to
serve straight from S3-compatible object storage.

It exposes a small HTTP API for submitting and polling jobs, and a background
worker pool that pulls jobs off a Redis queue, downloads the source from S3,
runs the job through `ffmpeg`/`ffprobe`, and uploads the result back to S3.

## Contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [Output layout](#output-layout)
- [Running with Docker](#running-with-docker)
- [Development](#development)
- [CI/CD](#cicd)
- [Operational notes](#operational-notes)
- [License](#license)

## Architecture

```
                 POST /jobs                 GET /jobs/:id
                      │                           │
                      ▼                           ▼
                ┌─────────────────────────────────────┐
                │         HTTP API (Bun.serve)         │
                └───────────────┬─────────┬────────────┘
                                │ LPUSH   │ HGETALL/HSET
                                ▼         ▲
                          ┌───────────────────┐
                          │   Redis (queue +   │
                          │   job status hash) │
                          └─────────┬──────────┘
                                    │ BRPOP
                                    ▼
                     ┌──────────────────────────────┐
                     │   Worker pool (CONCURRENCY)   │
                     │  download → ffmpeg → upload   │
                     └──────┬────────────────┬───────┘
                            │                │
                            ▼                ▼
                     S3 (source object)  S3 (HLS output)
```

- **`src/index.ts`** — the HTTP API (`/health`, `/jobs`, `/jobs/:id`) and the
  worker pool that consumes the Redis queue.
- **`src/transcoder.ts`** — the actual `ffmpeg`/`ffprobe` pipeline: metadata
  probing, variant selection, HLS encoding, storyboard generation, and master
  playlist authoring.
- **`src/s3.ts`** — streaming download/upload against any S3-compatible
  endpoint (AWS S3, Cloudflare R2, MinIO, LocalStack, ...).
- **`src/config.ts`** — the single source of truth for every environment
  variable, validated with `zod` at startup (the process refuses to start
  with an invalid or incomplete configuration).

One process runs both the HTTP API and the worker pool — there's no separate
"worker" deployment to manage. Scale by running more replicas of the same
image behind a load balancer, and/or raising `CONCURRENCY`.

## Requirements

| Tool | Version | Needed for |
|---|---|---|
| [Bun](https://bun.sh) | `>= 1.4.0` (see `.bun-version`) | running/building the service |
| `ffmpeg` + `ffprobe` | any recent build with libx264/aac | local (non-Docker) dev only — the Docker image bundles these |
| Redis | 6+ | the job queue and job-status store |
| An S3-compatible bucket | — | job input/output storage |

Docker is not required for development — `bun src/index.ts` runs the whole
service directly, as long as `ffmpeg`/`ffprobe` are on `PATH` and Redis is
reachable.

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

All configuration is environment variables, validated by `src/config.ts`.
`.env` is loaded automatically (Bun does this natively — no `dotenv`
dependency). See `.env.example` for a ready-to-copy template.

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `production` switches logs to structured JSON; anything else uses pretty-printed logs. |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string for the queue and job-status hash. |
| `QUEUE_NAME` | `video-transcode` | Redis list key used as the job queue. |
| `S3_REGION` | `us-east-1` | S3 region. Cloudflare R2 and most S3-compatible providers accept `auto`. |
| `S3_ENDPOINT` | _(unset → AWS S3)_ | Custom endpoint for R2 / MinIO / LocalStack / etc. |
| `S3_FORCE_PATH_STYLE` | `false` | Set `true` for providers that require path-style bucket addressing. |
| `AWS_ACCESS_KEY_ID` | **required** | S3 credentials. |
| `AWS_SECRET_ACCESS_KEY` | **required** | S3 credentials. |
| `API_KEY` | **required**, min 16 chars | Shared secret. Every request (except `/health`) must send `Authorization: Bearer <API_KEY>`. Generate one with `openssl rand -hex 32`. |
| `CONCURRENCY` | `2` | Number of independent worker loops pulling from the queue in parallel (each on its own Redis connection). This bounds how many jobs run at once — raise it in step with available CPU/memory, since each job itself may spawn several parallel `ffmpeg` processes (one per HLS variant). |
| `TEMP_DIR` | `/tmp/transcoder` | Scratch directory for in-flight jobs. Each job gets its own `TEMP_DIR/<jobId>` subdirectory, always cleaned up (success, failure, or crash-recovery on next start won't auto-clean stale dirs — see [Operational notes](#operational-notes)). |
| `MAX_REQUEST_BODY_BYTES` | `65536` (64 KiB) | Hard cap on a `POST /jobs` body. |
| `MAX_INPUT_BYTES` | `5368709120` (5 GiB) | Hard cap on the source object size, checked via an S3 `HEAD` before downloading. |
| `MAX_CUSTOM_VARIANTS` | `6` | Max number of entries in a job's `customVariants` array. |
| `MAX_VARIANT_DIMENSION` | `2160` | Max allowed `targetMaxDimension` for a custom variant (4K ceiling). |
| `MAX_STORYBOARD_FRAMES` | `500` | Caps the hover-storyboard frame count; the sampling interval widens automatically for very long videos instead of growing frame count unbounded. |
| `FFPROBE_TIMEOUT_MS` | `30000` | Kill `ffprobe` (SIGKILL) if metadata inspection hangs this long. |
| `FFMPEG_TIMEOUT_MS` | `1800000` (30 min) | Kill an `ffmpeg` invocation (SIGKILL) if it hangs this long — protects a worker slot from being wedged forever by one bad input. |

`PORT` (plain `process.env`, not part of the validated schema) sets the HTTP
listen port, default `3000`.

## HTTP API

Every endpoint except `/health` requires:

```
Authorization: Bearer <API_KEY>
```

Requests without it, or with the wrong key, get `401 Unauthorized`.

### `GET /health`

Liveness/readiness check — pings Redis. No auth required (used by the Docker
`HEALTHCHECK` and orchestrator probes).

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

### `POST /jobs`

Enqueues a transcode job. The job id is always generated server-side (a
client-supplied `id` is ignored) — this is deliberate, not an oversight: see
[Operational notes](#operational-notes).

```bash
curl -X POST http://localhost:3000/jobs \
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
{ "jobId": "9c1e...uuid", "status": "queued" }
```

| Field | Required | Notes |
|---|---|---|
| `input.bucket`, `input.key` | yes | Source object location. |
| `output.bucket`, `output.prefix` | yes | Where the HLS output tree is uploaded. |
| `customVariants` | no | Overrides the default 1080p/720p/480p/360p ladder. Each entry: `name` (`^[a-zA-Z0-9_-]{1,32}$`), `targetMaxDimension` (16–`MAX_VARIANT_DIMENSION`), `bitrate` (e.g. `"2500k"`), `bandwidth` (bits/sec, used in the HLS manifest's `BANDWIDTH` attribute). Variants larger than the source are dropped automatically; if none fit, a single variant matching the source's own resolution is used. |

`targetMaxDimension` always caps the **longest** side of the frame, not
specifically height — for a landscape 16:9 source, a `720` variant is
720×404, not the conventional 1280×720. This matches how the pipeline also
handles portrait/vertical sources (where "720" should cap height, not width)
with one consistent rule.

Returns `400` with a zod issue list on invalid input, `413` if the body
exceeds `MAX_REQUEST_BODY_BYTES`.

### `GET /jobs/:id`

```bash
curl http://localhost:3000/jobs/9c1e...uuid -H "Authorization: Bearer $API_KEY"
```

```json
{
  "id": "9c1e...uuid",
  "status": "completed",
  "createdAt": "2026-08-22T12:00:00.000Z",
  "updatedAt": "2026-08-22T12:00:42.000Z",
  "manifestUrl": "s3://my-bucket/processed/video-123/master.m3u8"
}
```

`status` is one of `queued` → `processing` → `completed` | `failed`. A
`failed` job includes an `error` field. `404` if the id is unknown.

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

This starts Redis and the service together (`docker-compose.yml`), reading
S3/AWS/API_KEY config from `.docker.env`. The API is at `http://localhost:3000`.

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
bun test              # unit tests (bun:test) — pure pipeline logic, no ffmpeg/Redis/S3 needed
bun run typecheck      # tsc --noEmit
bun run check          # biome: lint + format + import sort, writes fixes
bunx fallow            # dead code / duplication / complexity analysis
```

- **Biome** (`biome.json`) is the linter/formatter — 4-space indent, double
  quotes, import sorting on save. `bun run lint` / `bun run format` run it
  standalone; `bun run check` does both plus safe auto-fixes.
- **Fallow** (installed as a dev dependency) analyzes dead code, duplication,
  and complexity hotspots. `bunx fallow audit --base main` scopes it to just
  the files your branch changed.
- **Tests** (`tests/*.test.ts`) cover the pure, side-effect-free parts of the
  pipeline (metadata parsing, variant selection, dimension math, storyboard
  config) directly — they don't spin up ffmpeg, Redis, or S3, so they run
  fast and need no external services. They do still import `src/config.ts`
  transitively, so `API_KEY`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` must
  be set (any placeholder value works locally via `.env`; CI sets dummy ones
  explicitly).

## CI/CD

`.github/workflows/ci.yml`, on every push to `main`/`v*` tags and every PR
into `main`:

1. **`test` job** — typecheck, `biome ci`, `bun test`, a build sanity check,
   and (PRs only, non-blocking) `fallow audit` scoped to the diff.
2. **`docker` job** (only after `test` passes) — builds the image on every
   PR (build-only, not pushed), and on pushes to `main`/`v*` tags, **builds
   and pushes to GHCR**
   (`ghcr.io/aufabdulnafea/video-processing`) using the repo's built-in
   `GITHUB_TOKEN` — no extra secrets to configure. Tags: short commit SHA,
   branch name, semver (for `v*` tags), and `latest` on the default branch.

## Operational notes

- **No client-supplied job IDs.** `POST /jobs` always generates the id
  server-side. A job id becomes part of a filesystem path
  (`TEMP_DIR/<jobId>`) that gets recursively deleted on job completion —
  accepting an id from the request body would allow path traversal into an
  arbitrary path the process can reach.
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

Every package actually bundled into the compiled binary (`pino`,
`pino-pretty`, `zod`, and their full transitive dependency tree) is MIT,
ISC, or BSD-3-Clause; dev-only tooling (`biome`, `fallow`, `typescript`) adds
Apache-2.0 into the mix, but none of it ships in the built artifact. All of
it is permissive and compatible with MIT.

The Docker image separately bundles `ffmpeg`, which Alpine builds with
`--enable-gpl` (GPL-licensed, via `libx264` and friends). It's invoked as an
external subprocess — never linked into the compiled binary — which is the
standard "mere aggregation" boundary that keeps this project's own MIT-licensed
source unaffected. The image itself is still, in effect, a GPL+MIT
aggregate: redistributing the *image* means redistributing GPL-licensed
binaries alongside MIT-licensed ones, same as any other tool that ships
ffmpeg in a container.
