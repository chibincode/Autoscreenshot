import path from "node:path";
import { promises as fs } from "node:fs";
import { chromium } from "playwright";
import sharp from "sharp";
import { detectSections } from "./section-detector.js";
import { buildFixedSectionClip } from "./section-clip.js";
import {
  gotoWithFallback,
  isRecoverableNavigationError,
  type NavigationFallbackEvent,
} from "./navigation.js";
import { cleanupCaptureOverlays } from "./overlay-cleanup.js";
import { waitForRenderStability } from "./render-readiness.js";
import { stabilizeCaptureMotion } from "./motion-stabilizer.js";
import { captureFooterRevealReplacements } from "./footer-reveals.js";
import {
  controlBottomFixedOverlaysForCapture,
  captureTopOverlayReplacement,
  hideTopOverlaysForCapture,
  normalizeStickyElementsForCapture,
} from "./top-overlays.js";
import {
  captureScrollSceneReplacements,
  detectScrollSceneCandidates,
  replaceImageRegions,
} from "./scroll-scenes.js";
import type {
  CaptureRunResult,
  ParsedTask,
  SectionDetectionDebug,
  SectionScope,
} from "../types.js";
import { ensureDir, slugify, timestampForFile } from "../utils/manifest.js";

const JPG_EXTENSION = "jpg";
export const DPR_PIXEL_THRESHOLD = 120_000_000;
const FULLPAGE_INITIAL_SETTLE_MS = 2500;
const FULLPAGE_SINGLE_CAPTURE_MAX_HEIGHT_PX = 16_000;
const FULLPAGE_TILE_CSS_HEIGHT = 4_000;
const FULLPAGE_SLICE_SETTLE_MS = 60;
const IMAGE_READY_TIMEOUT_MS = 7_500;
const IMAGE_READY_POLL_MS = 250;
const IMAGE_READY_MIN_AREA_PX = 8_000;
const LAZY_WARMUP_MEDIA_TIMEOUT_MS = 4_500;
const LAZY_WARMUP_SETTLE_MS = 320;
const LAZY_WARMUP_POST_STABLE_MS = 700;
const OVERLAY_SWEEP_SETTLE_MS = 120;
const CAPTURE_PHASE_ATTR = "data-autosnap-capture-phase";
const HIDDEN_IMAGE_FALLBACK_STYLE_ATTR = "data-autosnap-hidden-image-fallback";
const VIDEO_EMBED_THUMBNAIL_FALLBACK_ATTR = "data-autosnap-video-thumbnail-fallback";
const CHROMIUM_CAPTURE_ARGS =
  process.platform === "darwin"
    ? ["--use-angle=metal", "--ignore-gpu-blocklist"]
    : ["--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"];

interface CaptureTaskOptions {
  outputDir: string;
  sectionScope: SectionScope;
  classicMaxSections: number;
  log?: (level: "info" | "warn", message: string) => void;
  onRecoverableNavigationRetry?: (event: { url: string; reason: string }) => void;
  navigationFallback?: {
    fallbackWaitUntil: "domcontentloaded";
    onFallback?: (event: NavigationFallbackEvent) => void;
  };
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown_domain";
  }
}

function sanitizeLabel(label: string): string {
  return slugify(label || "capture");
}

function buildFileName(
  domain: string,
  timestamp: string,
  kind: "fullpage" | "section",
  label: string,
  quality: number,
  dpr: number,
): string {
  const normalizedLabel = sanitizeLabel(label);
  return `${domain}_${timestamp}_${kind}_${normalizedLabel}_q${quality}_dpr${dpr}.${JPG_EXTENSION}`;
}

function emitLog(
  log: CaptureTaskOptions["log"],
  level: "info" | "warn",
  message: string,
): void {
  if (log) {
    log(level, message);
  }
}

async function sweepCaptureOverlays(params: {
  page: import("playwright").Page;
  log?: CaptureTaskOptions["log"];
  phase: "pre_capture" | "tile_capture";
  maxPasses?: number;
}): Promise<number> {
  await Promise.resolve(
    params.page.evaluate(({ attrName, phase }) => {
      document.documentElement?.setAttribute(attrName, phase);
    }, { attrName: CAPTURE_PHASE_ATTR, phase: params.phase }),
  ).catch(() => undefined);

  try {
    const result = await cleanupCaptureOverlays(params.page, {
      log: params.log,
      phase: params.phase,
      maxPasses: params.maxPasses,
    });
    const handled = result?.handled ?? 0;
    if (handled > 0) {
      await params.page.waitForTimeout(OVERLAY_SWEEP_SETTLE_MS);
    }
    return handled;
  } finally {
    await Promise.resolve(
      params.page.evaluate((attrName) => {
        document.documentElement?.removeAttribute(attrName);
      }, CAPTURE_PHASE_ATTR)
    ).catch(() => undefined);
  }
}

async function getPageDimensions(page: import("playwright").Page): Promise<{
  width: number;
  height: number;
}> {
  return page.evaluate(() => {
    const body = document.body;
    const html = document.documentElement;
    const width = Math.max(
      body?.scrollWidth ?? 0,
      body?.offsetWidth ?? 0,
      html?.clientWidth ?? 0,
      html?.scrollWidth ?? 0,
      html?.offsetWidth ?? 0,
    );
    const height = Math.max(
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
      html?.clientHeight ?? 0,
      html?.scrollHeight ?? 0,
      html?.offsetHeight ?? 0,
    );
    return { width, height };
  });
}

