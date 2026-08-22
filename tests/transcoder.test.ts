import { describe, expect, test } from "bun:test";
import {
    calculateVariantDimensions,
    createStoryboardConfig,
    formatVttTimestamp,
    parseFrameRate,
    parseVideoMetadata,
    selectVariants,
    type VariantSpec,
} from "../src/transcoder";

describe("parseFrameRate", () => {
    test("parses a fractional rate string", () => {
        expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    });

    test("parses a plain integer string", () => {
        expect(parseFrameRate("25")).toBe(25);
    });

    test("falls back to 30 when undefined", () => {
        expect(parseFrameRate(undefined)).toBe(30);
    });

    test("falls back to 30 on a zero denominator", () => {
        expect(parseFrameRate("30/0")).toBe(30);
    });

    test("falls back to 30 on garbage input", () => {
        expect(parseFrameRate("not-a-number")).toBe(30);
    });
});

describe("parseVideoMetadata", () => {
    function ffprobeJson(overrides: {
        width?: number;
        height?: number;
        rotation?: number;
        duration?: string;
        bitRate?: string;
        avgFrameRate?: string;
    }): string {
        return JSON.stringify({
            streams: [
                {
                    width: overrides.width ?? 1920,
                    height: overrides.height ?? 1080,
                    avg_frame_rate: overrides.avgFrameRate ?? "30/1",
                    side_data_list:
                        overrides.rotation !== undefined
                            ? [{ rotation: overrides.rotation }]
                            : undefined,
                },
            ],
            format: {
                duration: overrides.duration ?? "12.5",
                bit_rate: overrides.bitRate ?? "4000000",
            },
        });
    }

    test("reads width/height/duration/bitrate/fps for an unrotated video", () => {
        const metadata = parseVideoMetadata(ffprobeJson({}));

        expect(metadata.width).toBe(1920);
        expect(metadata.height).toBe(1080);
        expect(metadata.isVertical).toBe(false);
        expect(metadata.duration).toBe(12.5);
        expect(metadata.bitrate).toBe(4_000_000);
        expect(metadata.fps).toBe(30);
        expect(metadata.rotation).toBe(0);
    });

    test("swaps width/height for a 90 degree rotation", () => {
        const metadata = parseVideoMetadata(
            ffprobeJson({ width: 1920, height: 1080, rotation: 90 }),
        );

        expect(metadata.width).toBe(1080);
        expect(metadata.height).toBe(1920);
        expect(metadata.isVertical).toBe(true);
        expect(metadata.rotation).toBe(90);
    });

    test("swaps width/height for a -90 (270) degree rotation", () => {
        const metadata = parseVideoMetadata(
            ffprobeJson({ width: 1920, height: 1080, rotation: -90 }),
        );

        expect(metadata.width).toBe(1080);
        expect(metadata.height).toBe(1920);
        expect(metadata.rotation).toBe(270);
    });

    test("does not swap width/height for a 180 degree rotation", () => {
        const metadata = parseVideoMetadata(
            ffprobeJson({ width: 1920, height: 1080, rotation: 180 }),
        );

        expect(metadata.width).toBe(1920);
        expect(metadata.height).toBe(1080);
        expect(metadata.rotation).toBe(180);
    });

    test("defaults gracefully on empty ffprobe output", () => {
        const metadata = parseVideoMetadata("{}");

        expect(metadata.width).toBe(0);
        expect(metadata.height).toBe(0);
        expect(metadata.duration).toBe(0);
        expect(metadata.bitrate).toBe(0);
    });

    test("defaults gracefully on a blank string", () => {
        const metadata = parseVideoMetadata("");

        expect(metadata.width).toBe(0);
        expect(metadata.height).toBe(0);
    });
});

