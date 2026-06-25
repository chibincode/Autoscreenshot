import sharp from "sharp";
import type { Page } from "playwright";
import type { ImageRegionReplacement } from "./scroll-scenes.js";

const FOOTER_REVEAL_SELECTORS = [
  "footer",
  '[role="contentinfo"]',
  '[data-framer-name*="Footer" i]',
  '[class*="footer" i]',
].join(",");
const MIN_FOOTER_HEIGHT = 160;
const MIN_FOOTER_WIDTH_RATIO = 0.5;
const FOOTER_BOTTOM_TOLERANCE = 32;
const FOOTER_SETTLE_MS = 260;
const FOOTER_SETTLE_MAX_PASSES = 10;
const FOOTER_STABLE_TOLERANCE = 3;

interface FooterRevealCandidate {
  selectorLabel: string;
  absoluteTop: number;
  height: number;
  bottomGap: number;
  hasTransformedContext: boolean;
  transformKey: string;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isStableFooterCandidate(
  previous: FooterRevealCandidate | null,
  next: FooterRevealCandidate,
): boolean {
  if (!previous) {
    return false;
  }

  return (
    Math.abs(previous.absoluteTop - next.absoluteTop) <= FOOTER_STABLE_TOLERANCE &&
    Math.abs(previous.height - next.height) <= FOOTER_STABLE_TOLERANCE &&
    Math.abs(previous.bottomGap - next.bottomGap) <= FOOTER_STABLE_TOLERANCE &&
    previous.transformKey === next.transformKey
  );
}

async function findFooterRevealCandidate(params: {
  page: Page;
  documentHeight: number;
  pageWidth: number;
  viewportHeight: number;
}): Promise<FooterRevealCandidate | null> {
  return params.page.evaluate(
    ({ bottomTolerance, documentHeight, minFooterHeight, minFooterWidthRatio, pageWidth, selectors, viewportHeight }) => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(selectors));
      const seen = new Set<HTMLElement>();
      const scored: Array<FooterRevealCandidate & { area: number; tagPriority: number }> = [];

      for (const candidate of candidates) {
        if (seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);

        const rect = candidate.getBoundingClientRect();
        const style = window.getComputedStyle(candidate);
        const opacity = Number(style.opacity || "1");
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          opacity <= 0.01 ||
          rect.width < pageWidth * minFooterWidthRatio ||
          rect.height < minFooterHeight ||
          rect.bottom <= 0 ||
          rect.top >= viewportHeight
        ) {
          continue;
        }

        let current: HTMLElement | null = candidate;
        let hasTransformedContext = false;
        const transforms: string[] = [];
        while (current && current !== document.body && current !== document.documentElement) {
          const currentStyle = window.getComputedStyle(current);
          if (currentStyle.transform && currentStyle.transform !== "none") {
            hasTransformedContext = true;
            transforms.push(currentStyle.transform);
          }
          current = current.parentElement;
        }

        const absoluteTop = rect.top + window.scrollY;
        const absoluteBottom = absoluteTop + rect.height;
        const clippedTop = Math.max(0, absoluteTop);
        const clippedBottom = Math.min(documentHeight, absoluteBottom);
        const clippedHeight = clippedBottom - clippedTop;
        const bottomGap = documentHeight - clippedBottom;
        if (clippedHeight < minFooterHeight || bottomGap > bottomTolerance) {
          continue;
        }

        scored.push({
          selectorLabel: candidate.tagName.toLowerCase(),
          absoluteTop: clippedTop,
          height: clippedHeight,
          bottomGap,
          hasTransformedContext,
          transformKey: transforms.join("|"),
          area: rect.width * rect.height,
          tagPriority: candidate.tagName.toLowerCase() === "footer" ? 1 : 0,
        });
      }

      scored.sort((left, right) => {
        if (left.tagPriority !== right.tagPriority) {
          return right.tagPriority - left.tagPriority;
        }
        if (left.bottomGap !== right.bottomGap) {
          return left.bottomGap - right.bottomGap;
        }
        return right.area - left.area;
      });

      const best = scored[0];
      if (!best) {
        return null;
      }

      return {
        selectorLabel: best.selectorLabel,
        absoluteTop: best.absoluteTop,
        height: best.height,
        bottomGap: best.bottomGap,
        hasTransformedContext: best.hasTransformedContext,
        transformKey: best.transformKey,
      };
    },
    {
      bottomTolerance: FOOTER_BOTTOM_TOLERANCE,
      documentHeight: params.documentHeight,
      minFooterHeight: MIN_FOOTER_HEIGHT,
      minFooterWidthRatio: MIN_FOOTER_WIDTH_RATIO,
      pageWidth: params.pageWidth,
      selectors: FOOTER_REVEAL_SELECTORS,
      viewportHeight: params.viewportHeight,
    },
  );
}

