import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";
import { env } from "./config/env";
import { logger as rootLogger } from "./infrastructure/logging/logger";

export interface VariantSpec {
  name: string;
  targetMaxDimension: number;
  bitrate: string;
  bandwidth: number;
}

export interface TranscodeJobParams {
  jobId: string;
  inputPath: string;
  outputDir: string;
  customVariants?: VariantSpec[];
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  isVertical: boolean;
  bitrate: number;
  rotation: number;
  fps: number;
}

export interface StoryboardConfig {
  interval: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  tilesPerSprite: number;
  frameCount: number;
  spriteCount: number;
}

const DEFAULT_VARIANTS: VariantSpec[] = [
  {
    name: "1080p",
    targetMaxDimension: 1080,
    bitrate: "4500k",
    bandwidth: 5_000_000,
  },
  {
    name: "720p",
    targetMaxDimension: 720,
    bitrate: "2500k",
    bandwidth: 2_800_000,
  },
  {
    name: "480p",
    targetMaxDimension: 480,
    bitrate: "1000k",
    bandwidth: 1_200_000,
  },
  {
    name: "360p",
    targetMaxDimension: 360,
    bitrate: "600k",
    bandwidth: 700_000,
  },
];

type Logger = typeof rootLogger;

/**
 * Throws (after logging) if a spawned command exited non-zero, distinguishing
 * a timeout kill from an ordinary failure. Shared by `runCommand` and
 * `runCommandWithOutput` so the two don't drift.
 */
function assertExitedCleanly(
  process: { signalCode: string | null },
  exitCode: number,
  cmd: string[],
  label: string,
  logger: Logger,
  timeoutMs: number,
  durationMs: number,
): void {
  if (exitCode === 0) {
    return;
  }

  const timedOut = process.signalCode !== null && durationMs >= timeoutMs;

  logger.error(
    {
      stage: "command",
      command: cmd[0],
      exitCode,
      signalCode: process.signalCode,
      timedOut,
      durationMs,
    },
    `${label} failed`,
  );

  throw new Error(
    timedOut ? `${label} timed out after ${timeoutMs}ms and was killed` : `${label} failed with exit code ${exitCode}`,
  );
}

/**
 * Safely executes a command.
 *
 * FFmpeg stderr is inherited so its progress/errors remain visible.
 * Pino handles application-level structured logging.
 */
async function runCommand(
  cmd: string[],
  label: string,
  logger: Logger,
  timeoutMs: number = env.FFMPEG_TIMEOUT_MS,
): Promise<void> {
  const startedAt = performance.now();

  logger.info(
    {
      stage: "command",
      command: cmd[0],
    },
    `${label} started`,
  );

  const process = spawn(cmd, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });

  const exitCode = await process.exited;

  const durationMs = Math.round(performance.now() - startedAt);

  assertExitedCleanly(process, exitCode, cmd, label, logger, timeoutMs, durationMs);

  logger.info(
    {
      stage: "command",
      command: cmd[0],
      exitCode,
      durationMs,
    },
    `${label} completed`,
  );
}

/**
 * Executes a command and returns stdout.
 */
async function runCommandWithOutput(
  cmd: string[],
  label: string,
  logger: Logger,
  timeoutMs: number = env.FFPROBE_TIMEOUT_MS,
): Promise<string> {
  const startedAt = performance.now();

  logger.info(
    {
      stage: "command",
      command: cmd[0],
    },
    `${label} started`,
  );

  const process = spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });

  const stdout = await new Response(process.stdout).text();

  const exitCode = await process.exited;

  const durationMs = Math.round(performance.now() - startedAt);

  assertExitedCleanly(process, exitCode, cmd, label, logger, timeoutMs, durationMs);

  logger.debug(
    {
      stage: "command",
      command: cmd[0],
      exitCode,
      durationMs,
    },
    `${label} completed`,
  );

  return stdout;
}

/**
 * Parses an FFmpeg frame-rate string.
 */
export function parseFrameRate(value: string | undefined): number {
  if (!value) {
    return 30;
  }

  if (value.includes("/")) {
    const parts = value.split("/");

    const numerator = Number(parts[0]);

    const denominator = Number(parts[1]);

    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return numerator / denominator;
    }
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 30;
}

