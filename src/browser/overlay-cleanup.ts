import type { Locator, Page } from "playwright";

type OverlayType = "consent" | "promo";
type OverlayCleanupPhase = "pre_capture" | "tile_capture" | "scroll_scene_sampling";
type OverlayVendor =
  | "osano"
  | "onetrust"
  | "cookiebot"
  | "usercentrics"
  | "didomi"
  | "trustarc"
  | "transcend"
  | "cookiescript"
  | "generic";

export interface OverlaySnapshot {
  overlayId: string;
  tagName: string;
  role: string | null;
  ariaLabel: string | null;
  id: string;
  className: string;
  text: string;
  position: string;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  acceptActionCount: number;
  rejectActionCount: number;
  closeActionCount: number;
  confirmActionCount: number;
  checkboxLikeControlCount: number;
  hostSignalCount: number;
}

export interface OverlayClassification {
  type: OverlayType;
  vendor: OverlayVendor;
}

interface OverlayCleanupOptions {
  log?: (level: "info" | "warn", message: string) => void;
  phase?: OverlayCleanupPhase;
  maxPasses?: number;
}

const OVERLAY_ATTR = "data-autosnap-overlay-id";
const ACTION_ATTR = "data-autosnap-overlay-action";
const MAX_CLEANUP_PASSES = 3;
const POST_ACTION_SETTLE_MS = 320;
const POST_PASS_SETTLE_MS = 180;

const KNOWN_VENDOR_MARKERS: Array<{ vendor: Exclude<OverlayVendor, "generic">; needles: string[] }> = [
  { vendor: "osano", needles: ["osano", "cookie consent banner"] },
  { vendor: "onetrust", needles: ["onetrust"] },
  { vendor: "cookiebot", needles: ["cookiebot"] },
  { vendor: "usercentrics", needles: ["usercentrics"] },
  { vendor: "didomi", needles: ["didomi"] },
  { vendor: "trustarc", needles: ["trustarc", "truste"] },
  { vendor: "transcend", needles: ["transcend"] },
  { vendor: "cookiescript", needles: ["cookiescript"] },
];

const CONSENT_HOST_KEYWORDS = [
  "transcend",
  "cookiescript",
  "consent-manager",
  "cookie-manager",
  "privacy-manager",
];

const CONSENT_KEYWORDS = [
  "cookie",
  "consent",
  "privacy",
  "gdpr",
  "tracking",
  "necessary cookies",
  "cookie policy",
  "cookie settings",
  "sale of personal information",
];

const PROMO_KEYWORDS = [
  "newsletter",
  "subscribe",
  "sign up",
  "special offer",
  "promo",
  "promotion",
  "chat with us",
  "live chat",
  "support",
  "intercom",
  "hubspot",
  "contact us later",
];

const REJECT_LABELS = [
  "reject all",
  "reject",
  "decline",
  "only necessary",
  "necessary only",
  "essential only",
  "deny",
];

const CLOSE_LABELS = [
  "close",
  "dismiss",
  "no thanks",
  "not now",
  "skip",
  "continue to site",
  "maybe later",
];

const ACCEPT_WORDS = ["accept", "agree", "allow all", "yes, i agree"];
const CONFIRM_LABELS = [
  "confirm",
  "save preferences",
  "save settings",
  "submit",
  "save and continue",
];

const OVERLAY_CANDIDATE_SELECTOR = [
  '[role="dialog"]',
  "dialog",
  '[aria-modal="true"]',
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[id*="privacy" i]',
  '[class*="privacy" i]',
  '[id*="newsletter" i]',
  '[class*="newsletter" i]',
  '[id*="subscribe" i]',
  '[class*="subscribe" i]',
  '[id*="popup" i]',
  '[class*="popup" i]',
  '[id*="modal" i]',
  '[class*="modal" i]',
  '[id*="intercom" i]',
  '[class*="intercom" i]',
  '[id*="hubspot" i]',
  '[class*="hubspot" i]',
  '[id*="chat" i]',
  '[class*="chat" i]',
  '[id*="support" i]',
  '[class*="support" i]',
  '[id*="osano" i]',
  '[class*="osano" i]',
  '[id*="onetrust" i]',
  '[class*="onetrust" i]',
  '[id*="cookiebot" i]',
  '[class*="cookiebot" i]',
  '[id*="didomi" i]',
  '[class*="didomi" i]',
  '[id*="usercentrics" i]',
  '[class*="usercentrics" i]',
  '[id*="trustarc" i]',
  '[class*="trustarc" i]',
  '[id*="transcend" i]',
  '[class*="transcend" i]',
  '[id*="consent-manager" i]',
  '[class*="consent-manager" i]',
  '[id*="cookie-manager" i]',
  '[class*="cookie-manager" i]',
  '[id*="privacy-manager" i]',
  '[class*="privacy-manager" i]',
].join(", ");

