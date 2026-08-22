import pino from "pino";
import pinoPretty from "pino-pretty";
import { config } from "./config";

const isDevelopment = config.NODE_ENV !== "production";

// Create the stream inline so Bun doesn't spawn worker threads
const stream = isDevelopment
    ? pinoPretty({
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
        singleLine: false,
        levelFirst: true,
        messageFormat: "{msg}",
    })
    : pino.destination(1); // Write directly to stdout in production

export const logger = pino(
    {
        level: process.env.LOG_LEVEL ?? "info",
        base: {
            service: "video-transcoder",
        },
        timestamp: pino.stdTimeFunctions.isoTime,
    },
    stream
);