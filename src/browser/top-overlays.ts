import sharp from "sharp";
import type { Page } from "playwright";
import type { ImageRegionReplacement } from "./scroll-scenes.js";

const TOP_OVERLAY_SELECTORS = [
  "header",
  "nav",
  '[role="navigation"]',
  '[data-framer-name*="Navigation" i]',
  '[data-framer-name*="Nav" i]',
  '[data-framer-name*="Header" i]',
  '[class*="nav" i]',
  '[class*="header" i]',
].join(",");
const TOP_OVERLAY_MAX_TOP = 24;
const TOP_OVERLAY_MAX_HEIGHT = 240;
const TOP_OVERLAY_MIN_HEIGHT = 24;
const TOP_OVERLAY_MIN_WIDTH_RATIO = 0.35;
const TOP_OVERLAY_MIN_CAPTURE_HEIGHT = 64;
const TOP_OVERLAY_EXTRA_PADDING = 8;

interface TopOverlayCandidate {
  selectorLabel: string;
  bottom: number;
  height: number;
  width: number;
  area: number;
  priority: number;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function findTopOverlayCandidate(params: {
  page: Page;
  pageWidth: number;
  viewportHeight: number;
}): Promise<TopOverlayCandidate | null> {
  return params.page.evaluate(
    ({ maxHeight, maxTop, minHeight, minWidthRatio, pageWidth, selectors, viewportHeight }) => {
      const elements = Array.from(document.querySelectorAll<HTMLElement>(selectors));
      const seenPinned = new Set<HTMLElement>();
      const scored: TopOverlayCandidate[] = [];

      for (const element of elements) {
        let pinnedElement: HTMLElement | null = element;
        let pinnedStyle = window.getComputedStyle(pinnedElement);
        while (
          pinnedElement &&
          pinnedElement !== document.body &&
          pinnedElement !== document.documentElement &&
          pinnedStyle.position !== "fixed" &&
          pinnedStyle.position !== "sticky"
        ) {
          pinnedElement = pinnedElement.parentElement;
          pinnedStyle = pinnedElement ? window.getComputedStyle(pinnedElement) : pinnedStyle;
        }

        if (!pinnedElement || seenPinned.has(pinnedElement)) {
          continue;
        }
        seenPinned.add(pinnedElement);

        const rect = pinnedElement.getBoundingClientRect();
        const style = pinnedStyle;
        const opacity = Number(style.opacity || "1");
        const isTopPinned =
          (style.position === "fixed" || style.position === "sticky") &&
          rect.top <= maxTop &&
          rect.bottom > minHeight;

        if (
          !isTopPinned ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          opacity <= 0.01 ||
          rect.width < pageWidth * minWidthRatio ||
          rect.height < minHeight ||
          rect.height > maxHeight ||
          rect.top >= viewportHeight
        ) {
          continue;
        }

        const hasMeaningfulContent =
          (element.textContent || pinnedElement.textContent || "").trim().length > 0 ||
          element.querySelector("a, button, img, svg") !== null ||
          pinnedElement.querySelector("a, button, img, svg") !== null;
        if (!hasMeaningfulContent) {
          continue;
        }

        const tagName = element.tagName.toLowerCase();
        scored.push({
          selectorLabel: tagName,
          bottom: Math.max(0, rect.bottom),
          height: rect.height,
          width: rect.width,
          area: rect.width * rect.height,
          priority: tagName === "header" || tagName === "nav" || element.getAttribute("role") === "navigation" ? 1 : 0,
        });
      }

      scored.sort((left, right) => {
        if (left.priority !== right.priority) {
          return right.priority - left.priority;
        }
        if (Math.abs(left.bottom - right.bottom) > 2) {
          return right.bottom - left.bottom;
        }
        return right.area - left.area;
      });

      return scored[0] ?? null;
    },
    {
      maxHeight: TOP_OVERLAY_MAX_HEIGHT,
      maxTop: TOP_OVERLAY_MAX_TOP,
      minHeight: TOP_OVERLAY_MIN_HEIGHT,
      minWidthRatio: TOP_OVERLAY_MIN_WIDTH_RATIO,
      pageWidth: params.pageWidth,
      selectors: TOP_OVERLAY_SELECTORS,
      viewportHeight: params.viewportHeight,
    },
  );
}

export async function captureTopOverlayReplacement(params: {
  page: Page;
  pageWidth: number;
  viewportHeight: number;
  dpr: number;
  log?: (level: "info" | "warn", message: string) => void;
}): Promise<ImageRegionReplacement[]> {
  await params.page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
  await params.page.waitForTimeout(120);

  const candidate = await findTopOverlayCandidate({
    page: params.page,
    pageWidth: params.pageWidth,
    viewportHeight: params.viewportHeight,
  });
  if (!candidate) {
    return [];
  }

  const height = clampNumber(
    Math.ceil(candidate.bottom + TOP_OVERLAY_EXTRA_PADDING),
    TOP_OVERLAY_MIN_CAPTURE_HEIGHT,
    Math.min(params.viewportHeight, TOP_OVERLAY_MAX_HEIGHT),
  );
  const replacement = await params.page.screenshot({
    type: "png",
    clip: {
      x: 0,
      y: 0,
      width: Math.max(1, Math.round(params.pageWidth)),
      height,
    },
  });
  const metadata = await sharp(replacement).metadata();
  if (!metadata.height) {
    return [];
  }

  params.log?.(
    "info",
    `top_overlay_replaced selector=${candidate.selectorLabel} height=${height} dpr=${params.dpr}`,
  );

  return [
    {
      top: 0,
      height: metadata.height,
      replacement,
    },
  ];
}