const ACTIONABLE_SELECTOR =
  'button, [role="button"], input[type="button"], input[type="submit"], a';

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function detectVendor(haystack: string): OverlayVendor {
  for (const marker of KNOWN_VENDOR_MARKERS) {
    if (includesAny(haystack, marker.needles)) {
      return marker.vendor;
    }
  }
  return "generic";
}

function isOverlayGeometry(snapshot: OverlaySnapshot): boolean {
  const positionAnchored =
    snapshot.position === "fixed" ||
    snapshot.position === "sticky" ||
    snapshot.role === "dialog";
  const hostConsentManager = positionAnchored && snapshot.hostSignalCount > 0;
  const largeEnough = snapshot.width >= 180 && snapshot.height >= 60;
  const visibleInViewport = snapshot.width <= snapshot.viewportWidth * 1.05;
  const inlineConsentCard =
    ((snapshot.acceptActionCount > 0 &&
      (snapshot.rejectActionCount > 0 || snapshot.closeActionCount > 0)) ||
      (snapshot.confirmActionCount > 0 && snapshot.checkboxLikeControlCount > 0)) &&
    snapshot.width >= 260 &&
    snapshot.height >= 120 &&
    snapshot.width <= snapshot.viewportWidth * 0.9 &&
    snapshot.height <= Math.max(Math.round(snapshot.viewportHeight * 0.75), 260);
  return hostConsentManager || (positionAnchored && largeEnough && visibleInViewport) || inlineConsentCard;
}

export function classifyOverlaySnapshot(snapshot: OverlaySnapshot): OverlayClassification | null {
  if (!isOverlayGeometry(snapshot)) {
    return null;
  }

  const haystack = normalizeText(
    [snapshot.role, snapshot.ariaLabel, snapshot.id, snapshot.className, snapshot.text].join(" "),
  );
  const vendor = detectVendor(haystack);

  if (
    vendor !== "generic" ||
    includesAny(haystack, CONSENT_KEYWORDS) ||
    snapshot.hostSignalCount > 0
  ) {
    return { type: "consent", vendor };
  }

  if (includesAny(haystack, PROMO_KEYWORDS)) {
    return { type: "promo", vendor };
  }

  return null;
}

