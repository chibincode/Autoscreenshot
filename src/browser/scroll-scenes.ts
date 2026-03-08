import sharp from "sharp";
import type { Page } from "playwright";
import type { ScrollSceneReplacementDebug } from "../types.js";

const SCENE_ATTR = "data-autosnap-scroll-scene";
const SCENE_STICKY_ATTR = "data-autosnap-scroll-scene-sticky";
const MIN_STICKY_HEIGHT = 360;
const MIN_STICKY_WIDTH = 320;
const MIN_HEIGHT_RATIO = 2.5;
const MAX_SCENES = 3;
const FRAME_COUNT = 4;
const FRAME_SETTLE_MS = 220;
const FRAME_GAP_CSS = 24;
const DIFF_SAMPLE_SIZE = 64;
const DIFF_THRESHOLD = 0.012;
const SCROLL_SETTLE_TOLERANCE = 12;
const SCROLL_SETTLE_MAX_PASSES = 14;

interface ScrollSceneGeometry {
  sceneId: string;
  outerLeft: number;
  outerTop: number;
  outerWidth: number;
  outerHeight: number;
  stickyLeft: number;
  stickyHeight: number;
  stickyWidth: number;
  background: {
    r: number;
    g: number;
    b: number;
    alpha: number;
  };
}

interface SampledSceneFrame {
  buffer: Buffer;
  scrollY: number;
  clipLeft: number;
  clipWidth: number;
}

type RgbaColor = ScrollSceneGeometry["background"];

export interface ImageRegionReplacement {
  top: number;
  height: number;
  replacement: Buffer;
}

export interface ScrollSceneCaptureResult {
  replacements: ImageRegionReplacement[];
  debug: ScrollSceneReplacementDebug[];
}

export function isValidScrollSceneCandidate(params: {
  outerHeight: number;
  outerWidth: number;
  stickyHeight: number;
  stickyWidth: number;
  viewportHeight: number;
}): boolean {
  return (
    params.stickyHeight >= MIN_STICKY_HEIGHT &&
    params.stickyWidth >= MIN_STICKY_WIDTH &&
    params.outerWidth >= params.stickyWidth * 0.6 &&
    params.outerHeight >= params.stickyHeight * MIN_HEIGHT_RATIO &&
    params.outerHeight >= params.viewportHeight * 1.5
  );
}

export function sampleSceneScrollPositions(params: {
  outerTop: number;
  outerHeight: number;
  stickyHeight: number;
  viewportHeight: number;
  documentHeight: number;
  frameCount?: number;
}): number[] {
  const frameCount = params.frameCount ?? FRAME_COUNT;
  const maxScroll = Math.max(0, params.documentHeight - params.viewportHeight);
  const start = Math.max(0, Math.min(maxScroll, Math.round(params.outerTop)));
  const end = Math.max(
    start,
    Math.min(maxScroll, Math.round(params.outerTop + params.outerHeight - params.stickyHeight)),
  );
  if (frameCount <= 1 || end === start) {
    return [start];
  }

  const positions = new Set<number>();
  for (let index = 0; index < frameCount; index += 1) {
    const ratio = index / (frameCount - 1);
    positions.add(Math.round(start + (end - start) * ratio));
  }
  return [...positions].sort((left, right) => left - right);
}

async function buildDiffSignature(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(DIFF_SAMPLE_SIZE, DIFF_SAMPLE_SIZE, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
}

async function estimateFrameBackground(buffer: Buffer): Promise<RgbaColor> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const points = [
    [0, 0],
    [Math.max(0, info.width - 1), 0],
    [0, Math.max(0, info.height - 1)],
    [Math.max(0, info.width - 1), Math.max(0, info.height - 1)],
    [Math.round(info.width / 2), 0],
    [Math.round(info.width / 2), Math.max(0, info.height - 1)],
    [0, Math.round(info.height / 2)],
    [Math.max(0, info.width - 1), Math.round(info.height / 2)],
  ];

  let red = 0;
  let green = 0;
  let blue = 0;
  let alpha = 0;

  for (const [x, y] of points) {
    const offset = (y * info.width + x) * info.channels;
    red += data[offset] ?? 0;
    green += data[offset + 1] ?? 0;
    blue += data[offset + 2] ?? 0;
    alpha += (data[offset + 3] ?? 255) / 255;
  }

  return {
    r: Math.round(red / points.length),
    g: Math.round(green / points.length),
    b: Math.round(blue / points.length),
    alpha: Math.max(0, Math.min(1, alpha / points.length)),
  };
}

