// import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
// import { Upload } from "@aws-sdk/lib-storage";
// import { createReadStream, createWriteStream } from "node:fs";
// import { readdir, stat } from "node:fs/promises";
// import { join, relative } from "node:path";
// import { Readable } from "node:stream";
// import { config } from "./config";
// import { pipeline } from "node:stream/promises";

// export const s3Client = new S3Client({
//     region: config.S3_REGION,
//     endpoint: config.S3_ENDPOINT,
//     forcePathStyle: config.S3_FORCE_PATH_STYLE,
//     credentials: {
//         accessKeyId: config.AWS_ACCESS_KEY_ID,
//         secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
//     },
// });

// /**
//  * Downloads an S3 file directly to disk using streams (low memory overhead).
//  */
// export async function downloadFromS3(bucket: string, key: string, localDestination: string): Promise<void> {
//     const command = new GetObjectCommand({ Bucket: bucket, Key: key });
//     const response = await s3Client.send(command);

//     if (!response.Body) {
//         throw new Error(`S3 Object empty or not found: s3://${bucket}/${key}`);
//     }

//     // Handle both Node.js stream and Web ReadableStream cross-platform in Bun
//     const bodyStream = response.Body as any;

//     if (typeof bodyStream.transformToResponseBodyStream === "function") {
//         // AWS SDK v3 Web stream helper
//         await Bun.write(localDestination, bodyStream.transformToResponseBodyStream());
//     } else if (bodyStream instanceof Readable) {
//         // Standard Node Stream
//         await pipeline(bodyStream, createWriteStream(localDestination));
//     } else {
//         // Fallback Web ReadableStream
//         await pipeline(Readable.fromWeb(bodyStream), createWriteStream(localDestination));
//     }
// }
// /**
//  * Streams local files/directories recursively back up to S3 using AWS SDK Upload manager.
//  */
// export async function uploadDirectoryToS3(localDir: string, bucket: string, s3Prefix: string): Promise<void> {
//     async function* getFiles(dir: string): AsyncGenerator<string> {
//         const entries = await readdir(dir, { withFileTypes: true });
//         for (const entry of entries) {
//             const res = join(dir, entry.name);
//             if (entry.isDirectory()) {
//                 yield* getFiles(res);
//             } else {
//                 yield res;
//             }
//         }
//     }

//     const uploadPromises: Promise<unknown>[] = [];

//     for await (const filePath of getFiles(localDir)) {
//         const relativePath = relative(localDir, filePath).replace(/\\/g, "/");
//         const s3Key = `${s3Prefix.replace(/\/$/, "")}/${relativePath}`;

//         const contentType = getContentType(filePath);
//         const fileStream = createReadStream(filePath);

//         const parallelUpload = new Upload({
//             client: s3Client,
//             params: {
//                 Bucket: bucket,
//                 Key: s3Key,
//                 Body: fileStream,
//                 ContentType: contentType,
//             },
//             queueSize: 4,
//             partSize: 5 * 1024 * 1024, // 5MB chunk parts
//         });

//         uploadPromises.push(parallelUpload.done());
//     }

//     await Promise.all(uploadPromises);
// }

// function getContentType(filePath: string): string {
//     if (filePath.endsWith(".m3u8")) return "application/x-mpegURL";
//     if (filePath.endsWith(".ts")) return "video/MP2T";
//     if (filePath.endsWith(".m4a")) return "audio/mp4";
//     if (filePath.endsWith(".jpg")) return "image/jpeg";
//     return "application/octet-stream";
// }

import { S3Client } from "bun";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { config } from "./config";

export const s3Client = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    // bucket: config.S3_BUCKET,
});

/**
 * Downloads an S3 object directly to disk.
 *
 * The object is streamed from S3 -> disk.
 * The entire object is NOT loaded into RAM.
 */
export async function downloadFromS3(
    bucket: string,
    key: string,
    localDestination: string,
): Promise<void> {
    const file = s3Client.file(key, {
        bucket,
    });

    if (!(await file.exists())) {
        throw new Error(`S3 object not found: s3://${bucket}/${key}`);
    }

    await Bun.write(localDestination, file);
}


/**
 * Recursively uploads a directory to S3.
 *
 * Files are streamed from disk -> S3.
 * Large files are uploaded using multipart upload.
 */
export async function uploadDirectoryToS3(
    localDir: string,
    bucket: string,
    s3Prefix: string,
): Promise<void> {
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
        const relativePath = relative(localDir, filePath)
            .replace(/\\/g, "/");

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