/**
 * Reads the display-matrix rotation (0/90/180/270) out of ffprobe's
 * per-stream side_data_list, normalized to a positive degree value.
 */
function extractRotationDegrees(stream: { side_data_list?: Array<{ rotation?: number }> }): number {
  const rotationValue = stream.side_data_list?.find((item) => typeof item.rotation === "number")?.rotation ?? 0;

  return ((Number(rotationValue) % 360) + 360) % 360;
}

/**
 * Swaps width/height for a 90/270 degree display-matrix rotation, since
 * ffprobe reports the stream's encoded (pre-rotation) dimensions.
 */
function applyRotation(width: number, height: number, rotation: number): [width: number, height: number] {
  return rotation === 90 || rotation === 270 ? [height, width] : [width, height];
}

/**
 * Parses ffprobe's JSON output into VideoMetadata.
 *
 * Split out from `getVideoMetadata` so the parsing logic (rotation-aware
 * width/height swap, fps/bitrate fallbacks) is unit-testable without
 * shelling out to ffprobe.
 */
export function parseVideoMetadata(outputText: string): VideoMetadata {
  const output = JSON.parse(outputText || "{}");

  const stream = output.streams?.[0] ?? {};

  const format = output.format ?? {};

  const rotation = extractRotationDegrees(stream);

  const [width, height] = applyRotation(Number(stream.width ?? 0), Number(stream.height ?? 0), rotation);

  const fps = parseFrameRate(stream.avg_frame_rate || stream.r_frame_rate);

  return {
    duration: Number(format.duration ?? 0),
    width,
    height,
    isVertical: height > width,
    bitrate: Number(format.bit_rate ?? stream.bit_rate ?? 0),
    rotation,
    fps,
  };
}

/**
 * Inspects video metadata.
 */
async function getVideoMetadata(inputPath: string, logger: Logger = rootLogger): Promise<VideoMetadata> {
  const outputText = await runCommandWithOutput(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      [
        "stream=" + "width," + "height," + "bit_rate," + "avg_frame_rate," + "r_frame_rate",
        "stream_side_data=rotation",
        "format=duration,bit_rate",
      ].join(":"),
      "-of",
      "json",
      inputPath,
    ],
    "Inspecting video metadata",
    logger,
  );

  const metadata = parseVideoMetadata(outputText);

  logger.info(
    {
      stage: "metadata",
      width: metadata.width,
      height: metadata.height,
      durationSeconds: Number(metadata.duration.toFixed(2)),
      fps: Number(metadata.fps.toFixed(2)),
      bitrate: metadata.bitrate,
      rotation: metadata.rotation,
      orientation: metadata.isVertical ? "vertical" : "horizontal",
    },
    "Video metadata detected",
  );

  return metadata;
}

/**
 * The single-variant fallback used when every requested variant's
 * targetMaxDimension exceeds the source's own resolution (e.g. a 240p
 * source with only the 360p+ defaults requested).
 */
function fallbackVariantForDimension(sourceMaxDimension: number): VariantSpec {
  const name = `${sourceMaxDimension}p`;

  if (sourceMaxDimension >= 1080) {
    return {
      name,
      targetMaxDimension: sourceMaxDimension,
      bitrate: "4500k",
      bandwidth: 5_000_000,
    };
  }

  if (sourceMaxDimension >= 720) {
    return {
      name,
      targetMaxDimension: sourceMaxDimension,
      bitrate: "2500k",
      bandwidth: 2_800_000,
    };
  }

  if (sourceMaxDimension >= 480) {
    return {
      name,
      targetMaxDimension: sourceMaxDimension,
      bitrate: "1000k",
      bandwidth: 1_200_000,
    };
  }

  return {
    name,
    targetMaxDimension: sourceMaxDimension,
    bitrate: "600k",
    bandwidth: 700_000,
  };
}

/**
 * Picks which HLS variants to encode: the requested list filtered down to
 * what the source resolution actually supports, largest first; falling back
 * to a single variant matching the source's own resolution when nothing
 * survives the filter.
 */
