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
  // Some design-tool sites render viewport rulers as fixed canvases instead of
  // semantic navigation. The geometry checks below keep ordinary in-flow and
  // full-screen WebGL canvases out of this cleanup path.
  "canvas",
].join(",");
const TOP_OVERLAY_MAX_TOP = 24;
const TOP_OVERLAY_MAX_HEIGHT = 240;
const TOP_OVERLAY_MIN_HEIGHT = 24;
const TOP_OVERLAY_MIN_WIDTH_RATIO = 0.35;
const TOP_OVERLAY_MIN_CAPTURE_HEIGHT = 64;
const TOP_OVERLAY_EXTRA_PADDING = 8;
const TOP_OVERLAY_HIDDEN_ATTR = "data-autosnap-top-overlay-hidden";
const STICKY_NORMALIZED_ATTR = "data-autosnap-sticky-normalized";
const BOTTOM_FIXED_ATTR = "data-autosnap-bottom-fixed";
const BOTTOM_FIXED_STATE_ATTR = "data-autosnap-bottom-fixed-state";
const BOTTOM_FIXED_MAX_GAP = 24;
const BOTTOM_FIXED_MIN_HEIGHT = 20;
const BOTTOM_FIXED_MAX_HEIGHT = 240;
const BOTTOM_FIXED_MIN_WIDTH_RATIO = 0.35;

export interface BottomFixedOverlayController {
  count: number;
  setVisible: (visible: boolean) => Promise<void>;
  restore: () => Promise<void>;
}

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
          rect.bottom >= minHeight;

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
          pinnedElement.querySelector("a, button, img, svg") !== null ||
          element.tagName.toLowerCase() === "canvas" ||
          pinnedElement.tagName.toLowerCase() === "canvas";
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

export async function hideTopOverlaysForCapture(params: {
  page: Page;
  pageWidth: number;
  viewportHeight: number;
  log?: (level: "info" | "warn", message: string) => void;
}): Promise<() => Promise<void>> {
  const hiddenCount = await params.page.evaluate(
    ({ attrName, maxHeight, maxTop, minHeight, minWidthRatio, pageWidth, selectors, viewportHeight }) => {
      const elements = Array.from(document.querySelectorAll<HTMLElement>(selectors));
      const hidden = new Set<HTMLElement>();

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

        if (!pinnedElement || hidden.has(pinnedElement)) {
          continue;
        }

        const rect = pinnedElement.getBoundingClientRect();
        const opacity = Number(pinnedStyle.opacity || "1");
        const hasMeaningfulContent =
          (element.textContent || pinnedElement.textContent || "").trim().length > 0 ||
          element.querySelector("a, button, img, svg") !== null ||
          pinnedElement.querySelector("a, button, img, svg") !== null ||
          element.tagName.toLowerCase() === "canvas" ||
          pinnedElement.tagName.toLowerCase() === "canvas";

        if (
          (pinnedStyle.position === "fixed" || pinnedStyle.position === "sticky") &&
          rect.top <= maxTop &&
          rect.bottom >= minHeight &&
          rect.top < viewportHeight &&
          rect.width >= pageWidth * minWidthRatio &&
          rect.height >= minHeight &&
          rect.height <= maxHeight &&
          pinnedStyle.display !== "none" &&
          pinnedStyle.visibility !== "hidden" &&
          opacity > 0.01 &&
          hasMeaningfulContent
        ) {
          pinnedElement.setAttribute(attrName, "true");
          hidden.add(pinnedElement);
        }
      }

      return hidden.size;
    },
    {
      attrName: TOP_OVERLAY_HIDDEN_ATTR,
      maxHeight: TOP_OVERLAY_MAX_HEIGHT,
      maxTop: TOP_OVERLAY_MAX_TOP,
      minHeight: TOP_OVERLAY_MIN_HEIGHT,
      minWidthRatio: TOP_OVERLAY_MIN_WIDTH_RATIO,
      pageWidth: params.pageWidth,
      selectors: TOP_OVERLAY_SELECTORS,
      viewportHeight: params.viewportHeight,
    },
  );

  if (hiddenCount === 0) {
    return async () => undefined;
  }

  // Descendants must be hidden explicitly too: an inherited `visibility: hidden`
  // is overridden by any child that sets `visibility: visible` itself, which is how
  // a pinned header's logo survives and gets baked into scrolled slices.
  const styleHandle = await params.page.addStyleTag({
    content: `[${TOP_OVERLAY_HIDDEN_ATTR}="true"], [${TOP_OVERLAY_HIDDEN_ATTR}="true"] * { visibility: hidden !important; }`,
  });
  params.log?.("info", `top_overlay_hidden_for_tiles count=${hiddenCount}`);

  return async () => {
    await styleHandle
      .evaluate((node) => (node instanceof Element ? node.remove() : undefined))
      .catch(() => undefined);
    await params.page
      .evaluate((attrName) => {
        document.querySelectorAll(`[${attrName}]`).forEach((element) => element.removeAttribute(attrName));
      }, TOP_OVERLAY_HIDDEN_ATTR)
      .catch(() => undefined);
  };
}

