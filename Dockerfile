# syntax=docker/dockerfile:1

# ============================================================
# 1. Base & Dependencies
# ============================================================
FROM oven/bun:1.3.5-alpine AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ============================================================
# 2. Builder (Compile to single standalone binary)
# ============================================================
FROM oven/bun:1.3.5-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Compile code + dependencies into a zero-dependency executable
RUN bun build ./src/index.ts --compile --outfile ./video-processing

# ============================================================
# 3. Production Runtime (Minimal & Zero-Vulnerability Alpine)
# ============================================================
FROM alpine:3.20 AS production

ENV NODE_ENV=production
ENV TEMP_DIR=/tmp/transcoder

WORKDIR /app

# Install runtime tools & remove package cache
RUN apk add --no-inspection --no-cache \
    ffmpeg \
    ca-certificates \
    tini \
    libstdc++ \
    gcompat \
    && addgroup -g 10001 -S app \
    && adduser -u 10001 -S app -G app \
    && mkdir -p /tmp/transcoder \
    && chown -R app:app /app /tmp/transcoder

# Copy ONLY the compiled executable from builder stage
COPY --from=builder --chown=app:app /app/video-processing ./video-processing

USER app

EXPOSE 3000

# Native health check using standard wget available in Alpine
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]

CMD ["./video-processing"]