export function selectVariants(baseVariants: VariantSpec[], sourceWidth: number, sourceHeight: number): VariantSpec[] {
  const sourceMaxDimension = Math.max(sourceWidth, sourceHeight);

  const validVariants = baseVariants
    .filter((variant) => variant.targetMaxDimension <= sourceMaxDimension)
    .sort((a, b) => b.targetMaxDimension - a.targetMaxDimension);

  return validVariants.length > 0 ? validVariants : [fallbackVariantForDimension(sourceMaxDimension)];
}

/**
 * Calculates output dimensions for a variant.
 *
 * targetMaxDimension always refers to the longest dimension.
 */
export function calculateVariantDimensions(
  sourceWidth: number,
  sourceHeight: number,
  targetMaxDimension: number,
): {
  width: number;
  height: number;
} {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error(`Invalid source dimensions: ${sourceWidth}x${sourceHeight}`);
  }

  const sourceMax = Math.max(sourceWidth, sourceHeight);

  // Never upscale.
  const scale = Math.min(1, targetMaxDimension / sourceMax);

  let width = Math.round(sourceWidth * scale);

  let height = Math.round(sourceHeight * scale);

  // H.264 / yuv420p requires even dimensions.
  width -= width % 2;
  height -= height % 2;

  return {
    width: Math.max(2, width),
    height: Math.max(2, height),
  };
}

/**
 * Creates the HLS representation for a single variant.
 */
async function transcodeHLSVariant(
  inputPath: string,
  outputDir: string,
  variant: VariantSpec,
  meta: VideoMetadata,
  logger: Logger,
): Promise<void> {
  const variantLogger = logger.child({
    stage: "transcode",
    variant: variant.name,
  });

  const startedAt = performance.now();

  const variantDir = join(outputDir, variant.name);

  await mkdir(variantDir, {
    recursive: true,
  });

  const dimensions = calculateVariantDimensions(meta.width, meta.height, variant.targetMaxDimension);

  const gopSize = Math.max(1, Math.round(meta.fps * 4));

  variantLogger.info(
    {
      width: dimensions.width,
      height: dimensions.height,
      targetMaxDimension: variant.targetMaxDimension,
      bitrate: variant.bitrate,
      bandwidth: variant.bandwidth,
      fps: meta.fps,
      gopSize,
    },
    "Starting HLS variant",
  );

  try {
    await runCommand(
      [
        "ffmpeg",
        "-y",
        "-nostdin",
        "-i",
        inputPath,

        "-map",
        "0:v:0",

        "-map",
        "0:a:0?",

        "-vf",
        `scale=${dimensions.width}:${dimensions.height}`,

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-profile:v",
        "main",

        "-level",
        "4.0",

        "-pix_fmt",
        "yuv420p",

        "-g",
        String(gopSize),

        "-keyint_min",
        String(gopSize),

        "-sc_threshold",
        "0",

        "-force_key_frames",
        "expr:gte(t,n_forced*4)",

        "-b:v",
        variant.bitrate,

        "-maxrate",
        variant.bitrate,

        "-bufsize",
        `${parseInt(variant.bitrate, 10) * 2}k`,

        "-c:a",
        "aac",

        "-b:a",
        "128k",

        "-ar",
        "48000",

        "-f",
        "hls",

        "-hls_time",
        "4",

        "-hls_playlist_type",
        "vod",

        "-hls_flags",
        "independent_segments",

        "-hls_segment_type",
        "mpegts",

        "-hls_segment_filename",
        join(variantDir, "segment_%05d.ts"),

        join(variantDir, "index.m3u8"),
      ],
      `HLS variant ${variant.name}`,
      variantLogger,
    );

    variantLogger.info(
      {
        width: dimensions.width,
        height: dimensions.height,
        durationMs: Math.round(performance.now() - startedAt),
      },
      "HLS variant completed",
    );
  } catch (error) {
    variantLogger.error(
      {
        err: error,
        durationMs: Math.round(performance.now() - startedAt),
      },
      "HLS variant failed",
    );

    throw error;
  }
}