async function collectOverlaySnapshots(page: Page): Promise<OverlaySnapshot[]> {
  // Keep the evaluate callback free of named local helpers.
  // tsx/esbuild injects __name() for them in dev, which breaks browser-side execution.
  return page.evaluate(
    ({
      attrName,
      selector,
      actionSelector,
      rejectLabels,
      closeLabels,
      acceptWords,
      confirmLabels,
      consentKeywords,
      consentHostKeywords,
      vendorNeedles,
    }) => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
      const seen = new Set<string>();
      const snapshots: OverlaySnapshot[] = [];
      const checkboxSelector =
        'input[type="checkbox"], [role="checkbox"], [role="switch"], [aria-checked="true"], [aria-checked="false"]';

      for (const node of nodes) {
        if (!node.isConnected) {
          continue;
        }

        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const hostHaystack = [
          node.id,
          node.className,
          node.getAttribute("aria-label"),
          node.getAttribute("role"),
        ]
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        const hostSignalCount = consentHostKeywords.filter((word) => hostHaystack.includes(word)).length;
        const hostCandidate =
          hostSignalCount > 0 &&
          (style.position === "fixed" ||
            style.position === "sticky" ||
            Number.parseFloat(style.zIndex || "0") >= 1000);
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0.02 &&
          rect.width > 0 &&
          rect.height > 0;
        if (!visible && !hostCandidate) {
          continue;
        }

        let overlayId = node.getAttribute(attrName);
        if (!overlayId) {
          overlayId = `overlay-${Math.random().toString(36).slice(2, 10)}`;
          node.setAttribute(attrName, overlayId);
        }
        if (seen.has(overlayId)) {
          continue;
        }
        seen.add(overlayId);

        let acceptActionCount = 0;
        let rejectActionCount = 0;
        let closeActionCount = 0;
        let confirmActionCount = 0;
        const actions = Array.from(node.querySelectorAll<HTMLElement>(actionSelector));
        for (const action of actions) {
          const text = [
            action.textContent,
            action.getAttribute("aria-label"),
            action.getAttribute("title"),
            action.getAttribute("value"),
          ]
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          if (!text) {
            continue;
          }
          if (acceptWords.some((word) => text.includes(word))) {
            acceptActionCount += 1;
          }
          if (rejectLabels.some((word) => text.includes(word))) {
            rejectActionCount += 1;
          }
          if (closeLabels.some((word) => text.includes(word))) {
            closeActionCount += 1;
          }
          if (confirmLabels.some((word) => text.includes(word))) {
            confirmActionCount += 1;
          }
        }
        const checkboxLikeControlCount = node.querySelectorAll(checkboxSelector).length;

        snapshots.push({
          overlayId,
          tagName: node.tagName,
          role: node.getAttribute("role"),
          ariaLabel: node.getAttribute("aria-label"),
          id: node.id,
          className: node.className,
          text: (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
          position: style.position,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          acceptActionCount,
          rejectActionCount,
          closeActionCount,
          confirmActionCount,
          checkboxLikeControlCount,
          hostSignalCount,
        });
      }

      const actionElements = Array.from(document.querySelectorAll<HTMLElement>(actionSelector));
      for (const actionElement of actionElements) {
        const actionText = [
          actionElement.textContent,
          actionElement.getAttribute("aria-label"),
          actionElement.getAttribute("title"),
          actionElement.getAttribute("value"),
        ]
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (
          !actionText ||
          ![...acceptWords, ...rejectLabels, ...closeLabels, ...confirmLabels].some((word) =>
            actionText.includes(word),
          )
        ) {
          continue;
        }

        let current = actionElement.parentElement;
        while (current && current !== document.body && current !== document.documentElement) {
          if (!current.isConnected) {
            break;
          }

          const style = window.getComputedStyle(current);
          const rect = current.getBoundingClientRect();
          const visible =
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number.parseFloat(style.opacity || "1") > 0.02 &&
            rect.width > 0 &&
            rect.height > 0;
          if (!visible) {
            current = current.parentElement;
            continue;
          }

          const text = [
            current.id,
            current.className,
            current.getAttribute("aria-label"),
            current.textContent,
          ]
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

          let acceptActionCount = 0;
          let rejectActionCount = 0;
          let closeActionCount = 0;
          let confirmActionCount = 0;
          const actions = Array.from(current.querySelectorAll<HTMLElement>(actionSelector));
          for (const action of actions) {
            const candidateText = [
              action.textContent,
              action.getAttribute("aria-label"),
              action.getAttribute("title"),
              action.getAttribute("value"),
            ]
              .join(" ")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
            if (!candidateText) {
              continue;
            }
            if (acceptWords.some((word) => candidateText.includes(word))) {
              acceptActionCount += 1;
            }
            if (rejectLabels.some((word) => candidateText.includes(word))) {
              rejectActionCount += 1;
            }
            if (closeLabels.some((word) => candidateText.includes(word))) {
              closeActionCount += 1;
            }
            if (confirmLabels.some((word) => candidateText.includes(word))) {
              confirmActionCount += 1;
            }
          }
          const checkboxLikeControlCount = current.querySelectorAll(checkboxSelector).length;
          const hostSignalCount = consentHostKeywords.filter((word) => text.includes(word)).length;

          const actionable =
            (acceptActionCount > 0 && (rejectActionCount > 0 || closeActionCount > 0)) ||
            (confirmActionCount > 0 && checkboxLikeControlCount > 0);
          const likelyConsent =
            consentKeywords.some((word) => text.includes(word)) ||
            vendorNeedles.some((word) => text.includes(word));
          const plausibleCard =
            rect.width >= 260 &&
            rect.height >= 120 &&
            rect.width <= window.innerWidth * 0.9 &&
            rect.height <= Math.max(window.innerHeight * 0.75, 260);

          if (actionable && likelyConsent && plausibleCard) {
            let overlayId = current.getAttribute(attrName);
            if (!overlayId) {
              overlayId = `overlay-${Math.random().toString(36).slice(2, 10)}`;
              current.setAttribute(attrName, overlayId);
            }
            if (!seen.has(overlayId)) {
              seen.add(overlayId);
              snapshots.push({
                overlayId,
                tagName: current.tagName,
                role: current.getAttribute("role"),
                ariaLabel: current.getAttribute("aria-label"),
                id: current.id,
                className: current.className,
                text: (current.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
                position: style.position,
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                acceptActionCount,
                rejectActionCount,
                closeActionCount,
                confirmActionCount,
                checkboxLikeControlCount,
                hostSignalCount,
              });
            }
            break;
          }

          current = current.parentElement;
        }
      }

      return snapshots.sort((left, right) => right.width * right.height - left.width * left.height);
    },
    {
      attrName: OVERLAY_ATTR,
      selector: OVERLAY_CANDIDATE_SELECTOR,
      actionSelector: ACTIONABLE_SELECTOR,
      rejectLabels: REJECT_LABELS,
      closeLabels: CLOSE_LABELS,
      acceptWords: ACCEPT_WORDS,
      confirmLabels: CONFIRM_LABELS,
      consentKeywords: CONSENT_KEYWORDS,
      consentHostKeywords: CONSENT_HOST_KEYWORDS,
      vendorNeedles: KNOWN_VENDOR_MARKERS.flatMap((marker) => marker.needles),
    },
  );
}

async function clickMatchingAction(
  container: Locator,
  phrases: string[],
  fallbackLabel: string,
): Promise<boolean> {
  const actionId = `${fallbackLabel}-${Math.random().toString(36).slice(2, 10)}`;
  const candidates = container.locator('button, [role="button"], input[type="button"], input[type="submit"], a');
  const matched = await candidates.evaluateAll(
    (elements, { actionAttr, actionId, phrases, excludedWords }) => {
      for (const element of elements) {
        const text = (
          [
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("value"),
          ].join(" ") ?? ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (!text) {
          continue;
        }
        if (excludedWords.some((word) => text.includes(word))) {
          continue;
        }
        if (!phrases.some((phrase) => text.includes(phrase))) {
          continue;
        }
        element.setAttribute(actionAttr, actionId);
        return true;
      }
      return false;
    },
    {
      actionAttr: ACTION_ATTR,
      actionId,
      phrases,
      excludedWords: ACCEPT_WORDS,
    },
  );

  if (!matched) {
    return false;
  }

  const target = container.page().locator(`[${ACTION_ATTR}="${actionId}"]`).first();
  try {
    await target.click({ timeout: 1_500 });
    return true;
  } catch {
    return false;
  } finally {
    await container
      .page()
      .evaluate(
        ({ actionAttr, actionId }) => {
          document.querySelector(`[${actionAttr}="${actionId}"]`)?.removeAttribute(actionAttr);
        },
        { actionAttr: ACTION_ATTR, actionId },
      )
      .catch(() => undefined);
  }
}

async function hideOverlayById(page: Page, overlayId: string): Promise<boolean> {
  return page.evaluate(
    ({ attrName, overlayId }) => {
      const overlay = document.querySelector<HTMLElement>(`[${attrName}="${overlayId}"]`);
      if (!overlay) {
        return false;
      }

      const removable = new Set<HTMLElement>();
      removable.add(overlay);

      const backdropKeywords = ["backdrop", "overlay", "scrim", "shade", "mask"];
      for (const node of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        if (node === overlay || !node.isConnected) {
          continue;
        }
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const text = `${node.id} ${node.className}`.toLowerCase();
        const looksLikeBackdrop =
          (style.position === "fixed" || style.position === "sticky") &&
          rect.width >= window.innerWidth * 0.7 &&
          rect.height >= window.innerHeight * 0.5 &&
          backdropKeywords.some((keyword) => text.includes(keyword));
        if (looksLikeBackdrop) {
          removable.add(node);
        }
      }

      for (const node of removable) {
        node.remove();
      }
      return true;
    },
    { attrName: OVERLAY_ATTR, overlayId },
  );
}

async function isLocatorVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function isLocatorInViewport(locator: Locator): Promise<boolean> {
  try {
    const box = await locator.boundingBox();
    const viewport = locator.page().viewportSize();
    if (!box || !viewport) {
      return false;
    }
    return box.x < viewport.width && box.x + box.width > 0 && box.y < viewport.height && box.y + box.height > 0;
  } catch {
    return false;
  }
}

async function handleOverlayCandidate(
  page: Page,
  snapshot: OverlaySnapshot,
  classification: OverlayClassification,
  phase: OverlayCleanupPhase,
  log?: OverlayCleanupOptions["log"],
): Promise<boolean> {
  log?.(
    "info",
    `overlay_detected phase=${phase} type=${classification.type} vendor=${classification.vendor} overlay_id=${snapshot.overlayId}`,
  );

  const container = page.locator(`[${OVERLAY_ATTR}="${snapshot.overlayId}"]`).first();
  if (!(await isLocatorVisible(container))) {
    const hidden = await hideOverlayById(page, snapshot.overlayId);
    if (hidden) {
      await page.waitForTimeout(POST_ACTION_SETTLE_MS);
      log?.(
        "info",
        `overlay_action phase=${phase} action=hide_dom_offscreen type=${classification.type} vendor=${classification.vendor} overlay_id=${snapshot.overlayId}`,
      );
    }
    return hidden;
  }
  if (!(await isLocatorInViewport(container))) {
    const hidden = await hideOverlayById(page, snapshot.overlayId);
    if (hidden) {
      await page.waitForTimeout(POST_ACTION_SETTLE_MS);
      log?.(
        "info",
        `overlay_action phase=${phase} action=hide_dom_offscreen type=${classification.type} vendor=${classification.vendor} overlay_id=${snapshot.overlayId}`,
      );
    }
    return hidden;
  }

  const clickPlans =
    classification.type === "consent"
      ? [
          { labels: REJECT_LABELS, action: "click_reject" },
          { labels: CLOSE_LABELS, action: "click_close" },
          { labels: CONFIRM_LABELS, action: "click_confirm" },
        ]
      : [{ labels: CLOSE_LABELS, action: "click_close" }];

  for (const plan of clickPlans) {
    const clicked = await clickMatchingAction(container, plan.labels, plan.action);
    if (!clicked) {
      continue;
    }
    await page.waitForTimeout(POST_ACTION_SETTLE_MS);
    log?.(
      "info",
      `overlay_action phase=${phase} action=${plan.action} type=${classification.type} vendor=${classification.vendor} overlay_id=${snapshot.overlayId}`,
    );
    if (!(await isLocatorVisible(container))) {
      return true;
    }
  }

  const hidden = await hideOverlayById(page, snapshot.overlayId);
  if (hidden) {
    await page.waitForTimeout(POST_ACTION_SETTLE_MS);
    log?.(
      "info",
      `overlay_action phase=${phase} action=hide_dom_fallback type=${classification.type} vendor=${classification.vendor} overlay_id=${snapshot.overlayId}`,
    );
  }
  return hidden;
}

export async function cleanupCaptureOverlays(
  page: Page,
  options: OverlayCleanupOptions = {},
): Promise<{ handled: number }> {
  const phase = options.phase ?? "pre_capture";
  const maxPasses = Math.max(1, options.maxPasses ?? MAX_CLEANUP_PASSES);
  let handled = 0;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const snapshots = await collectOverlaySnapshots(page);
    let handledThisPass = 0;

    for (const snapshot of snapshots) {
      const classification = classifyOverlaySnapshot(snapshot);
      if (!classification) {
        continue;
      }
      const didHandle = await handleOverlayCandidate(page, snapshot, classification, phase, options.log);
      if (didHandle) {
        handled += 1;
        handledThisPass += 1;
      }
    }

    if (handledThisPass === 0) {
      break;
    }
    await page.waitForTimeout(POST_PASS_SETTLE_MS);
  }

  options.log?.("info", `overlay_cleanup_summary phase=${phase} handled=${handled}`);
  return { handled };
}