async function primeFooterRevealScroll(params: {
  page: Page;
  maxScroll: number;
  viewportHeight: number;
}): Promise<void> {
  const start = Math.max(0, params.maxScroll - params.viewportHeight);
  const positions = [
    start,
    Math.round(start + (params.maxScroll - start) * 0.45),
    Math.round(start + (params.maxScroll - start) * 0.75),
    params.maxScroll,
  ];

  for (const position of positions) {
    await params.page.evaluate((scrollY) => window.scrollTo(0, scrollY), position);
    await params.page.waitForTimeout(140);
  }
}

async function settleFooterRevealCandidate(params: {
  page: Page;
  documentHeight: number;
  pageWidth: number;
  viewportHeight: number;
}): Promise<FooterRevealCandidate | null> {
  const maxScroll = Math.max(0, Math.round(params.documentHeight - params.viewportHeight));
  if (maxScroll <= 0) {
    return null;
  }

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
    await primeFooterRevealScroll({
      page: params.page,
      maxScroll,
      viewportHeight: params.viewportHeight,
    });

    let previous: FooterRevealCandidate | null = null;
    let latest: FooterRevealCandidate | null = null;
    let stableHits = 0;

    for (let pass = 0; pass < FOOTER_SETTLE_MAX_PASSES; pass += 1) {
      await params.page.evaluate((scrollY) => window.scrollTo(0, scrollY), maxScroll);
      await params.page.waitForTimeout(FOOTER_SETTLE_MS);

      const candidate = await findFooterRevealCandidate(params);
      if (!candidate) {
        previous = null;
        stableHits = 0;
        continue;
      }

      latest = candidate;
      if (isStableFooterCandidate(previous, candidate)) {
        stableHits += 1;
      } else {
        stableHits = 0;
      }

      if (stableHits >= 1) {
        return candidate;
      }

      previous = candidate;
    }

    return latest;
  } finally {
    if (styleHandle) {
      await styleHandle
        .evaluate((node) => (node instanceof Element ? node.remove() : undefined))
        .catch(() => undefined);
    }
  }
}

export async function captureFooterRevealReplacements(params: {
  page: Page;
  pageWidth: number;
  documentHeight: number;
  viewportHeight: number;
  dpr: number;
  log?: (level: "info" | "warn", message: string) => void;
}): Promise<ImageRegionReplacement[]> {
  const candidate = await settleFooterRevealCandidate({
    page: params.page,
    documentHeight: params.documentHeight,
    pageWidth: params.pageWidth,
    viewportHeight: params.viewportHeight,
  });

  if (!candidate) {
    return [];
  }

  const top = clampNumber(Math.round(candidate.absoluteTop), 0, Math.max(0, Math.round(params.documentHeight - 1)));
  const height = clampNumber(
    Math.round(candidate.height),
    1,
    Math.max(1, Math.round(params.documentHeight - top)),
  );
  const currentScrollY = await params.page
    .evaluate(() => Math.round(window.scrollY || document.documentElement.scrollTop || 0))
    .catch(() => Math.max(0, Math.round(params.documentHeight - params.viewportHeight)));
  const viewportTop = top - currentScrollY;
  if (viewportTop < 0 || viewportTop + height > params.viewportHeight) {
    return [];
  }

  const viewportScreenshot = await params.page.screenshot({
    type: "png",
    fullPage: false,
  });
  const replacement = await sharp(viewportScreenshot)
    .extract({
      left: 0,
      top: Math.round(viewportTop * params.dpr),
      width: Math.max(1, Math.round(params.pageWidth * params.dpr)),
      height: Math.max(1, Math.round(height * params.dpr)),
    })
    .png()
    .toBuffer();
  const metadata = await sharp(replacement).metadata();
  if (!metadata.height) {
    return [];
  }

  params.log?.(
    "info",
    `footer_reveal_replaced selector=${candidate.selectorLabel} top=${top} height=${height} bottomGap=${Math.round(candidate.bottomGap)} dpr=${params.dpr}`,
  );

  return [
    {
      top: Math.round(top * params.dpr),
      height: metadata.height,
      replacement,
    },
  ];
}
