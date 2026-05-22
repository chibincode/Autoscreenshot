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
const IMAGE_READY_TIMEOUT_MS = 7_500;
const IMAGE_READY_POLL_MS = 250;
const IMAGE_READY_MIN_AREA_PX = 8_000;
const OVERLAY_SWEEP_SETTLE_MS = 120;
const CAPTURE_PHASE_ATTR = "data-autosnap-capture-phase";
const HIDDEN_IMAGE_FALLBACK_STYLE_ATTR = "data-autosnap-hidden-image-fallback";

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

  try {
    let sliceCount = 0;
    for (let top = 0; top < params.pageHeight; top += tileHeight) {
      await params.beforeSliceCapture?.();
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

async function warmupLazyLoad(page: import("playwright").Page): Promise<void> {
  const docHeight = await page.evaluate(() => document.documentElement.scrollHeight || 0);
  const steps = Math.max(4, Math.min(12, Math.ceil(docHeight / 1200)));
  for (let i = 1; i <= steps; i += 1) {
    const y = Math.round((docHeight * i) / steps);
    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
    await page.waitForTimeout(120);
  }
}

type ImageReadyScope = "document" | "viewport";

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
): Promise<void> {
  const startedAt = Date.now();
  let pendingCount = await getPendingRenderableImageCount(page, scope).catch(() => 0);

  while (pendingCount > 0 && Date.now() - startedAt < IMAGE_READY_TIMEOUT_MS) {
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
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: task.viewport,
    deviceScaleFactor: forcedDpr,
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
    await sweepCaptureOverlays({
      page,
      log: options.log,
      phase: "pre_capture",
    });
    if (hasFullPageCapture) {
      const earlyScrollScenes = await detectScrollSceneCandidates(page);
      if (earlyScrollScenes.length === 0) {
        await warmupLazyLoad(page);
        fullPageImageReadyScope = "document";
        await page.waitForTimeout(400);
      } else {
        emitLog(options.log, "info", `scroll_scene_preserve_layout count=${earlyScrollScenes.length}`);
      }
    } else {
      await warmupLazyLoad(page);
      await page.waitForTimeout(400);
    }
    await sweepCaptureOverlays({
      page,
      log: options.log,
      phase: "pre_capture",
    });

    const pageTitle = (await page.title()).trim() || undefined;
    let pageSize = await getPageDimensions(page);
    const domain = sanitizeLabel(extractDomain(task.url));
    const timestamp = timestampForFile();
    const assets: CaptureRunResult["assets"] = [];
    let sectionDebug: SectionDetectionDebug | undefined;
    let scrollSceneDebug: CaptureRunResult["scrollSceneDebug"];

    if (hasFullPageCapture) {
      await stabilizeFullPageViewport(page, task.url, options.log);
      await waitForRenderableImages(page, options.log, fullPageImageReadyScope);
      await installHiddenImageCaptureFallback(page, options.log);
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
      scrollSceneDebug = scrollSceneResult.debug;
      const optimizedFullPageBuffer =
        scrollSceneResult.replacements.length > 0
          ? await replaceImageRegions(rawFullPageBuffer, scrollSceneResult.replacements)
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
        await page.screenshot({
          path: sectionPath,
          type: "jpeg",
          quality: task.image.quality,
          fullPage: true,
          clip,
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

  const probeBrowser = await chromium.launch({ headless: true });
  const probeContext = await probeBrowser.newContext({
    viewport: task.viewport,
    deviceScaleFactor: preferredDpr,
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
