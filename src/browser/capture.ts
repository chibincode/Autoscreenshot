import path from "node:path";
import { promises as fs } from "node:fs";
import { chromium } from "playwright";
import sharp from "sharp";
import { detectSections } from "./section-detector.js";
import { buildFixedSectionClip } from "./section-clip.js";
import { gotoWithFallback, type NavigationFallbackEvent } from "./navigation.js";
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

interface CaptureTaskOptions {
  outputDir: string;
  sectionScope: SectionScope;
  classicMaxSections: number;
  log?: (level: "info" | "warn", message: string) => void;
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
    await page.waitForTimeout(hasFullPageCapture ? FULLPAGE_INITIAL_SETTLE_MS : 400);
    if (hasFullPageCapture) {
      const earlyScrollScenes = await detectScrollSceneCandidates(page);
      if (earlyScrollScenes.length === 0) {
        await warmupLazyLoad(page);
        await page.waitForTimeout(400);
      } else {
        emitLog(options.log, "info", `scroll_scene_preserve_layout count=${earlyScrollScenes.length}`);
      }
    } else {
      await warmupLazyLoad(page);
      await page.waitForTimeout(400);
    }

    const pageTitle = (await page.title()).trim() || undefined;

    const pageSize = await getPageDimensions(page);
    const domain = sanitizeLabel(extractDomain(task.url));
    const timestamp = timestampForFile();
    const assets: CaptureRunResult["assets"] = [];
    let sectionDebug: SectionDetectionDebug | undefined;
    let scrollSceneDebug: CaptureRunResult["scrollSceneDebug"];

    if (hasFullPageCapture) {
      await stabilizeFullPageViewport(page, task.url, options.log);
      const fullName = buildFileName(
        domain,
        timestamp,
        "fullpage",
        "full_page",
        task.image.quality,
        forcedDpr,
      );
      const fullPath = path.join(options.outputDir, fullName);
      const rawFullPageBuffer = await page.screenshot({
        type: "png",
        fullPage: true,
      });
      const scrollSceneResult = await captureScrollSceneReplacements({
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
    if (task.image.dpr !== "auto" || resolvedDpr === 1 || !isRetryableCaptureError(error)) {
      throw error;
    }

    const retried = await captureOnce(task, options, 1);
    return {
      ...retried,
      fallbackToDpr1: true,
    };
  }
}
