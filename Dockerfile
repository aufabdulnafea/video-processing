# syntax=docker/dockerfile:1

# ============================================================
# 1. Base & Dependencies
# ============================================================
FROM oven/bun:1.4.0-alpine AS deps
WORKDIR /app

COPY package.json bun.lock ./
# --production skips devDependencies (biome, fallow, typescript types, ...)
# that `bun build --compile` never touches -- ~300MB -> ~33MB of node_modules,
# which keeps this (discarded) stage fast to build and cheap to cache.
RUN bun install --frozen-lockfile --production

# ============================================================
# 2. Builder (compile to a standalone, arch-matched binary)
# ============================================================
FROM oven/bun:1.4.0-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Compile straight to this stage's own target triple instead of letting
# --compile infer it implicitly. Being explicit means a future change to the
# builder's base image (e.g. swapping alpine for a glibc image) fails loudly
# at build time instead of silently shipping a binary the musl-only runtime
# stage below can't load.
ARG TARGETARCH
RUN case "$TARGETARCH" in \
        amd64) BUN_COMPILE_TARGET=bun-linux-x64-musl ;; \
        arm64) BUN_COMPILE_TARGET=bun-linux-arm64-musl ;; \
        *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    bun build ./src/index.ts \
        --compile \
        --minify \
        --target="$BUN_COMPILE_TARGET" \
        --outfile ./video-processing

# ============================================================
# 3. Production runtime (minimal Alpine + ffmpeg, no Bun runtime)
# ============================================================
FROM alpine:3.24 AS production

# Static metadata for a plain `docker build`. CI additionally passes
# --label flags via docker/metadata-action (created/revision/source tied to
# the actual commit), which coexist with these.
LABEL org.opencontainers.image.title="video-processing" \
    org.opencontainers.image.description="HLS video transcoding microservice (HTTP API + Redis queue worker)" \
    org.opencontainers.image.source="https://github.com/aufabdulnafea/video-processing" \
    org.opencontainers.image.licenses="UNLICENSED"

ENV NODE_ENV=production
ENV TEMP_DIR=/tmp/transcoder

WORKDIR /app

# ffmpeg pulls in its full codec/container dependency tree (h264/hevc/vp9/av1/
# opus/aac, ...) so uploads from real-world sources (phones, cameras, browsers)
# transcode correctly -- that dependency tree, not this package list, is what
# dominates image size, and trimming it is not a safe trade against usability.
# libstdc++ is required by the compiled binary; gcompat (glibc emulation) is
# NOT needed because the builder stage targets musl natively (verified: the
# binary runs on bare Alpine with only libstdc++ present).
RUN apk add --no-cache \
    ffmpeg \
    ca-certificates \
    tini \
    libstdc++ \
    && addgroup -g 10001 -S app \
    && adduser -u 10001 -S app -G app \
    && mkdir -p /tmp/transcoder \
    && chown -R app:app /app /tmp/transcoder

# Copy ONLY the compiled executable from the builder stage
COPY --from=builder --chown=app:app /app/video-processing ./video-processing

USER app

EXPOSE 3000

# Native health check using standard wget available in Alpine
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]

CMD ["./video-processing"]
