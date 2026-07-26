import sharp from "sharp";
import type { Page } from "playwright";

const DEFAULT_RENDER_READY_TIMEOUT_MS = 10_000;
const DEFAULT_RENDER_READY_POLL_MS = 300;
const DEFAULT_STABLE_PASS_COUNT = 2;
const VISUAL_SIGNATURE_SIZE = 48;
const VISUAL_DIFF_THRESHOLD = 0.006;
const LAYOUT_DELTA_TOLERANCE = 24;
const TEXT_DELTA_TOLERANCE = 24;
const ELEMENT_DELTA_TOLERANCE = 3;
const VISUAL_STABILITY_SOFT_LIMIT_MS = 1_200;
const MEANINGFUL_VIEWPORT_TEXT_LENGTH = 48;
const MEANINGFUL_VIEWPORT_ELEMENT_COUNT = 4;

interface RenderReadinessSnapshot {
  readyState: DocumentReadyState;
  scrollHeight: number;
  bodyHeight: number;
  viewportTextLength: number;
  visibleElementCount: number;
  loadingIndicatorCount: number;
}

interface RenderReadinessOptions {
  log?: (level: "info" | "warn", message: string) => void;
  phase: string;
  timeoutMs?: number;
  pollMs?: number;
  stablePassCount?: number;
  visualStability?: boolean;
}

function emitLog(
  log: RenderReadinessOptions["log"],
  level: "info" | "warn",
  message: string,
): void {
  if (log) {
    log(level, message);
  }
}

async function getRenderReadinessSnapshot(page: Page): Promise<RenderReadinessSnapshot> {
  return page.evaluate(() => {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const body = document.body;
    const html = document.documentElement;
    const loadingPattern = /(^|[-_\s])(loading|loader|spinner|skeleton|placeholder|shimmer)([-_\s]|$)/i;
    const loadingTextPattern = /\b(loading|please wait)\b|加载|正在加载/i;
    let viewportTextLength = 0;
    let visibleElementCount = 0;
    let loadingIndicatorCount = 0;

    // Keep this body free of named inner functions: the transpiler wraps them in a
    // `__name()` helper that only exists in the Node module scope, so the serialized
    // callback throws as soon as it runs inside the page.
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      if (rect.bottom < 0 || rect.right < 0 || rect.top > viewportHeight || rect.left > viewportWidth) {
        continue;
      }
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0.01) {
        continue;
      }
      const visibleArea = rect.width * rect.height;

      visibleElementCount += 1;
      const directText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      viewportTextLength += directText.length;

      const role = element.getAttribute("role") ?? "";
      const ariaBusy = element.getAttribute("aria-busy") ?? "";
      const ariaLabel = element.getAttribute("aria-label") ?? "";
      const classAndId = `${element.id} ${element.className} ${element.getAttribute("data-testid") ?? ""}`;
      const text = `${directText} ${ariaLabel}`;
      const isLoadingElement =
        ariaBusy.toLowerCase() === "true" ||
        role === "progressbar" ||
        loadingPattern.test(classAndId) ||
        loadingTextPattern.test(text);

      if (isLoadingElement && visibleArea >= 160) {
        loadingIndicatorCount += 1;
      }
    }

    return {
      readyState: document.readyState,
      scrollHeight: Math.round(Math.max(body?.scrollHeight ?? 0, html?.scrollHeight ?? 0)),
      bodyHeight: Math.round(body?.getBoundingClientRect().height ?? 0),
      viewportTextLength,
      visibleElementCount,
      loadingIndicatorCount,
    };
  });
}

