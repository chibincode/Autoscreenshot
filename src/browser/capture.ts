import path from "node:path";
import { chromium } from "playwright";
import { detectSections } from "./section-detector.js";
import type {
  CaptureRunResult,
  ParsedTask,
  SectionDetectionDebug,
  SectionResult,
  SectionScope,
} from "../types.js";
import { ensureDir, slugify, timestampForFile } from "../utils/manifest.js";

const JPG_EXTENSION = "jpg";
export const DPR_PIXEL_THRESHOLD = 120_000_000;
const SECTION_TARGET_ASPECT_RATIO = 16 / 9;

interface CaptureTaskOptions {
  outputDir: string;
  sectionScope: SectionScope;
  classicMaxSections: number;
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
  return /ENOMEM|heap|memory|crash|Target closed|Target crashed|timeout/i.test(text);
}

async function warmupLazyLoad(page: import("playwright").Page): Promise<void> {
  const docHeight = await page.evaluate(() => document.documentElement.scrollHeight || 0);
  const steps = Math.max(4, Math.min(12, Math.ceil(docHeight / 1200)));
  for (let i = 1; i <= steps; i += 1) {
    const y = Math.round((docHeight * i) / steps);
    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(120);
}

function clampClip(section: SectionResult, pageSize: { width: number; height: number }) {
  const padding = 12;
  const x = Math.max(0, Math.round(section.bbox.x - padding));
  const y = Math.max(0, Math.round(section.bbox.y - padding));
  const right = Math.min(pageSize.width, Math.round(section.bbox.x + section.bbox.width + padding));
  const bottom = Math.min(
    pageSize.height,
    Math.round(section.bbox.y + section.bbox.height + padding),
  );
  const width = Math.max(20, right - x);
  const height = Math.max(20, bottom - y);
  const centerX = x + width / 2;
  const centerY = y + height / 2;

  let targetWidth = width;
  let targetHeight = height;
  const currentRatio = width / Math.max(1, height);
  if (currentRatio > SECTION_TARGET_ASPECT_RATIO) {
    targetHeight = Math.round(targetWidth / SECTION_TARGET_ASPECT_RATIO);
  } else {
    targetWidth = Math.round(targetHeight * SECTION_TARGET_ASPECT_RATIO);
  }

  targetWidth = Math.min(pageSize.width, Math.max(20, targetWidth));
  targetHeight = Math.min(pageSize.height, Math.max(20, targetHeight));

  if (targetWidth / Math.max(1, targetHeight) > SECTION_TARGET_ASPECT_RATIO) {
    targetHeight = Math.min(pageSize.height, Math.max(20, Math.round(targetWidth / SECTION_TARGET_ASPECT_RATIO)));
  } else {
    targetWidth = Math.min(pageSize.width, Math.max(20, Math.round(targetHeight * SECTION_TARGET_ASPECT_RATIO)));
  }

  const maxX = Math.max(0, pageSize.width - targetWidth);
  const maxY = Math.max(0, pageSize.height - targetHeight);
  const targetX = Math.min(maxX, Math.max(0, Math.round(centerX - targetWidth / 2)));
  const targetY = Math.min(maxY, Math.max(0, Math.round(centerY - targetHeight / 2)));

  return {
    x: targetX,
    y: targetY,
    width: targetWidth,
    height: targetHeight,
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
    await page.goto(task.url, { waitUntil: task.waitUntil, timeout: 75_000 });
    await warmupLazyLoad(page);

    const pageSize = await getPageDimensions(page);
    const domain = sanitizeLabel(extractDomain(task.url));
    const timestamp = timestampForFile();
    const assets: CaptureRunResult["assets"] = [];
    let sectionDebug: SectionDetectionDebug | undefined;

    const hasFullPageCapture = task.captures.some((item) => item.mode === "fullPage");
    if (hasFullPageCapture) {
      const fullName = buildFileName(
        domain,
        timestamp,
        "fullpage",
        "full_page",
        task.image.quality,
        forcedDpr,
      );
      const fullPath = path.join(options.outputDir, fullName);
      await page.screenshot({
        path: fullPath,
        type: "jpeg",
        quality: task.image.quality,
        fullPage: true,
      });
      assets.push({
        kind: "fullPage",
        label: "full_page",
        filePath: fullPath,
        fileName: fullName,
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
      );
      sectionDebug = detected.debug;
      for (const section of detected.sections) {
        const clip = clampClip(section, pageSize);
        const label = section.sectionType === "unknown" ? "section" : section.sectionType;
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
    await probePage.goto(task.url, { waitUntil: task.waitUntil, timeout: 60_000 });
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