export async function normalizeStickyElementsForCapture(params: {
  page: Page;
  log?: (level: "info" | "warn", message: string) => void;
}): Promise<() => Promise<void>> {
  const normalizedCount = await params.page.evaluate((attrName) => {
    const stickyElements = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.position === "sticky" &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0.01 &&
        rect.width > 0 &&
        rect.height > 0
      );
    });

    stickyElements.forEach((element) => element.setAttribute(attrName, "true"));
    return stickyElements.length;
  }, STICKY_NORMALIZED_ATTR);

  if (normalizedCount === 0) {
    return async () => undefined;
  }

  const styleHandle = await params.page.addStyleTag({
    content: `
      [${STICKY_NORMALIZED_ATTR}="true"] {
        position: relative !important;
        inset: auto !important;
      }
    `,
  });
  params.log?.("info", `sticky_elements_normalized_for_fullpage count=${normalizedCount}`);

  return async () => {
    await styleHandle
      .evaluate((node) => (node instanceof Element ? node.remove() : undefined))
      .catch(() => undefined);
    await params.page
      .evaluate((attrName) => {
        document.querySelectorAll(`[${attrName}]`).forEach((element) => element.removeAttribute(attrName));
      }, STICKY_NORMALIZED_ATTR)
      .catch(() => undefined);
  };
}

export async function controlBottomFixedOverlaysForCapture(params: {
  page: Page;
  pageWidth: number;
  viewportHeight: number;
  log?: (level: "info" | "warn", message: string) => void;
}): Promise<BottomFixedOverlayController> {
  const controlledCount = await params.page.evaluate(
    ({ attrName, maxGap, maxHeight, minHeight, minWidthRatio, pageWidth, viewportHeight }) => {
      const controlled = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const opacity = Number(style.opacity || "1");
        const hasMeaningfulContent =
          (element.textContent || "").trim().length > 0 ||
          element.querySelector("a, button, input, select, img, svg") !== null;
        return (
          style.position === "fixed" &&
          rect.bottom >= viewportHeight - maxGap &&
          rect.top >= viewportHeight * 0.5 &&
          rect.width >= pageWidth * minWidthRatio &&
          rect.height >= minHeight &&
          rect.height <= maxHeight &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          opacity > 0.01 &&
          hasMeaningfulContent
        );
      });

      controlled.forEach((element) => element.setAttribute(attrName, "true"));
      return controlled.length;
    },
    {
      attrName: BOTTOM_FIXED_ATTR,
      maxGap: BOTTOM_FIXED_MAX_GAP,
      maxHeight: BOTTOM_FIXED_MAX_HEIGHT,
      minHeight: BOTTOM_FIXED_MIN_HEIGHT,
      minWidthRatio: BOTTOM_FIXED_MIN_WIDTH_RATIO,
      pageWidth: params.pageWidth,
      viewportHeight: params.viewportHeight,
    },
  );

  if (controlledCount === 0) {
    return {
      count: 0,
      setVisible: async () => undefined,
      restore: async () => undefined,
    };
  }

  await params.page.evaluate((stateAttr) => {
    document.documentElement?.setAttribute(stateAttr, "hidden");
  }, BOTTOM_FIXED_STATE_ATTR);
  const styleHandle = await params.page.addStyleTag({
    content: `
      html[${BOTTOM_FIXED_STATE_ATTR}="hidden"] [${BOTTOM_FIXED_ATTR}="true"],
      html[${BOTTOM_FIXED_STATE_ATTR}="hidden"] [${BOTTOM_FIXED_ATTR}="true"] * {
        visibility: hidden !important;
      }
    `,
  });
  params.log?.("info", `bottom_fixed_overlay_controlled count=${controlledCount}`);

  return {
    count: controlledCount,
    setVisible: async (visible: boolean) => {
      await params.page.evaluate(
        ({ stateAttr, visibleState }) => {
          if (visibleState) {
            document.documentElement?.removeAttribute(stateAttr);
          } else {
            document.documentElement?.setAttribute(stateAttr, "hidden");
          }
        },
        { stateAttr: BOTTOM_FIXED_STATE_ATTR, visibleState: visible },
      );
    },
    restore: async () => {
      await styleHandle
        .evaluate((node) => (node instanceof Element ? node.remove() : undefined))
        .catch(() => undefined);
      await params.page
        .evaluate(
          ({ attrName, stateAttr }) => {
            document.documentElement?.removeAttribute(stateAttr);
            document.querySelectorAll(`[${attrName}]`).forEach((element) => element.removeAttribute(attrName));
          },
          { attrName: BOTTOM_FIXED_ATTR, stateAttr: BOTTOM_FIXED_STATE_ATTR },
        )
        .catch(() => undefined);
    },
  };
}