async function getViewportVisualSignature(page: Page): Promise<Buffer | null> {
  try {
    const screenshot = await page.screenshot({
      type: "png",
      fullPage: false,
    });
    return await sharp(screenshot)
      .resize(VISUAL_SIGNATURE_SIZE, VISUAL_SIGNATURE_SIZE, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer();
  } catch {
    return null;
  }
}

function visualDiff(left: Buffer | null, right: Buffer | null): number {
  if (!left || !right || left.length !== right.length) {
    return 1;
  }

  let diffTotal = 0;
  for (let index = 0; index < left.length; index += 1) {
    diffTotal += Math.abs(left[index] - right[index]);
  }
  return diffTotal / (left.length * 255);
}

function isSnapshotStable(
  previous: RenderReadinessSnapshot | null,
  current: RenderReadinessSnapshot,
): boolean {
  if (!previous) {
    return false;
  }

  return (
    Math.abs(current.scrollHeight - previous.scrollHeight) <= LAYOUT_DELTA_TOLERANCE &&
    Math.abs(current.bodyHeight - previous.bodyHeight) <= LAYOUT_DELTA_TOLERANCE &&
    Math.abs(current.viewportTextLength - previous.viewportTextLength) <= TEXT_DELTA_TOLERANCE &&
    Math.abs(current.visibleElementCount - previous.visibleElementCount) <= ELEMENT_DELTA_TOLERANCE
  );
}

export async function waitForRenderStability(
  page: Page,
  options: RenderReadinessOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_RENDER_READY_POLL_MS;
  const stablePassCount = options.stablePassCount ?? DEFAULT_STABLE_PASS_COUNT;
  const visualStability = options.visualStability ?? true;
  const startedAt = Date.now();
  let stablePasses = 0;
  let previousSnapshot: RenderReadinessSnapshot | null = null;
  let previousSignature: Buffer | null = null;
  let lastSnapshot: RenderReadinessSnapshot | null = null;
  let lastVisualDiff = 1;
  let bypassedVisualStability = false;
  let snapshotFailureLogged = false;

  await page
    .evaluate(() => document.fonts?.ready ?? Promise.resolve())
    .catch(() => undefined);

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await getRenderReadinessSnapshot(page).catch((error: unknown) => {
      if (!snapshotFailureLogged) {
        snapshotFailureLogged = true;
        emitLog(
          options.log,
          "warn",
          `render_snapshot_failed phase=${options.phase} reason=${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    });
    const signature = visualStability ? await getViewportVisualSignature(page) : null;
    if (!snapshot) {
      await page.waitForTimeout(pollMs);
      continue;
    }

    lastSnapshot = snapshot;
    const domStable = isSnapshotStable(previousSnapshot, snapshot);
    lastVisualDiff = visualStability ? visualDiff(previousSignature, signature) : 0;
    const hasMeaningfulViewportContent =
      snapshot.viewportTextLength >= MEANINGFUL_VIEWPORT_TEXT_LENGTH ||
      snapshot.visibleElementCount >= MEANINGFUL_VIEWPORT_ELEMENT_COUNT;
    const canBypassVisualStability =
      visualStability &&
      snapshot.loadingIndicatorCount === 0 &&
      hasMeaningfulViewportContent &&
      Date.now() - startedAt >= VISUAL_STABILITY_SOFT_LIMIT_MS;
    const viewportStable =
      !visualStability ||
      lastVisualDiff <= VISUAL_DIFF_THRESHOLD ||
      canBypassVisualStability;
    const ready =
      snapshot.readyState !== "loading" &&
      snapshot.loadingIndicatorCount === 0 &&
      domStable &&
      viewportStable;

    if (ready) {
      stablePasses += 1;
      bypassedVisualStability = bypassedVisualStability || (visualStability && lastVisualDiff > VISUAL_DIFF_THRESHOLD);
    } else {
      stablePasses = 0;
    }

    if (stablePasses >= stablePassCount) {
      emitLog(
        options.log,
        "info",
        `render_stable phase=${options.phase} elapsedMs=${Date.now() - startedAt} text=${snapshot.viewportTextLength} loadingIndicators=${snapshot.loadingIndicatorCount} visualDiff=${lastVisualDiff.toFixed(4)} visualBypass=${bypassedVisualStability ? "yes" : "no"}`,
      );
      return;
    }

    previousSnapshot = snapshot;
    previousSignature = signature;
    await page.waitForTimeout(pollMs);
  }

  emitLog(
    options.log,
    "warn",
    `render_stable_timeout phase=${options.phase} elapsedMs=${Date.now() - startedAt} readyState=${lastSnapshot?.readyState ?? "unknown"} loadingIndicators=${lastSnapshot?.loadingIndicatorCount ?? -1} visualDiff=${lastVisualDiff.toFixed(4)}`,
  );
}
