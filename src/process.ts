import { spawn } from "bun";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./logger";

const INPUT_FILE = "input2.mp4";
const OUTPUT_DIR = "./output_hls";

interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  isVertical: boolean;
  bitrate: number;
}

interface HLSVariant {
  name: string;
  targetMaxDimension: number;
  bitrate: string;
  bandwidth: number;
}

/**
 * Step 1: Read video dimensions and orientation.
 */
async function getVideoMetadata(
  inputPath: string,
): Promise<VideoMetadata> {
  const process = spawn([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=duration,bit_rate:stream=width,height,side_data",
    "-of",
    "json",
    inputPath,
  ]);

  const outputText =
    await new Response(
      process.stdout,
    ).text();

  if (
    process.exitCode !== 0 &&
    (await process.exited) !== 0
  ) {
    throw new Error(
      `ffprobe failed to read file: ${inputPath}`,
    );
  }

  const output = JSON.parse(outputText);

  const stream =
    output.streams?.[0] || {};

  const format =
    output.format || {};

  // Account for video display matrix rotation metadata.
  let width =
    stream.width || 0;

  let height =
    stream.height || 0;

  const sideData =
    stream.side_data_list || [];

  const rotation = Math.abs(
    sideData.find(
      (sd: { rotation?: number }) =>
        sd.rotation,
    )?.rotation || 0,
  );

  if (
    rotation === 90 ||
    rotation === 270
  ) {
    [width, height] = [
      height,
      width,
    ];
  }

  return {
    duration: parseFloat(
      format.duration || 0,
    ),
    width,
    height,
    isVertical: height > width,
    bitrate: parseInt(
      format.bit_rate || 0,
      10,
    ),
  };
}

/**
 * Step 2: Generate hover storyboard sprite grid.
 */