/**
 * Captures a tall page by scrolling the real viewport and stitching the slices.
 *
 * Chromium's `captureBeyondViewport` (used by both `fullPage: true` and the tiled
 * CDP path) fails to rasterize some composited off-screen elements, which silently
 * drops their background paint even though the DOM and computed styles are correct.
 * Screenshotting only what is actually in the viewport avoids that entirely, and
 * unlike resizing the viewport to the document height it keeps `vh` units intact.
 */
async function captureFullPageByScrollStitch(params: {
  page: import("playwright").Page;
  pageWidth: number;
  pageHeight: number;
  dpr: number;
  log?: CaptureTaskOptions["log"];
  beforeSliceCapture?: () => Promise<void>;
}): Promise<Buffer> {
  const viewportHeight = params.page.viewportSize()?.height ?? 0;
  if (viewportHeight <= 0) {
    throw new Error("scroll stitch requires a fixed viewport height");
  }

  const outputWidth = Math.max(1, Math.round(params.pageWidth * params.dpr));
  const outputHeight = Math.max(1, Math.round(params.pageHeight * params.dpr));
  const maxScroll = Math.max(0, Math.round(params.pageHeight - viewportHeight));
  const slices: Array<{ buffer: Buffer; top: number }> = [];
  let restoreTopOverlays: (() => Promise<void>) | null = null;
  const bottomFixedOverlays = await controlBottomFixedOverlaysForCapture({
    page: params.page,
    pageWidth: params.pageWidth,
    viewportHeight,
    log: params.log,
  });

  // Smooth scrolling would desync scrollTo() from the screenshot that follows it.
  const styleHandle = await params.page
    .addStyleTag({
      content: `
        html, body {
          scroll-behavior: auto !important;
        }
      `,
    })
    .catch(() => null);

  try {
    let sliceCount = 0;
    for (let top = 0; top < params.pageHeight; top += viewportHeight) {
      const isFinalSlice = top + viewportHeight >= params.pageHeight;
      await bottomFixedOverlays.setVisible(isFinalSlice);
      const scrollTarget = Math.min(top, maxScroll);
      // Scroll and let the new position paint. Two frames is enough for the
      // compositor, and far cheaper than a fixed sleep once a page needs many slices.
      await params.page.evaluate(
        (scrollY) =>
          new Promise<void>((resolve) => {
            window.scrollTo(0, scrollY);
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
        scrollTarget,
      );
      await params.page.waitForTimeout(FULLPAGE_SLICE_SETTLE_MS);
      await params.beforeSliceCapture?.();

      // Pinned headers would otherwise repeat in every slice below the first.
      if (top > 0 && !restoreTopOverlays) {
        restoreTopOverlays = await hideTopOverlaysForCapture({
          page: params.page,
          pageWidth: params.pageWidth,
          viewportHeight,
          log: params.log,
        });
      }

      const screenshot = await params.page.screenshot({ type: "png", fullPage: false });
      // The final slice is clamped to maxScroll, so drop the rows it repeats.
      const offsetWithinSlice = Math.max(0, Math.round((top - scrollTarget) * params.dpr));
      const remaining = Math.round(Math.min(viewportHeight, params.pageHeight - top) * params.dpr);
      // Only the clamped last slice needs cropping; re-encoding every other one
      // would add a full decode/encode round-trip per slice for nothing.
      let buffer = screenshot;
      if (offsetWithinSlice > 0 || remaining < Math.round(viewportHeight * params.dpr)) {
        const shot = await sharp(screenshot).metadata();
        const available = Math.max(0, (shot.height ?? 0) - offsetWithinSlice);
        buffer = await sharp(screenshot)
          .extract({
            left: 0,
            top: offsetWithinSlice,
            width: Math.max(1, Math.min(outputWidth, shot.width ?? outputWidth)),
            height: Math.max(1, Math.min(remaining, available)),
          })
          .png()
          .toBuffer();
      }
      slices.push({ buffer, top: Math.round(top * params.dpr) });
      sliceCount += 1;
    }

    emitLog(
      params.log,
      "info",
      `fullpage_capture_mode=scroll_stitch pageHeight=${Math.round(params.pageHeight)} dpr=${params.dpr} viewportHeight=${viewportHeight} slices=${sliceCount}`,
    );
  } finally {
    await restoreTopOverlays?.();
    await bottomFixedOverlays.restore();
    if (styleHandle) {
      await styleHandle
        .evaluate((node) => (node instanceof Element ? node.remove() : undefined))
        .catch(() => undefined);
    }
    await params.page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
  }

  return sharp({
    create: {
      width: outputWidth,
      height: outputHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(slices.map((slice) => ({ input: slice.buffer, left: 0, top: slice.top })))
    .png()
    .toBuffer();
}

async function captureFullPageByTiles(params: {
  page: import("playwright").Page;
  pageWidth: number;
  pageHeight: number;
  dpr: number;
  log?: CaptureTaskOptions["log"];
  beforeSliceCapture?: () => Promise<void>;
}): Promise<Buffer> {
  const client = await params.page.context().newCDPSession(params.page);
  const tileHeight = Math.max(1, Math.min(FULLPAGE_TILE_CSS_HEIGHT, Math.round(params.pageHeight)));
  const outputWidth = Math.max(1, Math.round(params.pageWidth * params.dpr));
  const outputHeight = Math.max(1, Math.round(params.pageHeight * params.dpr));
  const tiles: Array<{ buffer: Buffer; top: number }> = [];
  let restoreTopOverlays: (() => Promise<void>) | null = null;
  const bottomFixedOverlays = await controlBottomFixedOverlaysForCapture({
    page: params.page,
    pageWidth: params.pageWidth,
    viewportHeight: params.page.viewportSize()?.height ?? Math.min(params.pageHeight, tileHeight),
    log: params.log,
  });

  try {
    let sliceCount = 0;
    for (let top = 0; top < params.pageHeight; top += tileHeight) {
      await bottomFixedOverlays.setVisible(top === 0);
      await params.beforeSliceCapture?.();
      if (top > 0 && !restoreTopOverlays) {
        restoreTopOverlays = await hideTopOverlaysForCapture({
          page: params.page,
          pageWidth: params.pageWidth,
          viewportHeight: params.page.viewportSize()?.height ?? Math.min(params.pageHeight, tileHeight),
          log: params.log,
        });
      }
      const height = Math.max(1, Math.min(tileHeight, Math.round(params.pageHeight - top)));
      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: top,
          width: Math.max(1, Math.round(params.pageWidth)),
          height,
          scale: params.dpr,
        },
      });
      tiles.push({
        buffer: Buffer.from(screenshot.data, "base64"),
        top: Math.round(top * params.dpr),
      });
      sliceCount += 1;
    }

    emitLog(
      params.log,
      "info",
      `fullpage_capture_mode=tiled pageHeight=${Math.round(params.pageHeight)} dpr=${params.dpr} tileCssHeight=${tileHeight} slices=${sliceCount}`,
    );
  } finally {
    await restoreTopOverlays?.();
    await bottomFixedOverlays.restore();
    await client.detach().catch(() => undefined);
  }

  return sharp({
    create: {
      width: outputWidth,
      height: outputHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(
      tiles.map((tile) => ({
        input: tile.buffer,
        left: 0,
        top: tile.top,
      })),
    )
    .png()
    .toBuffer();
}

async function captureFullPageImage(params: {
  page: import("playwright").Page;
  pageWidth: number;
  pageHeight: number;
  dpr: number;
  log?: CaptureTaskOptions["log"];
  beforeTileCapture?: () => Promise<void>;
}): Promise<Buffer> {
  const physicalHeight = Math.max(1, Math.round(params.pageHeight * params.dpr));
  const viewportHeight = params.page.viewportSize()?.height ?? 0;
  const restoreStickyElements = await normalizeStickyElementsForCapture({
    page: params.page,
    log: params.log,
  });
  try {
    // Anything taller than the viewport risks losing off-screen paint to
    // captureBeyondViewport, so stitch real viewport slices instead.
    if (viewportHeight > 0 && params.pageHeight > viewportHeight) {
      try {
        return await captureFullPageByScrollStitch({
          ...params,
          beforeSliceCapture: params.beforeTileCapture,
        });
      } catch (error) {
        emitLog(
          params.log,
          "warn",
          `fullpage_capture_scroll_stitch_failed pageHeight=${Math.round(params.pageHeight)} dpr=${params.dpr} reason=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (physicalHeight <= FULLPAGE_SINGLE_CAPTURE_MAX_HEIGHT_PX) {
      emitLog(
        params.log,
        "info",
        `fullpage_capture_mode=single pageHeight=${Math.round(params.pageHeight)} dpr=${params.dpr} physicalHeight=${physicalHeight}`,
      );
      return params.page.screenshot({
        type: "png",
        fullPage: true,
      });
    }

    try {
      return await captureFullPageByTiles({
        ...params,
        beforeSliceCapture: params.beforeTileCapture,
      });
    } catch (error) {
      emitLog(
        params.log,
        "warn",
        `fullpage_capture_tiled_failed pageHeight=${Math.round(params.pageHeight)} dpr=${params.dpr} reason=${error instanceof Error ? error.message : String(error)}`,
      );
      return params.page.screenshot({
        type: "png",
        fullPage: true,
      });
    }
  } finally {
    await restoreStickyElements();
  }
}

async function captureSectionClipImage(params: {
  page: import("playwright").Page;
  clip: { x: number; y: number; width: number; height: number };
  pageHeight: number;
  viewportHeight: number;
  dpr: number;
  quality: number;
  label: string;
  outputPath: string;
  log?: CaptureTaskOptions["log"];
}): Promise<void> {
  const fitsInViewport = params.clip.height <= params.viewportHeight && params.clip.y >= 0;
  if (fitsInViewport) {
    const scrollY = Math.max(
      0,
      Math.min(Math.round(params.clip.y), Math.max(0, Math.round(params.pageHeight - params.viewportHeight))),
    );
    await params.page.evaluate((targetY) => window.scrollTo(0, targetY), scrollY);
    await params.page.waitForTimeout(120);
    await waitForRenderableMedia(params.page, params.log, "viewport");
    await stabilizeCaptureMotion(params.page, params.log, "section_clip");

    const actualScrollY = await params.page
      .evaluate(() => Math.round(window.scrollY || document.documentElement.scrollTop || 0))
      .catch(() => scrollY);
    const viewportClipY = params.clip.y - actualScrollY;
    const canCropViewport =
      viewportClipY >= 0 &&
      viewportClipY + params.clip.height <= params.viewportHeight &&
      params.clip.x >= 0 &&
      params.clip.width > 0 &&
      params.clip.height > 0;

    if (canCropViewport) {
      const viewportBuffer = await params.page.screenshot({
        type: "png",
        fullPage: false,
      });
      await sharp(viewportBuffer)
        .extract({
          left: Math.max(0, Math.round(params.clip.x * params.dpr)),
          top: Math.max(0, Math.round(viewportClipY * params.dpr)),
          width: Math.max(1, Math.round(params.clip.width * params.dpr)),
          height: Math.max(1, Math.round(params.clip.height * params.dpr)),
        })
        .jpeg({ quality: params.quality })
        .toFile(params.outputPath);
      emitLog(
        params.log,
        "info",
        `section_capture_mode=viewport_crop label=${params.label} scrollY=${actualScrollY}`,
      );
      return;
    }
  }

  await params.page.screenshot({
    path: params.outputPath,
    type: "jpeg",
    quality: params.quality,
    fullPage: true,
    clip: params.clip,
  });
  emitLog(params.log, "info", `section_capture_mode=document_clip label=${params.label}`);
}

export function resolveDpr(
  requested: ParsedTask["image"]["dpr"],
  pageWidth: number,
  pageHeight: number,
): 1 | 2 {
  if (requested === 1 || requested === 2) {
    return requested;
  }
  const candidateDpr = 2;
  const estimatedPixels = pageWidth * pageHeight * candidateDpr * candidateDpr;
  if (estimatedPixels > DPR_PIXEL_THRESHOLD) {
    return 1;
  }
  return candidateDpr;
}

export function isRetryableCaptureError(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error ?? "");
  return /ENOMEM|heap|memory|crash|Target closed|Target crashed|Target page, context or browser has been closed|browserContext\.close: Target page, context or browser has been closed|ContextResult::kFatalFailure|Failed to create context|timeout/i.test(
    text,
  );
}

async function warmupLazyLoad(
  page: import("playwright").Page,
  log?: CaptureTaskOptions["log"],
): Promise<void> {
  const docHeight = await page.evaluate(() => document.documentElement.scrollHeight || 0);
  const steps = Math.max(4, Math.min(12, Math.ceil(docHeight / 1200)));
  for (let i = 1; i <= steps; i += 1) {
    const y = Math.round((docHeight * i) / steps);
    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
    await page.waitForTimeout(LAZY_WARMUP_SETTLE_MS);
    await waitForRenderStability(page, {
      log,
      phase: "lazy_warmup",
      timeoutMs: LAZY_WARMUP_MEDIA_TIMEOUT_MS,
      stablePassCount: 1,
    });
    await page.waitForTimeout(LAZY_WARMUP_POST_STABLE_MS);
    await waitForRenderableMedia(page, log, "viewport", LAZY_WARMUP_MEDIA_TIMEOUT_MS);
  }
}

type ImageReadyScope = "document" | "viewport";

interface BackgroundImageReadyResult {
  total: number;
  loaded: number;
  failed: number;
  timedOut: number;
}

async function getPendingRenderableImageCount(
  page: import("playwright").Page,
  scope: ImageReadyScope,
): Promise<number> {
  return page.evaluate(({ minAreaPx, scope }) => {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const documentHeight = document.documentElement.scrollHeight || document.body?.scrollHeight || 0;
    const lazyLoadMargin = Math.max(viewportHeight * 1.5, 1200);

    return Array.from(document.images).filter((image) => {
      const rect = image.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      const bottom = rect.bottom + window.scrollY;
      const width = rect.width || image.width || 0;
      const height = rect.height || image.height || 0;

      if (width * height < minAreaPx) {
        return false;
      }

      if (scope === "viewport" && (rect.bottom < -lazyLoadMargin || rect.top > viewportHeight + lazyLoadMargin)) {
        return false;
      }

      if (scope === "document" && (bottom < -lazyLoadMargin || top > documentHeight + lazyLoadMargin)) {
        return false;
      }

      const src = image.currentSrc || image.src;
      if (!src) {
        return false;
      }

      return !image.complete || image.naturalWidth === 0 || image.naturalHeight === 0;
    }).length;
  }, { minAreaPx: IMAGE_READY_MIN_AREA_PX, scope });
}

async function decodeRenderableImages(page: import("playwright").Page, scope: ImageReadyScope): Promise<void> {
  await page
    .evaluate(({ minAreaPx, scope }) => {
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const documentHeight = document.documentElement.scrollHeight || document.body?.scrollHeight || 0;
      const lazyLoadMargin = Math.max(viewportHeight * 1.5, 1200);
      const images = Array.from(document.images).filter((image) => {
        const rect = image.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        const bottom = rect.bottom + window.scrollY;
        const width = rect.width || image.width || 0;
        const height = rect.height || image.height || 0;

        if (width * height < minAreaPx) {
          return false;
        }

        if (scope === "viewport" && (rect.bottom < -lazyLoadMargin || rect.top > viewportHeight + lazyLoadMargin)) {
          return false;
        }

        if (scope === "document" && (bottom < -lazyLoadMargin || top > documentHeight + lazyLoadMargin)) {
          return false;
        }

        return Boolean(image.currentSrc || image.src);
      });

      return Promise.allSettled(
        images.map((image) => {
          if (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0) {
            return Promise.reject(new Error("image_not_loaded"));
          }
          return image.decode ? image.decode() : Promise.resolve();
        }),
      );
    }, { minAreaPx: IMAGE_READY_MIN_AREA_PX, scope })
    .catch(() => undefined);
}

async function waitForRenderableImages(
  page: import("playwright").Page,
  log?: CaptureTaskOptions["log"],
  scope: ImageReadyScope = "viewport",
  timeoutMs: number = IMAGE_READY_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  let pendingCount = await getPendingRenderableImageCount(page, scope).catch(() => 0);

  while (pendingCount > 0 && Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(IMAGE_READY_POLL_MS);
    pendingCount = await getPendingRenderableImageCount(page, scope).catch(() => pendingCount);
  }

  await decodeRenderableImages(page, scope);

  const elapsedMs = Date.now() - startedAt;
  if (pendingCount > 0) {
    emitLog(log, "warn", `image_ready_timeout scope=${scope} pending=${pendingCount} elapsedMs=${elapsedMs}`);
    return;
  }

  emitLog(log, "info", `image_ready_complete scope=${scope} elapsedMs=${elapsedMs}`);
}

async function preloadRenderableBackgroundImages(
  page: import("playwright").Page,
  scope: ImageReadyScope,
  timeoutMs: number,
): Promise<BackgroundImageReadyResult> {
  return page
    .evaluate(
      async ({ minAreaPx, scope, timeoutMs }) => {
        type BackgroundStatus = "loaded" | "failed" | "timeout";
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const documentHeight = document.documentElement.scrollHeight || document.body?.scrollHeight || 0;
        const lazyLoadMargin = Math.max(viewportHeight * 1.5, 1200);
        const urlPattern = /url\((?:"([^"]+)"|'([^']+)'|([^)]*?))\)/g;
        const windowWithCache = window as typeof window & {
          __autosnapBackgroundImageReady?: Record<string, BackgroundStatus>;
        };
        const readyCache = (windowWithCache.__autosnapBackgroundImageReady ??= {});
        const urls = new Set<string>();

        const addUrlsFromValue = (value: string): void => {
          if (!value || value === "none") {
            return;
          }

          for (const match of value.matchAll(urlPattern)) {
            const rawUrl = (match[1] ?? match[2] ?? match[3] ?? "").trim();
            if (!rawUrl || /^(data|blob|about):/i.test(rawUrl) || rawUrl.startsWith("#")) {
              continue;
            }

            try {
              urls.add(new URL(rawUrl, document.baseURI).href);
            } catch {
              urls.add(rawUrl);
            }
          }
        };

        const addUrlsFromStyle = (style: CSSStyleDeclaration): void => {
          addUrlsFromValue(style.backgroundImage);
          addUrlsFromValue(style.borderImageSource);
          addUrlsFromValue(style.maskImage);
          addUrlsFromValue(style.getPropertyValue("-webkit-mask-image"));
        };

        for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
          const rect = element.getBoundingClientRect();
          const top = rect.top + window.scrollY;
          const bottom = rect.bottom + window.scrollY;
          const width = rect.width || element.offsetWidth || 0;
          const height = rect.height || element.offsetHeight || 0;

          if (width * height < minAreaPx) {
            continue;
          }

          if (scope === "viewport" && (rect.bottom < -lazyLoadMargin || rect.top > viewportHeight + lazyLoadMargin)) {
            continue;
          }

          if (scope === "document" && (bottom < -lazyLoadMargin || top > documentHeight + lazyLoadMargin)) {
            continue;
          }

          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0.01) {
            continue;
          }

          addUrlsFromStyle(style);
          addUrlsFromStyle(window.getComputedStyle(element, "::before"));
          addUrlsFromStyle(window.getComputedStyle(element, "::after"));
        }

        const probeUrl = (url: string): Promise<BackgroundStatus> => {
          if (readyCache[url] === "loaded" || readyCache[url] === "failed") {
            return Promise.resolve(readyCache[url]);
          }

          return new Promise<BackgroundStatus>((resolve) => {
            const image = new Image();
            let settled = false;
            const settle = (status: BackgroundStatus): void => {
              if (settled) {
                return;
              }
              settled = true;
              window.clearTimeout(timer);
              readyCache[url] = status;
              resolve(status);
            };
            const timer = window.setTimeout(() => settle("timeout"), timeoutMs);

            image.decoding = "async";
            image.onload = () => {
              if (image.decode) {
                void image.decode().finally(() => settle("loaded"));
                return;
              }
              settle("loaded");
            };
            image.onerror = () => settle("failed");
            image.src = url;

            if (image.complete) {
              settle(image.naturalWidth > 0 && image.naturalHeight > 0 ? "loaded" : "failed");
            }
          });
        };

        const statuses = await Promise.all(Array.from(urls, (url) => probeUrl(url)));
        return {
          total: statuses.length,
          loaded: statuses.filter((status) => status === "loaded").length,
          failed: statuses.filter((status) => status === "failed").length,
          timedOut: statuses.filter((status) => status === "timeout").length,
        };
      },
      { minAreaPx: IMAGE_READY_MIN_AREA_PX, scope, timeoutMs },
    )
    .catch(() => ({
      total: 0,
      loaded: 0,
      failed: 0,
      timedOut: 0,
    }));
}

async function waitForRenderableBackgroundImages(
  page: import("playwright").Page,
  log?: CaptureTaskOptions["log"],
  scope: ImageReadyScope = "viewport",
  timeoutMs: number = IMAGE_READY_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  const result = await preloadRenderableBackgroundImages(page, scope, timeoutMs);
  const elapsedMs = Date.now() - startedAt;

  if (result.total === 0) {
    return;
  }

  if (result.timedOut > 0) {
    emitLog(
      log,
      "warn",
      `background_image_ready_timeout scope=${scope} timedOut=${result.timedOut} failed=${result.failed} total=${result.total} elapsedMs=${elapsedMs}`,
    );
    return;
  }

  emitLog(
    log,
    "info",
    `background_image_ready_complete scope=${scope} loaded=${result.loaded} failed=${result.failed} elapsedMs=${elapsedMs}`,
  );
}

async function waitForRenderableMedia(
  page: import("playwright").Page,
  log?: CaptureTaskOptions["log"],
  scope: ImageReadyScope = "viewport",
  timeoutMs: number = IMAGE_READY_TIMEOUT_MS,
): Promise<void> {
  await waitForRenderableImages(page, log, scope, timeoutMs);
  await waitForRenderableBackgroundImages(page, log, scope, timeoutMs);
}

async function installHiddenImageCaptureFallback(
  page: import("playwright").Page,
  log?: CaptureTaskOptions["log"],
): Promise<void> {
  const fallbackCount = await page
    .evaluate(
      ({ attrName, minAreaPx }) => {
        const existing = document.querySelector(`style[${attrName}]`);
        if (!existing) {
          const style = document.createElement("style");
          style.setAttribute(attrName, "true");
          style.textContent = `
            [role="img"] img.invisible,
            [role="img"] img[style*="visibility: hidden"] {
              visibility: visible !important;
              opacity: 1 !important;
              object-fit: cover !important;
              z-index: 1 !important;
            }
          `;
          document.head.appendChild(style);
        }

        return Array.from(document.querySelectorAll<HTMLImageElement>('[role="img"] img')).filter((image) => {
          const rect = image.getBoundingClientRect();
          const width = rect.width || image.width || 0;
          const height = rect.height || image.height || 0;
          const style = window.getComputedStyle(image);

          if (width * height < minAreaPx) {
            return false;
          }

          if (style.visibility !== "hidden" && !image.classList.contains("invisible")) {
            return false;
          }

          return Boolean(image.currentSrc || image.src);
        }).length;
      },
      { attrName: HIDDEN_IMAGE_FALLBACK_STYLE_ATTR, minAreaPx: IMAGE_READY_MIN_AREA_PX },
    )
    .catch(() => 0);

  if (fallbackCount > 0) {
    emitLog(log, "info", `hidden_image_capture_fallback applied=${fallbackCount}`);
    await page.waitForTimeout(120);
  }
}

async function installVideoEmbedThumbnailFallback(
  page: import("playwright").Page,
  log?: CaptureTaskOptions["log"],
): Promise<void> {
  const result = await page
    .evaluate(
      async ({ attrName, minAreaPx }) => {
        let candidateCount = 0;
        let parsedVideoCount = 0;
        let loadedThumbnailCount = 0;
        const iframes = Array.from(
          document.querySelectorAll<HTMLIFrameElement>(
            'iframe[src*="youtube.com/embed"], iframe[src*="youtube-nocookie.com/embed"]',
          ),
        );
        let applied = 0;

        for (const iframe of iframes) {
          const rect = iframe.getBoundingClientRect();
          if (rect.width * rect.height < minAreaPx) {
            continue;
          }
          candidateCount += 1;

          let videoId: string | null = null;
          try {
            const url = new URL(iframe.src || iframe.getAttribute("src") || "", window.location.href);
            if (/(^|\.)youtube(?:-nocookie)?\.com$/i.test(url.hostname)) {
              const embedMatch = url.pathname.match(/\/embed\/([^/?#]+)/i);
              videoId = embedMatch?.[1] ?? url.searchParams.get("v");
            }
          } catch {
            videoId = null;
          }
          if (!videoId) {
            continue;
          }
          parsedVideoCount += 1;

          const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
          const preload = new Image();
          preload.decoding = "async";
          preload.src = thumbnailUrl;
          await preload.decode().catch(() => undefined);
          loadedThumbnailCount += 1;

          const container =
            iframe.closest<HTMLElement>(".w-embed-youtubevideo") ??
            iframe.parentElement;
          if (!container) {
            continue;
          }

          container.setAttribute(attrName, videoId);
          container.style.backgroundImage = `url("${thumbnailUrl}")`;
          container.style.backgroundSize = "cover";
          container.style.backgroundPosition = "center";
          container.style.backgroundRepeat = "no-repeat";
          container.style.backgroundColor = "#111827";
          iframe.style.opacity = "0";
          iframe.style.visibility = "hidden";
          applied += 1;
        }

        if (applied > 0 && !document.querySelector(`style[${attrName}]`)) {
          const style = document.createElement("style");
          style.setAttribute(attrName, "true");
          style.textContent = `
            [${attrName}] {
              position: relative;
              overflow: hidden;
            }
            [${attrName}]::after {
              content: "";
              position: absolute;
              left: 50%;
              top: 50%;
              width: 68px;
              height: 48px;
              border-radius: 14px;
              transform: translate(-50%, -50%);
              background: rgba(15, 23, 42, 0.72);
              box-shadow: 0 10px 28px rgba(15, 23, 42, 0.24);
            }
            [${attrName}]::before {
              content: "";
              position: absolute;
              z-index: 1;
              left: 50%;
              top: 50%;
              width: 0;
              height: 0;
              border-top: 11px solid transparent;
              border-bottom: 11px solid transparent;
              border-left: 18px solid rgba(255, 255, 255, 0.92);
              transform: translate(-34%, -50%);
            }
          `;
          document.head.appendChild(style);
        }

        return {
          applied,
          candidateCount,
          parsedVideoCount,
          loadedThumbnailCount,
        };
      },
      { attrName: VIDEO_EMBED_THUMBNAIL_FALLBACK_ATTR, minAreaPx: IMAGE_READY_MIN_AREA_PX },
    )
    .catch((error) => ({
      applied: 0,
      candidateCount: 0,
      parsedVideoCount: 0,
      loadedThumbnailCount: 0,
      error: error instanceof Error ? error.message : String(error),
    }));

  if (result.applied > 0) {
    emitLog(log, "info", `video_embed_thumbnail_fallback applied=${result.applied}`);
    await page.waitForTimeout(700);
    return;
  }

  if (result.candidateCount > 0 || "error" in result) {
    emitLog(
      log,
      "warn",
      `video_embed_thumbnail_fallback skipped candidates=${result.candidateCount} parsed=${result.parsedVideoCount} thumbnails=${result.loadedThumbnailCount}${"error" in result ? ` error=${result.error}` : ""}`,
    );
  }
}

export async function stabilizeFullPageViewport(
  page: import("playwright").Page,
  url: string,
  log?: CaptureTaskOptions["log"],
): Promise<{ stable: boolean; finalScrollY: number }> {
  const styleHandle = await page
    .addStyleTag({
      content: `
        html, body {
          scroll-behavior: auto !important;
        }
      `,
    })
    .catch(() => null);

  let stableHits = 0;
  let finalScrollY = -1;
  let finalScrollTop = -1;

  try {
    for (let index = 0; index < 14; index += 1) {
      const state = await page.evaluate(() => {
        const scrollingElement = document.scrollingElement ?? document.documentElement ?? document.body;
        window.scrollTo(0, 0);
        if (document.documentElement) {
          document.documentElement.scrollTop = 0;
        }
        if (document.body) {
          document.body.scrollTop = 0;
        }
        if (scrollingElement) {
          scrollingElement.scrollTop = 0;
        }
        return {
          scrollY: window.scrollY,
          scrollTop: scrollingElement?.scrollTop ?? 0,
        };
      });

      finalScrollY = state.scrollY;
      finalScrollTop = state.scrollTop;
      if (state.scrollY === 0 && state.scrollTop === 0) {
        stableHits += 1;
      } else {
        stableHits = 0;
      }

      if (stableHits >= 2) {
        emitLog(log, "info", `fullpage_scroll_stabilized url=${url} scrollY=0`);
        return {
          stable: true,
          finalScrollY: 0,
        };
      }

      await page.waitForTimeout(80);
    }
  } finally {
    if (styleHandle) {
      await styleHandle
        .evaluate((node) => (node instanceof Element ? node.remove() : undefined))
        .catch(() => undefined);
    }
  }

  emitLog(
    log,
    "warn",
    `fullpage_scroll_unstable url=${url} finalScrollY=${Math.max(finalScrollY, finalScrollTop)}`,
  );
  return {
    stable: false,
    finalScrollY: Math.max(finalScrollY, finalScrollTop),
  };
}

async function captureOnce(
  task: ParsedTask,
  options: CaptureTaskOptions,
  forcedDpr: number,
): Promise<CaptureRunResult> {
  await ensureDir(options.outputDir);
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_CAPTURE_ARGS });
  const context = await browser.newContext({
    viewport: task.viewport,
    deviceScaleFactor: forcedDpr,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();

  try {
    await gotoWithFallback({
      page,
      url: task.url,
      waitUntil: task.waitUntil,
      timeoutMs: 75_000,
      phase: "capture",
      fallbackWaitUntil: options.navigationFallback?.fallbackWaitUntil,
      onFallback: options.navigationFallback?.onFallback,
    });
    const hasFullPageCapture = task.captures.some((item) => item.mode === "fullPage");
    let fullPageImageReadyScope: ImageReadyScope = "viewport";
    await page.waitForTimeout(hasFullPageCapture ? FULLPAGE_INITIAL_SETTLE_MS : 400);
    await waitForRenderStability(page, {
      log: options.log,
      phase: hasFullPageCapture ? "initial_fullpage" : "initial_section",
      timeoutMs: hasFullPageCapture ? 10_000 : 4_000,
    });
    await sweepCaptureOverlays({
      page,
      log: options.log,
      phase: "pre_capture",
    });
    await stabilizeCaptureMotion(page, options.log, "initial");
    const topOverlayReplacements = hasFullPageCapture
      ? await captureTopOverlayReplacement({
          page,
          pageWidth: task.viewport.width,
          viewportHeight: task.viewport.height,
          dpr: forcedDpr,
          log: options.log,
        })
      : [];
    if (hasFullPageCapture) {
      const earlyScrollScenes = await detectScrollSceneCandidates(page);
      if (earlyScrollScenes.length === 0) {
        await warmupLazyLoad(page, options.log);
        fullPageImageReadyScope = "document";
        await page.waitForTimeout(400);
      } else {
        emitLog(options.log, "info", `scroll_scene_preserve_layout count=${earlyScrollScenes.length}`);
      }
    } else {
      await warmupLazyLoad(page, options.log);
      await page.waitForTimeout(400);
    }
    await sweepCaptureOverlays({
      page,
      log: options.log,
      phase: "pre_capture",
    });
    await stabilizeCaptureMotion(page, options.log, "post_warmup");

    const pageTitle = (await page.title()).trim() || undefined;
    let pageSize = await getPageDimensions(page);
    const domain = sanitizeLabel(extractDomain(task.url));
    const timestamp = timestampForFile();
    const assets: CaptureRunResult["assets"] = [];
    let sectionDebug: SectionDetectionDebug | undefined;
    let scrollSceneDebug: CaptureRunResult["scrollSceneDebug"];

    if (hasFullPageCapture) {
      await stabilizeFullPageViewport(page, task.url, options.log);
      await waitForRenderStability(page, {
        log: options.log,
        phase: "pre_fullpage",
        timeoutMs: 6_000,
      });
      await waitForRenderableMedia(page, options.log, fullPageImageReadyScope);
      await installHiddenImageCaptureFallback(page, options.log);
      await installVideoEmbedThumbnailFallback(page, options.log);
      await sweepCaptureOverlays({
        page,
        log: options.log,
        phase: "pre_capture",
      });
      pageSize = await getPageDimensions(page);
      const fullName = buildFileName(
        domain,
        timestamp,
        "fullpage",
        "full_page",
        task.image.quality,
        forcedDpr,
      );
      const fullPath = path.join(options.outputDir, fullName);
      const rawFullPageBuffer = await captureFullPageImage({
        page,
        pageWidth: pageSize.width,
        pageHeight: pageSize.height,
        dpr: forcedDpr,
        log: options.log,
        beforeTileCapture: async () => {
          await stabilizeCaptureMotion(page, options.log, "tile_capture");
          await sweepCaptureOverlays({
            page,
            log: options.log,
            phase: "tile_capture",
            maxPasses: 1,
          });
        },
      });
      const scrollSceneResult = await captureScrollSceneReplacements({
        baseImage: rawFullPageBuffer,
        page,
        pageWidth: pageSize.width,
        documentHeight: pageSize.height,
        viewportHeight: task.viewport.height,
        dpr: forcedDpr,
        log: options.log,
      });
      const footerRevealReplacements = await captureFooterRevealReplacements({
        page,
        pageWidth: pageSize.width,
        documentHeight: pageSize.height,
        viewportHeight: task.viewport.height,
        dpr: forcedDpr,
        log: options.log,
      });
      scrollSceneDebug = scrollSceneResult.debug;
      const imageReplacements = [
        ...topOverlayReplacements,
        ...scrollSceneResult.replacements,
        ...footerRevealReplacements,
      ];
      const optimizedFullPageBuffer =
        imageReplacements.length > 0
          ? await replaceImageRegions(rawFullPageBuffer, imageReplacements)
          : rawFullPageBuffer;
      await fs.writeFile(
        fullPath,
        await sharp(optimizedFullPageBuffer).jpeg({ quality: task.image.quality }).toBuffer(),
      );
      await stabilizeFullPageViewport(page, task.url, options.log);
      assets.push({
        kind: "fullPage",
        label: "full_page",
        filePath: fullPath,
        fileName: fullName,
        pageTitle,
        sourceUrl: task.url,
        quality: task.image.quality,
        dpr: forcedDpr,
        capturedAt: new Date().toISOString(),
      });
    }

    const sectionRequests = task.captures.filter((item) => item.mode === "section");
    if (sectionRequests.length > 0) {
      await stabilizeFullPageViewport(page, task.url, options.log);
      await waitForRenderStability(page, {
        log: options.log,
        phase: "pre_section",
        timeoutMs: 6_000,
      });
      await waitForRenderableMedia(page, options.log, "viewport");
      await sweepCaptureOverlays({
        page,
        log: options.log,
        phase: "pre_capture",
      });
      pageSize = await getPageDimensions(page);
      const detected = await detectSections(
        page,
        options.sectionScope,
        sectionRequests,
        options.classicMaxSections,
        pageSize,
      );
      sectionDebug = detected.debug;
      const labelCounts = new Map<string, number>();
      for (const section of detected.sections) {
        const clip = buildFixedSectionClip(section, pageSize);
        const baseLabel = section.sectionType === "unknown" ? "section" : section.sectionType;
        const count = (labelCounts.get(baseLabel) ?? 0) + 1;
        labelCounts.set(baseLabel, count);
        const label = count === 1 ? baseLabel : `${baseLabel}_${count}`;
        const sectionName = buildFileName(
          domain,
          timestamp,
          "section",
          label,
          task.image.quality,
          forcedDpr,
        );
        const sectionPath = path.join(options.outputDir, sectionName);
        await captureSectionClipImage({
          page,
          clip,
          pageHeight: pageSize.height,
          viewportHeight: task.viewport.height,
          dpr: forcedDpr,
          quality: task.image.quality,
          label,
          outputPath: sectionPath,
          log: options.log,
        });
        assets.push({
          kind: "section",
          sectionType: section.sectionType,
          label,
          filePath: sectionPath,
          fileName: sectionName,
          pageTitle,
          sourceUrl: task.url,
          quality: task.image.quality,
          dpr: forcedDpr,
          capturedAt: new Date().toISOString(),
        });
      }
    }

    return {
      assets,
      usedDpr: forcedDpr,
      fallbackToDpr1: false,
      viewport: task.viewport,
      fullPageSize: pageSize,
      sectionDebug,
      scrollSceneDebug,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function captureTask(
  task: ParsedTask,
  options: CaptureTaskOptions,
): Promise<CaptureRunResult> {
  const preferredDpr = task.image.dpr === "auto" ? 2 : task.image.dpr;

  const probeBrowser = await chromium.launch({ headless: true, args: CHROMIUM_CAPTURE_ARGS });
  const probeContext = await probeBrowser.newContext({
    viewport: task.viewport,
    deviceScaleFactor: preferredDpr,
    reducedMotion: "reduce",
  });
  const probePage = await probeContext.newPage();
  let resolvedDpr = preferredDpr;
  try {
    await gotoWithFallback({
      page: probePage,
      url: task.url,
      waitUntil: task.waitUntil,
      timeoutMs: 60_000,
      phase: "probe",
      fallbackWaitUntil: options.navigationFallback?.fallbackWaitUntil,
      onFallback: options.navigationFallback?.onFallback,
    });
    const dimensions = await getPageDimensions(probePage);
    if (task.image.dpr === "auto") {
      resolvedDpr = resolveDpr(task.image.dpr, dimensions.width, dimensions.height);
    }
  } finally {
    await probeContext.close();
    await probeBrowser.close();
  }

  try {
    return await captureOnce(task, options, resolvedDpr);
  } catch (error) {
    let finalError = error;

    if (isRecoverableNavigationError(error)) {
      const reason = error instanceof Error ? error.message : String(error);
      emitLog(options.log, "warn", `capture_retry_navigation url=${task.url} reason=${reason}`);
      options.onRecoverableNavigationRetry?.({
        url: task.url,
        reason,
      });

      try {
        return await captureOnce(task, options, resolvedDpr);
      } catch (retryError) {
        finalError = retryError;
      }
    }

    if (task.image.dpr !== "auto" || resolvedDpr === 1 || !isRetryableCaptureError(finalError)) {
      throw finalError;
    }

    const retried = await captureOnce(task, options, 1);
    return {
      ...retried,
      fallbackToDpr1: true,
    };
  }
}