/**
 * Generates individual storyboard frames.
 */
async function generateStoryboardFrames(
  inputPath: string,
  outputDir: string,
  config: StoryboardConfig,
  logger: Logger,
): Promise<string> {
  const framesDir = join(outputDir, "storyboard", "frames");

  await mkdir(framesDir, {
    recursive: true,
  });

  const filter = [
    `scale=${config.tileWidth}:${config.tileHeight}:force_original_aspect_ratio=decrease`,
    `pad=${config.tileWidth}:${config.tileHeight}:(ow-iw)/2:(oh-ih)/2`,
    "setsar=1",
  ].join(",");

  logger.info(
    {
      stage: "storyboard",
      interval: config.interval,
      tileWidth: config.tileWidth,
      tileHeight: config.tileHeight,
      frameCount: config.frameCount,
    },
    "Generating storyboard frames",
  );

  await runCommand(
    [
      "ffmpeg",
      "-y",
      "-nostdin",
      "-i",
      inputPath,

      "-vf",
      `fps=1/${config.interval},${filter}`,

      "-q:v",
      "4",

      join(framesDir, "frame_%05d.jpg"),
    ],
    "Generating storyboard frames",
    logger,
  );

  logger.info(
    {
      stage: "storyboard",
      framesDir,
    },
    "Storyboard frames generated",
  );

  return framesDir;
}

/**
 * Assembles individual storyboard frames into sprite sheets.
 */
async function assembleStoryboardSprites(
  framesDir: string,
  outputDir: string,
  config: StoryboardConfig,
  logger: Logger,
): Promise<void> {
  const storyboardDir = join(outputDir, "storyboard");

  await mkdir(storyboardDir, {
    recursive: true,
  });

  const entries = await readdir(framesDir);

  const frames = entries.filter((file) => /^frame_\d+\.jpg$/i.test(file)).sort();

  if (frames.length === 0) {
    throw new Error("Storyboard generation produced no frames.");
  }

  const expectedSpriteCount = Math.ceil(frames.length / config.tilesPerSprite);

  logger.info(
    {
      stage: "storyboard",
      frameCount: frames.length,
      spriteCount: expectedSpriteCount,
      tilesPerSprite: config.tilesPerSprite,
    },
    "Assembling storyboard sprites",
  );

  for (let spriteIndex = 0; spriteIndex < expectedSpriteCount; spriteIndex++) {
    const start = spriteIndex * config.tilesPerSprite;

    const spriteFrames = frames.slice(start, start + config.tilesPerSprite);

    const concatPath = join(framesDir, `sprite_${String(spriteIndex + 1).padStart(3, "0")}.txt`);

    const concatContent =
      spriteFrames.map((frame) => `file '${join(framesDir, frame).replaceAll("'", "'\\''")}'`).join("\n") + "\n";

    await Bun.write(concatPath, concatContent);

    const spritePath = join(storyboardDir, `storyboard_${String(spriteIndex + 1).padStart(3, "0")}.jpg`);

    await runCommand(
      [
        "ffmpeg",
        "-y",
        "-nostdin",

        "-f",
        "concat",

        "-safe",
        "0",

        "-i",
        concatPath,

        "-vf",
        `tile=${config.columns}x${config.rows}:padding=0:margin=0`,

        "-frames:v",
        "1",

        "-q:v",
        "3",

        spritePath,
      ],
      `Assembling storyboard sprite ${spriteIndex + 1}/${expectedSpriteCount}`,
      logger,
    );
  }

  logger.info(
    {
      stage: "storyboard",
      spriteCount: expectedSpriteCount,
    },
    "Storyboard sprites generated",
  );
}

/**
 * Generates the storyboard VTT used by Vidstack.
 */
