import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { S3Client } from "bun";
import { env } from "./config/env";

const s3Client = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  accessKeyId: env.AWS_ACCESS_KEY_ID,
  secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
});

/**
 * Downloads an S3 object directly to disk.
 *
 * The object is streamed from S3 -> disk.
 * The entire object is NOT loaded into RAM.
 */
export async function downloadFromS3(bucket: string, key: string, localDestination: string): Promise<void> {
  const file = s3Client.file(key, {
    bucket,
  });

  if (!(await file.exists())) {
    throw new Error(`S3 object not found: s3://${bucket}/${key}`);
  }

  const size = await file.size;

  if (size > env.MAX_INPUT_BYTES) {
    throw new Error(`S3 object s3://${bucket}/${key} is ${size} bytes, exceeding the ${env.MAX_INPUT_BYTES} byte limit`);
  }

  await Bun.write(localDestination, file);
}

/**
 * Recursively uploads a directory to S3.
 *
 * Files are streamed from disk -> S3.
 * Large files are uploaded using multipart upload.
 */
export async function uploadDirectoryToS3(localDir: string, bucket: string, s3Prefix: string): Promise<void> {
  async function* getFiles(dir: string): AsyncGenerator<string> {
    const entries = await readdir(dir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const filePath = join(dir, entry.name);

      if (entry.isDirectory()) {
        yield* getFiles(filePath);
      } else if (entry.isFile()) {
        yield filePath;
      }
    }
  }

  const prefix = s3Prefix.replace(/\/$/, "");

  for await (const filePath of getFiles(localDir)) {
    const relativePath = relative(localDir, filePath).replace(/\\/g, "/");

    const s3Key = `${prefix}/${relativePath}`;

    const contentType = getContentType(filePath);

    const s3File = s3Client.file(s3Key, {
      bucket,
      type: contentType,

      // Multipart upload settings
      partSize: 8 * 1024 * 1024,
      queueSize: 4,
    });

    // Bun streams the local file into S3.
    await s3File.write(Bun.file(filePath));
  }
}

function getContentType(filePath: string): string {
  if (filePath.endsWith(".m3u8")) {
    return "application/x-mpegURL";
  }

  if (filePath.endsWith(".ts")) {
    return "video/mp2t";
  }

  if (filePath.endsWith(".m4a")) {
    return "audio/mp4";
  }

  if (filePath.endsWith(".mp4")) {
    return "video/mp4";
  }

  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (filePath.endsWith(".png")) {
    return "image/png";
  }

  if (filePath.endsWith(".webp")) {
    return "image/webp";
  }

  return "application/octet-stream";
}