describe("calculateVariantDimensions", () => {
    test("scales the longest dimension down to the target, keeping even dimensions", () => {
        // targetMaxDimension always caps the longest side, so for a
        // landscape 1920x1080 source, "720" caps width (the longest side)
        // at 720 -- not height, unlike conventional "720p" naming.
        const dims = calculateVariantDimensions(1920, 1080, 720);

        expect(dims.width).toBe(720);
        expect(dims.height).toBe(404);
        expect(dims.width % 2).toBe(0);
        expect(dims.height % 2).toBe(0);
    });

    test("never upscales past the source resolution", () => {
        const dims = calculateVariantDimensions(640, 360, 1080);

        expect(dims.width).toBe(640);
        expect(dims.height).toBe(360);
    });

    test("throws on invalid source dimensions", () => {
        expect(() => calculateVariantDimensions(0, 1080, 720)).toThrow();
        expect(() => calculateVariantDimensions(1920, -1, 720)).toThrow();
    });

    test("floors dimensions to a minimum of 2px", () => {
        const dims = calculateVariantDimensions(10000, 1, 8);

        expect(dims.height).toBeGreaterThanOrEqual(2);
    });
});

describe("selectVariants", () => {
    const variants: VariantSpec[] = [
        {
            name: "1080p",
            targetMaxDimension: 1080,
            bitrate: "4500k",
            bandwidth: 5_000_000,
        },
        { name: "720p", targetMaxDimension: 720, bitrate: "2500k", bandwidth: 2_800_000 },
        { name: "480p", targetMaxDimension: 480, bitrate: "1000k", bandwidth: 1_200_000 },
        { name: "360p", targetMaxDimension: 360, bitrate: "600k", bandwidth: 700_000 },
    ];

    test("filters out variants whose targetMaxDimension exceeds the source's longest side, sorted descending", () => {
        // Longest side is 800 here, so the 1080p variant (1080 > 800) is excluded.
        const selected = selectVariants(variants, 800, 450);

        expect(selected.map((v) => v.name)).toEqual(["720p", "480p", "360p"]);
    });

    test("falls back to a single source-resolution variant when nothing fits", () => {
        const selected = selectVariants(variants, 240, 135);

        expect(selected).toHaveLength(1);
        expect(selected[0]?.targetMaxDimension).toBe(240);
        expect(selected[0]?.bitrate).toBe("600k");
    });

    test("picks the higher-bitrate fallback tier for a large unmatched source", () => {
        const selected = selectVariants(
            [
                {
                    name: "8k",
                    targetMaxDimension: 4320,
                    bitrate: "40000k",
                    bandwidth: 45_000_000,
                },
            ],
            2000,
            1125,
        );

        expect(selected).toHaveLength(1);
        expect(selected[0]?.targetMaxDimension).toBe(2000);
        expect(selected[0]?.bitrate).toBe("4500k");
    });
});

describe("formatVttTimestamp", () => {
    test("formats zero seconds", () => {
        expect(formatVttTimestamp(0)).toBe("00:00:00.000");
    });

    test("formats sub-minute values", () => {
        expect(formatVttTimestamp(5)).toBe("00:00:05.000");
    });

    test("formats values over an hour", () => {
        expect(formatVttTimestamp(3661.25)).toBe("01:01:01.250");
    });

    test("clamps negative values to zero", () => {
        expect(formatVttTimestamp(-5)).toBe("00:00:00.000");
    });
});

describe("createStoryboardConfig", () => {
    test("uses the base 5s interval for short videos", () => {
        const config = createStoryboardConfig(60);

        expect(config.interval).toBe(5);
        expect(config.frameCount).toBe(12);
    });

    test("widens the interval to cap frame count on very long videos", () => {
        const config = createStoryboardConfig(100_000);

        expect(config.frameCount).toBeLessThanOrEqual(500);
        expect(config.interval).toBeGreaterThan(5);
    });

    test("produces at least one frame for a zero-duration video", () => {
        const config = createStoryboardConfig(0);

        expect(config.frameCount).toBeGreaterThanOrEqual(1);
    });
});