async function generateVTT(outputDir: string, duration: number, config: StoryboardConfig, logger: Logger): Promise<void> {
  const lines: string[] = ["WEBVTT", ""];

  const frameCount = Math.max(1, Math.ceil(duration / config.interval));

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const start = frameIndex * config.interval;

    const end = Math.min(duration, start + config.interval);

    const spriteIndex = Math.floor(frameIndex / config.tilesPerSprite);

    const tileIndex = frameIndex % config.tilesPerSprite;

    const column = tileIndex % config.columns;

    const row = Math.floor(tileIndex / config.columns);

    const x = column * config.tileWidth;

    const y = row * config.tileHeight;

    const spriteFile = `storyboard_${String(spriteIndex + 1).padStart(3, "0")}.jpg`;

    lines.push(`${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}`);

    lines.push(`storyboard/${spriteFile}#xywh=${x},${y},${config.tileWidth},${config.tileHeight}`);

    lines.push("");
  }

  await Bun.write(join(outputDir, "thumbnails.vtt"), lines.join("\n"));

  logger.info(
    {
      stage: "storyboard",
      frameCount,
      interval: config.interval,
    },
    "Storyboard VTT generated",
  );
}

/**
 * Formats seconds as HH:MM:SS.mmm.
 */
export function formatVttTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);

  const hours = Math.floor(safe / 3600);

  const minutes = Math.floor((safe % 3600) / 60);

  const remaining = safe % 60;

  return (
    `${String(hours).padStart(2, "0")}:` + `${String(minutes).padStart(2, "0")}:` + `${remaining.toFixed(3).padStart(6, "0")}`
  );
}

/**
 * Generates the HLS master playlist.
 */
async function generateMasterPlaylist(
  outputDir: string,
  variants: VariantSpec[],
  meta: VideoMetadata,
  logger: Logger,
): Promise<void> {
  const lines: string[] = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS", ""];

  for (const variant of variants) {
    const dimensions = calculateVariantDimensions(meta.width, meta.height, variant.targetMaxDimension);

    lines.push(
      [
        "#EXT-X-STREAM-INF:",
        `BANDWIDTH=${variant.bandwidth},`,
        `AVERAGE-BANDWIDTH=${Math.round(variant.bandwidth * 0.85)},`,
        `RESOLUTION=${dimensions.width}x${dimensions.height},`,
        `CODECS="avc1.4d401f,mp4a.40.2"`,
      ].join(""),
    );

    lines.push(`${variant.name}/index.m3u8`);

    lines.push("");
  }

  await Bun.write(join(outputDir, "master.m3u8"), lines.join("\n"));

  logger.info(
    {
      stage: "manifest",
      variants: variants.map((variant) => variant.name),
    },
    "Master playlist generated",
  );
}

/**
 * Creates storyboard configuration.
 */
export function createStoryboardConfig(duration: number): StoryboardConfig {
  const baseInterval = 5;
  const tileWidth = 160;
  const tileHeight = 90;
  const columns = 5;
  const rows = 5;

  const tilesPerSprite = columns * rows;

  const baseFrameCount = Math.max(1, Math.ceil(duration / baseInterval));

  // For very long inputs, widen the sampling interval rather than let
  // frame/file count grow unbounded (disk usage, file handles, CPU).
  const interval = baseFrameCount > env.MAX_STORYBOARD_FRAMES ? Math.ceil(duration / env.MAX_STORYBOARD_FRAMES) : baseInterval;

  const frameCount = Math.max(1, Math.min(env.MAX_STORYBOARD_FRAMES, Math.ceil(duration / interval)));

  const spriteCount = Math.ceil(frameCount / tilesPerSprite);

  return {
    interval,
    tileWidth,
    tileHeight,
    columns,
    rows,
    tilesPerSprite,
    frameCount,
    spriteCount,
  };
}

/**
 * Main video-processing pipeline.
 */