export async function filterDistinctSceneFrames<T extends { buffer: Buffer }>(
  frames: T[],
): Promise<T[]> {
  const distinct: T[] = [];
  let previousSignature: Buffer | null = null;

  for (const frame of frames) {
    const signature = await buildDiffSignature(frame.buffer);
    if (!previousSignature) {
      distinct.push(frame);
      previousSignature = signature;
      continue;
    }

    let diffTotal = 0;
    for (let index = 0; index < signature.length; index += 1) {
      diffTotal += Math.abs(signature[index] - previousSignature[index]);
    }
    const normalizedDiff = diffTotal / (signature.length * 255);
    if (normalizedDiff >= DIFF_THRESHOLD) {
      distinct.push(frame);
      previousSignature = signature;
    }
  }

  return distinct;
}

export async function stackSceneFrames(params: {
  width: number;
  frames: Buffer[];
  gap: number;
  canvasWidth?: number;
  frameLeft?: number;
  background?: RgbaColor;
}): Promise<Buffer> {
  const heights = await Promise.all(
    params.frames.map(async (frame) => {
      const metadata = await sharp(frame).metadata();
      if (!metadata.height) {
        throw new Error("Unable to read scene frame height");
      }
      return metadata.height;
    }),
  );
  const totalHeight =
    heights.reduce((sum, height) => sum + height, 0) + Math.max(0, params.frames.length - 1) * params.gap;

  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  let offsetTop = 0;
  for (let index = 0; index < params.frames.length; index += 1) {
    composites.push({
      input: params.frames[index],
      left: params.frameLeft ?? 0,
      top: offsetTop,
    });
    offsetTop += heights[index] + (index < params.frames.length - 1 ? params.gap : 0);
  }

  const canvasWidth = params.canvasWidth ?? params.width;
  const background = params.background ?? { r: 0, g: 0, b: 0, alpha: 1 };
  return sharp({
    create: {
      width: canvasWidth,
      height: totalHeight,
      channels: 4,
      background,
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

export async function replaceImageRegions(
  baseImage: Buffer,
  replacements: ImageRegionReplacement[],
): Promise<Buffer> {
  if (replacements.length === 0) {
    return baseImage;
  }

  const metadata = await sharp(baseImage).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Unable to read base image metadata");
  }

  const sorted = [...replacements].sort((left, right) => left.top - right.top);
  const segments: Buffer[] = [];
  let cursorTop = 0;

  for (const replacement of sorted) {
    if (replacement.top > cursorTop) {
      segments.push(
        await sharp(baseImage)
          .extract({
            left: 0,
            top: cursorTop,
            width: metadata.width,
            height: replacement.top - cursorTop,
          })
          .png()
          .toBuffer(),
      );
    }
    segments.push(replacement.replacement);
    cursorTop = replacement.top + replacement.height;
  }

  if (cursorTop < metadata.height) {
    segments.push(
      await sharp(baseImage)
        .extract({
          left: 0,
          top: cursorTop,
          width: metadata.width,
          height: metadata.height - cursorTop,
        })
        .png()
        .toBuffer(),
    );
  }

  const segmentHeights = await Promise.all(
    segments.map(async (segment) => {
      const segmentMeta = await sharp(segment).metadata();
      if (!segmentMeta.height) {
        throw new Error("Unable to read composed segment height");
      }
      return segmentMeta.height;
    }),
  );

  const outputHeight = segmentHeights.reduce((sum, height) => sum + height, 0);
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  let top = 0;
  for (let index = 0; index < segments.length; index += 1) {
    composites.push({
      input: segments[index],
      left: 0,
      top,
    });
    top += segmentHeights[index];
  }

  return sharp({
    create: {
      width: metadata.width,
      height: outputHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

export async function detectScrollSceneCandidates(page: Page): Promise<ScrollSceneGeometry[]> {
  const candidates = await page.evaluate(
    ({
      maxScenes,
      minStickyHeight,
      minStickyWidth,
      minHeightRatio,
      sceneAttr,
      stickyAttr,
    }) => {
      const viewportHeight = window.innerHeight || 0;
      const stickyElements = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((element) => {
        const style = window.getComputedStyle(element);
        return style.position === "sticky";
      });

      const seenOuter = new Set<HTMLElement>();
      const result: Array<{
        sceneId: string;
        outerLeft: number;
        outerTop: number;
        outerWidth: number;
        outerHeight: number;
        stickyLeft: number;
        stickyHeight: number;
        stickyWidth: number;
        background: {
          r: number;
          g: number;
          b: number;
          alpha: number;
        };
      }> = [];

      for (const sticky of stickyElements) {
        const stickyRect = sticky.getBoundingClientRect();
        if (stickyRect.height < minStickyHeight || stickyRect.width < minStickyWidth) {
          continue;
        }

        let outer: HTMLElement | null = sticky.parentElement;
        while (outer && outer !== document.body && outer !== document.documentElement) {
          const outerRect = outer.getBoundingClientRect();
          if (
            outerRect.height >= stickyRect.height * minHeightRatio &&
            outerRect.height >= viewportHeight * 1.5 &&
            outerRect.width >= stickyRect.width * 0.6
          ) {
            break;
          }
          outer = outer.parentElement;
        }

        if (!outer || seenOuter.has(outer)) {
          continue;
        }

        seenOuter.add(outer);
        const sceneId = String(result.length);
        outer.setAttribute(sceneAttr, sceneId);
        sticky.setAttribute(stickyAttr, sceneId);
        const outerRect = outer.getBoundingClientRect();
        result.push({
          sceneId,
          outerLeft: outerRect.left + window.scrollX,
          outerTop: outerRect.top + window.scrollY,
          outerWidth: outerRect.width,
          outerHeight: outerRect.height,
          stickyLeft: stickyRect.left + window.scrollX,
          stickyHeight: stickyRect.height,
          stickyWidth: stickyRect.width,
          background: (() => {
            let current: HTMLElement | null = sticky;
            while (current && current !== document.body && current !== document.documentElement) {
              const match = window
                .getComputedStyle(current)
                .backgroundColor.match(/rgba?\(([\d.\s]+),\s*([\d.\s]+),\s*([\d.\s]+)(?:,\s*([\d.]+))?\)/i);
              if (match) {
                const alpha = match[4] ? Number(match[4]) : 1;
                if (alpha > 0.01) {
                  return {
                    r: Math.round(Number(match[1] ?? 0)),
                    g: Math.round(Number(match[2] ?? 0)),
                    b: Math.round(Number(match[3] ?? 0)),
                    alpha,
                  };
                }
              }
              current = current.parentElement;
            }
            return { r: 255, g: 255, b: 255, alpha: 1 };
          })(),
        });
        if (result.length >= maxScenes) {
          break;
        }
      }

      return result.sort((left, right) => left.outerTop - right.outerTop);
    },
    {
      maxScenes: MAX_SCENES,
      minStickyHeight: MIN_STICKY_HEIGHT,
      minStickyWidth: MIN_STICKY_WIDTH,
      minHeightRatio: MIN_HEIGHT_RATIO,
      sceneAttr: SCENE_ATTR,
      stickyAttr: SCENE_STICKY_ATTR,
    },
  );

  return candidates.filter((candidate) =>
    isValidScrollSceneCandidate({
      outerHeight: candidate.outerHeight,
      outerWidth: candidate.outerWidth,
      stickyHeight: candidate.stickyHeight,
      stickyWidth: candidate.stickyWidth,
      viewportHeight: page.viewportSize()?.height ?? 0,
    }),
  );
}

async function settleSceneScroll(page: Page, targetScrollY: number): Promise<number> {
  const styleHandle = await page
    .addStyleTag({
      content: `
        html, body {
          scroll-behavior: auto !important;
        }
      `,
    })
    .catch(() => null);

  let lastScrollY = -1;
  let stableHits = 0;
  let settledScrollY = 0;

  try {
    for (let pass = 0; pass < SCROLL_SETTLE_MAX_PASSES; pass += 1) {
      await page.evaluate((nextScrollY) => {
        const scrollingElement = document.scrollingElement ?? document.documentElement ?? document.body;
        window.scrollTo(0, nextScrollY);
        if (scrollingElement) {
          scrollingElement.scrollTop = nextScrollY;
        }
      }, targetScrollY);

      await page.waitForTimeout(FRAME_SETTLE_MS);

      const currentScrollY = await page.evaluate(() => {
        const scrollingElement = document.scrollingElement ?? document.documentElement ?? document.body;
        return Math.max(window.scrollY, scrollingElement?.scrollTop ?? 0);
      });

      settledScrollY = currentScrollY;
      if (Math.abs(currentScrollY - lastScrollY) <= 2) {
        stableHits += 1;
      } else {
        stableHits = 0;
      }

      if (
        (Math.abs(currentScrollY - targetScrollY) <= SCROLL_SETTLE_TOLERANCE && stableHits >= 1) ||
        stableHits >= 2
      ) {
        break;
      }

      lastScrollY = currentScrollY;
    }
  } finally {
    if (styleHandle) {
      await styleHandle
        .evaluate((node) => (node instanceof Element ? node.remove() : undefined))
        .catch(() => undefined);
    }
  }

  return settledScrollY;
}

async function captureSceneFrames(params: {
  page: Page;
  candidate: ScrollSceneGeometry;
  documentHeight: number;
  viewportHeight: number;
}): Promise<SampledSceneFrame[]> {
  const scrollPositions = sampleSceneScrollPositions({
    outerTop: params.candidate.outerTop,
    outerHeight: params.candidate.outerHeight,
    stickyHeight: params.candidate.stickyHeight,
    viewportHeight: params.viewportHeight,
    documentHeight: params.documentHeight,
  });

  const frames: SampledSceneFrame[] = [];
  for (const scrollY of scrollPositions) {
    const settledScrollY = await settleSceneScroll(params.page, scrollY);

    const clip = await params.page.evaluate(
      ({ sceneId, stickyAttr }) => {
        const sticky = document.querySelector<HTMLElement>(`[${stickyAttr}="${sceneId}"]`);
        if (!sticky) {
          return null;
        }
        const rect = sticky.getBoundingClientRect();
        const documentWidth = Math.max(
          document.body?.scrollWidth ?? 0,
          document.documentElement?.scrollWidth ?? 0,
          window.innerWidth,
        );
        const absoluteLeft = rect.left + window.scrollX;
        const absoluteTop = rect.top + window.scrollY;
        const clipX = Math.max(0, Math.round(absoluteLeft));
        const clipWidth = Math.max(1, Math.min(Math.round(rect.width), Math.round(documentWidth) - clipX));
        return {
          x: clipX,
          y: Math.max(0, Math.round(absoluteTop)),
          width: clipWidth,
          height: Math.max(1, Math.round(rect.height)),
        };
      },
      {
        sceneId: params.candidate.sceneId,
        stickyAttr: SCENE_STICKY_ATTR,
      },
    );

    if (!clip) {
      continue;
    }

    const buffer = await params.page.screenshot({
      type: "png",
      fullPage: true,
      clip,
    });
    frames.push({
      buffer,
      scrollY: settledScrollY,
      clipLeft: clip.x,
      clipWidth: clip.width,
    });
  }

  return frames;
}

export async function captureScrollSceneReplacements(params: {
  page: Page;
  pageWidth: number;
  documentHeight: number;
  viewportHeight: number;
  dpr: number;
  log?: (level: "info" | "warn", message: string) => void;
}): Promise<ScrollSceneCaptureResult> {
  const candidates = await detectScrollSceneCandidates(params.page);
  if (candidates.length === 0) {
    return { replacements: [], debug: [] };
  }

  const replacements: ImageRegionReplacement[] = [];
  const debug: ScrollSceneReplacementDebug[] = [];

  for (const candidate of candidates) {
    params.log?.(
      "info",
      `scroll_scene_detected id=${candidate.sceneId} top=${Math.round(candidate.outerTop)} height=${Math.round(candidate.outerHeight)} stickyHeight=${Math.round(candidate.stickyHeight)}`,
    );

    try {
      const sampledFrames = await captureSceneFrames({
        page: params.page,
        candidate,
        documentHeight: params.documentHeight,
        viewportHeight: params.viewportHeight,
      });

      const distinctFrames = await filterDistinctSceneFrames(sampledFrames);
      if (distinctFrames.length < 2) {
        params.log?.(
          "warn",
          `scroll_scene_skipped id=${candidate.sceneId} reason=insufficient_distinct_frames sampled=${sampledFrames.length} distinct=${distinctFrames.length}`,
        );
        continue;
      }

      const background = await estimateFrameBackground(distinctFrames[0].buffer);
      const replacement = await stackSceneFrames({
        width: Math.round((distinctFrames[0]?.clipWidth ?? candidate.stickyWidth) * params.dpr),
        frames: distinctFrames.map((frame) => frame.buffer),
        gap: Math.round(FRAME_GAP_CSS * params.dpr),
        canvasWidth: Math.round(params.pageWidth * params.dpr),
        frameLeft: Math.round((distinctFrames[0]?.clipLeft ?? candidate.stickyLeft) * params.dpr),
        background,
      });
      const replacementMeta = await sharp(replacement).metadata();
      if (!replacementMeta.height) {
        throw new Error("Unable to read replacement metadata");
      }

      replacements.push({
        top: Math.round(candidate.outerTop * params.dpr),
        height: Math.round(candidate.outerHeight * params.dpr),
        replacement,
      });
      debug.push({
        sceneId: candidate.sceneId,
        outerTop: Math.round(candidate.outerTop),
        outerHeight: Math.round(candidate.outerHeight),
        stickyHeight: Math.round(candidate.stickyHeight),
        sampledFrameCount: sampledFrames.length,
        distinctFrameCount: distinctFrames.length,
        replacementHeight: Math.round(replacementMeta.height / params.dpr),
      });
      params.log?.(
        "info",
        `scroll_scene_replaced id=${candidate.sceneId} sampled=${sampledFrames.length} distinct=${distinctFrames.length} originalHeight=${Math.round(candidate.outerHeight)} replacementHeight=${Math.round(replacementMeta.height / params.dpr)}`,
      );
    } catch (error) {
      params.log?.(
        "warn",
        `scroll_scene_failed id=${candidate.sceneId} reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { replacements, debug };
}