async function generateStoryboard(
  inputPath: string,
  outputDir: string,
  pipelineLogger = logger,
) {
  const startedAt =
    performance.now();

  pipelineLogger.info(
    {
      stage: "storyboard",
      inputPath,
    },
    "Generating hover storyboard",
  );

  const process = spawn(
    [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-vf",
      "fps=1/5,scale=160:-2,tile=5x5",
      join(
        outputDir,
        "storyboard_%03d.jpg",
      ),
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  const exitCode =
    await process.exited;

  const durationMs =
    Math.round(
      performance.now() -
      startedAt,
    );

  if (exitCode !== 0) {
    pipelineLogger.error(
      {
        stage: "storyboard",
        exitCode,
        durationMs,
      },
      "Storyboard generation failed",
    );

    throw new Error(
      `Storyboard generation failed with exit code ${exitCode}`,
    );
  }

  pipelineLogger.info(
    {
      stage: "storyboard",
      durationMs,
    },
    "Storyboard generated",
  );
}

/**
 * Step 3: Extract audio track.
 */
async function extractAudio(
  inputPath: string,
  outputDir: string,
  pipelineLogger = logger,
) {
  const startedAt =
    performance.now();

  pipelineLogger.info(
    {
      stage: "audio",
      inputPath,
      codec: "aac",
      bitrate: "128k",
    },
    "Extracting audio track",
  );

  const process = spawn(
    [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      join(
        outputDir,
        "audio.m4a",
      ),
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  const exitCode =
    await process.exited;

  const durationMs =
    Math.round(
      performance.now() -
      startedAt,
    );

  if (exitCode !== 0) {
    pipelineLogger.error(
      {
        stage: "audio",
        exitCode,
        durationMs,
      },
      "Audio extraction failed",
    );

    throw new Error(
      `Audio extraction failed with exit code ${exitCode}`,
    );
  }

  pipelineLogger.info(
    {
      stage: "audio",
      durationMs,
    },
    "Audio track extracted",
  );
}

/**
 * Step 4: Transcode one HLS variant.
 */
async function transcodeHLSVariant(
  inputPath: string,
  outputDir: string,
  variant: HLSVariant,
  isVertical: boolean,
  pipelineLogger = logger,
) {
  const startedAt =
    performance.now();

  const variantLogger =
    pipelineLogger.child({
      stage: "transcode",
      variant: variant.name,
    });

  const variantDir =
    join(
      outputDir,
      variant.name,
    );

  await mkdir(
    variantDir,
    {
      recursive: true,
    },
  );

  const scaleFilter =
    isVertical
      ? `scale=-2:'min(ih,${variant.targetMaxDimension})'`
      : `scale='min(iw,${Math.round(variant.targetMaxDimension * (16 / 9))})':-2`;

  variantLogger.info(
    {
      targetMaxDimension:
        variant.targetMaxDimension,
      bitrate: variant.bitrate,
      bandwidth:
        variant.bandwidth,
      scaleFilter,
      orientation:
        isVertical
          ? "vertical"
          : "horizontal",
    },
    "Starting HLS transcoding",
  );

  const process = spawn(
    [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-vf",
      scaleFilter,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-g",
      "48",
      "-keyint_min",
      "48",
      "-sc_threshold",
      "0",
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
      "-hls_time",
      "4",
      "-hls_playlist_type",
      "vod",
      "-hls_segment_filename",
      join(
        variantDir,
        "segment_%03d.ts",
      ),
      join(
        variantDir,
        "index.m3u8",
      ),
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  const exitCode =
    await process.exited;

  const durationMs =
    Math.round(
      performance.now() -
      startedAt,
    );

  if (exitCode !== 0) {
    variantLogger.error(
      {
        exitCode,
        durationMs,
      },
      "HLS transcoding failed",
    );

    throw new Error(
      `HLS transcoding failed for ${variant.name} with exit code ${exitCode}`,
    );
  }

  variantLogger.info(
    {
      durationMs,
    },
    "HLS variant completed",
  );
}

/**
 * Step 5: Build master playlist.
 */
async function generateMasterPlaylist(
  outputDir: string,
  variants: HLSVariant[],
  pipelineLogger = logger,
) {
  const startedAt =
    performance.now();

  let masterContent =
    "#EXTM3U\n#EXT-X-VERSION:3\n\n";

  for (const variant of variants) {
    masterContent +=
      `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth}\n`;

    masterContent +=
      `${variant.name}/index.m3u8\n\n`;
  }

  await Bun.write(
    join(
      outputDir,
      "master.m3u8",
    ),
    masterContent,
  );

  pipelineLogger.info(
    {
      stage: "manifest",
      variantCount: variants.length,
      variants: variants.map(
        (variant) => variant.name,
      ),
      durationMs: Math.round(
        performance.now() -
        startedAt,
      ),
    },
    "Master HLS playlist generated",
  );
}

/**
 * Main pipeline orchestrator.
 */
async function main() {
  const startedAt =
    performance.now();

  const pipelineLogger =
    logger.child({
      inputFile: INPUT_FILE,
      outputDir: OUTPUT_DIR,
    });

  pipelineLogger.info(
    "Starting video processing pipeline",
  );

  try {
    await rm(
      OUTPUT_DIR,
      {
        recursive: true,
        force: true,
      },
    );

    await mkdir(
      OUTPUT_DIR,
      {
        recursive: true,
      },
    );

    /**
     * 1. Analyze metadata.
     */
    pipelineLogger.info(
      {
        stage: "metadata",
      },
      "Inspecting video metadata",
    );

    const meta =
      await getVideoMetadata(
        INPUT_FILE,
      );

    pipelineLogger.info(
      {
        stage: "metadata",
        width: meta.width,
        height: meta.height,
        durationSeconds:
          Number(
            meta.duration.toFixed(
              2,
            ),
          ),
        bitrate: meta.bitrate,
        orientation:
          meta.isVertical
            ? "vertical"
            : "horizontal",
      },
      "Video metadata detected",
    );

    const allVariants: HLSVariant[] =
      [
        {
          name: "1080p",
          targetMaxDimension: 1080,
          bitrate: "4500k",
          bandwidth: 5000000,
        },
        {
          name: "720p",
          targetMaxDimension: 720,
          bitrate: "2500k",
          bandwidth: 2800000,
        },
        {
          name: "480p",
          targetMaxDimension: 480,
          bitrate: "1000k",
          bandwidth: 1200000,
        },
        {
          name: "360p",
          targetMaxDimension: 360,
          bitrate: "600k",
          bandwidth: 700000,
        },
      ];

    const sourceMaxDimension =
      Math.max(
        meta.width,
        meta.height,
      );

    const validVariants =
      allVariants.filter(
        (variant) =>
          variant.targetMaxDimension <=
          sourceMaxDimension,
      );

    if (
      validVariants.length ===
      0
    ) {
      validVariants.push({
        name: `${sourceMaxDimension}p`,
        targetMaxDimension:
          sourceMaxDimension,
        bitrate: "1000k",
        bandwidth: 1200000,
      });
    }

    pipelineLogger.info(
      {
        stage: "variants",
        sourceMaxDimension,
        variants:
          validVariants.map(
            (variant) =>
              variant.name,
          ),
      },
      "Selected HLS variants",
    );

    /**
     * 2. Parallel processing.
     */
    pipelineLogger.info(
      {
        stage: "processing",
        taskCount:
          validVariants.length +
          2,
        parallel: true,
      },
      "Starting parallel media processing",
    );

    const processingStartedAt =
      performance.now();

    await Promise.all([
      generateStoryboard(
        INPUT_FILE,
        OUTPUT_DIR,
        pipelineLogger,
      ),

      extractAudio(
        INPUT_FILE,
        OUTPUT_DIR,
        pipelineLogger,
      ),

      ...validVariants.map(
        (variant) =>
          transcodeHLSVariant(
            INPUT_FILE,
            OUTPUT_DIR,
            variant,
            meta.isVertical,
            pipelineLogger,
          ),
      ),
    ]);

    pipelineLogger.info(
      {
        stage: "processing",
        durationMs: Math.round(
          performance.now() -
          processingStartedAt,
        ),
      },
      "Parallel media processing completed",
    );

    /**
     * 3. Generate master manifest.
     */
    pipelineLogger.info(
      {
        stage: "manifest",
      },
      "Generating master HLS manifest",
    );

    await generateMasterPlaylist(
      OUTPUT_DIR,
      validVariants,
      pipelineLogger,
    );

    /**
     * 4. Finished.
     */
    const durationMs =
      Math.round(
        performance.now() -
        startedAt,
      );

    pipelineLogger.info(
      {
        durationMs,
        durationSeconds:
          Number(
            (
              durationMs /
              1000
            ).toFixed(2),
          ),
        variants:
          validVariants.length,
      },
      "Video processing pipeline completed",
    );
  } catch (err) {
    const error =
      err instanceof Error
        ? err
        : new Error(String(err));

    pipelineLogger.fatal(
      {
        err: error,
        durationMs: Math.round(
          performance.now() -
          startedAt,
        ),
      },
      "Video processing pipeline failed",
    );

    process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal(
    {
      err:
        err instanceof Error
          ? err
          : new Error(String(err)),
    },
    "Unhandled application error",
  );

  process.exit(1);
});