export async function processVideoPipeline(params: TranscodeJobParams): Promise<void> {
  const { jobId, inputPath, outputDir, customVariants } = params;

  const logger = rootLogger.child({
    jobId,
    component: "transcoder",
  });

  const startedAt = performance.now();

  logger.info(
    {
      inputPath,
      outputDir,
    },
    "Starting video processing pipeline",
  );

  try {
    /**
     * --------------------------------------------------
     * 1. Metadata inspection
     * --------------------------------------------------
     */

    logger.info(
      {
        stage: "metadata",
      },
      "Inspecting media metadata",
    );

    await rm(outputDir, {
      recursive: true,
      force: true,
    });

    await mkdir(outputDir, {
      recursive: true,
    });

    const meta = await getVideoMetadata(inputPath, logger);

    /**
     * --------------------------------------------------
     * 2. Select variants
     * --------------------------------------------------
     */

    const baseVariants = customVariants && customVariants.length > 0 ? customVariants : DEFAULT_VARIANTS;

    const validVariants = selectVariants(baseVariants, meta.width, meta.height);

    logger.info(
      {
        stage: "variants",
        sourceWidth: meta.width,
        sourceHeight: meta.height,
        sourceMaxDimension: Math.max(meta.width, meta.height),
        customVariants: Boolean(customVariants?.length),
        variants: validVariants.map((variant) => ({
          name: variant.name,
          targetMaxDimension: variant.targetMaxDimension,
          bitrate: variant.bitrate,
        })),
      },
      "Selected HLS variants",
    );

    /**
     * --------------------------------------------------
     * 3. Generate media
     * --------------------------------------------------
     */

    logger.info(
      {
        stage: "processing",
      },
      "Starting media processing",
    );

    const processingStartedAt = performance.now();

    const storyboardConfig = createStoryboardConfig(meta.duration);

    logger.info(
      {
        stage: "storyboard",
        interval: storyboardConfig.interval,
        tileWidth: storyboardConfig.tileWidth,
        tileHeight: storyboardConfig.tileHeight,
        columns: storyboardConfig.columns,
        rows: storyboardConfig.rows,
        frameCount: storyboardConfig.frameCount,
        spriteCount: storyboardConfig.spriteCount,
      },
      "Starting storyboard generation",
    );

    const framesDir = await generateStoryboardFrames(inputPath, outputDir, storyboardConfig, logger);

    await assembleStoryboardSprites(framesDir, outputDir, storyboardConfig, logger);

    await generateVTT(outputDir, meta.duration, storyboardConfig, logger);

    await rm(framesDir, {
      recursive: true,
      force: true,
    });

    logger.debug(
      {
        stage: "storyboard",
      },
      "Temporary storyboard frames removed",
    );

    /**
     * HLS variants are encoded in parallel.
     */
    await Promise.all(validVariants.map((variant) => transcodeHLSVariant(inputPath, outputDir, variant, meta, logger)));

    logger.info(
      {
        stage: "processing",
        durationMs: Math.round(performance.now() - processingStartedAt),
      },
      "Media processing completed",
    );

    /**
     * --------------------------------------------------
     * 4. Master playlist
     * --------------------------------------------------
     */

    logger.info(
      {
        stage: "manifest",
      },
      "Generating master playlist",
    );

    await generateMasterPlaylist(outputDir, validVariants, meta, logger);

    /**
     * --------------------------------------------------
     * 5. Finished
     * --------------------------------------------------
     */

    const durationMs = Math.round(performance.now() - startedAt);

    logger.info(
      {
        durationMs,
        durationSeconds: Number((durationMs / 1000).toFixed(2)),

        source: {
          width: meta.width,
          height: meta.height,
          fps: meta.fps,
          rotation: meta.rotation,
          duration: meta.duration,
        },

        variants: validVariants.map((variant) => {
          const dimensions = calculateVariantDimensions(meta.width, meta.height, variant.targetMaxDimension);

          return {
            name: variant.name,
            width: dimensions.width,
            height: dimensions.height,
            bitrate: variant.bitrate,
            bandwidth: variant.bandwidth,
          };
        }),

        storyboard: {
          interval: storyboardConfig.interval,
          tileWidth: storyboardConfig.tileWidth,
          tileHeight: storyboardConfig.tileHeight,
          columns: storyboardConfig.columns,
          rows: storyboardConfig.rows,
          frameCount: storyboardConfig.frameCount,
          spriteCount: storyboardConfig.spriteCount,
        },

        files: {
          master: "master.m3u8",
          thumbnails: "thumbnails.vtt",
        },
      },
      "Video processing pipeline completed",
    );
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);

    logger.error(
      {
        err: error,
        durationMs,
      },
      "Video processing pipeline failed",
    );

    throw error;
  }
}
