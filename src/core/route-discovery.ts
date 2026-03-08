import { chromium } from "playwright";
import { DEFAULT_DESKTOP_VIEWPORT } from "./defaults.js";
import { gotoWithFallback, type NavigationFallbackEvent } from "../browser/navigation.js";
import type {
  RouteDiscoveryResult,
  RouteDiscoveryTarget,
  RouteTargetSource,
  WaitUntilState,
} from "../types.js";

interface DiscoverCoreRoutesOptions {
  entryUrl: string;
  maxRoutes: number;
  waitUntil: WaitUntilState;
  onNavigationFallback?: (event: NavigationFallbackEvent) => void;
}

interface RawLink {
  href: string;
  title: string;
  source: RouteTargetSource;
  depth: number;
}

interface NormalizedRouteCandidate {
  url: string;
  path: string;
  hostname: string;
}

const RESOURCE_EXT_RE = /\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|webm|mov|mp3|wav|json|xml|txt|ico)$/i;
const EXCLUDED_PREFIXES = ["/search", "/tag", "/tags", "/author", "/category"];
const EXCLUDED_EXACT = new Set(["/privacy", "/privacy-policy", "/terms", "/terms-of-service", "/cookie", "/cookies"]);
const PAGE_PAGINATION_RE = /^\/page\/\d+\/?$/i;

const PATH_PRIORITY_GROUPS: Array<{ paths: string[]; score: number }> = [
  { paths: ["/"], score: 10_000 },
  { paths: ["/product", "/products", "/features", "/feature", "/solutions", "/use-cases"], score: 9_000 },
  { paths: ["/pricing", "/plans"], score: 8_400 },
  { paths: ["/customers", "/customer-stories", "/case-studies", "/testimonials"], score: 7_800 },
  { paths: ["/integrations", "/integration"], score: 7_400 },
  { paths: ["/docs", "/documentation", "/api"], score: 7_000 },
  { paths: ["/about", "/company", "/team"], score: 6_600 },
  { paths: ["/careers", "/jobs"], score: 6_300 },
  { paths: ["/blog", "/news", "/changelog"], score: 6_000 },
  { paths: ["/contact", "/contact-sales", "/demo", "/book-demo"], score: 5_700 },
  { paths: ["/login", "/signin"], score: 5_400 },
  { paths: ["/signup", "/register"], score: 5_100 },
];

const BLOG_GROUP_SCORE = PATH_PRIORITY_GROUPS.find((group) => group.paths.includes("/blog"))?.score ?? 6_000;

function normalizePath(inputPath: string): string {
  const withoutDuplicateSlash = inputPath.replace(/\/+/g, "/");
  const withLeadingSlash = withoutDuplicateSlash.startsWith("/")
    ? withoutDuplicateSlash
    : `/${withoutDuplicateSlash}`;
  if (withLeadingSlash === "/") {
    return "/";
  }
  return withLeadingSlash.replace(/\/+$/, "") || "/";
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^www\./i, "").trim().toLowerCase();
}

function isDirectBrandSubdomain(hostname: string, entry: URL): boolean {
  const normalizedHost = normalizeHostname(hostname);
  const rootHost = normalizeHostname(entry.hostname);
  const hostLabels = normalizedHost.split(".");
  const rootLabels = rootHost.split(".");
  return normalizedHost.endsWith(`.${rootHost}`) && hostLabels.length === rootLabels.length + 1;
}

function isAllowedBrandHost(hostname: string, entry: URL): boolean {
  const normalizedHost = normalizeHostname(hostname);
  const normalizedEntryHost = normalizeHostname(entry.hostname);
  return normalizedHost === normalizedEntryHost || isDirectBrandSubdomain(normalizedHost, entry);
}

function isBrandBlogHost(hostname: string, entry: URL): boolean {
  return normalizeHostname(hostname) === `blog.${normalizeHostname(entry.hostname)}`;
}

function pathMatches(pathname: string, template: string): boolean {
  if (pathname === template) {
    return true;
  }
  if (template === "/") {
    return pathname === "/";
  }
  return pathname.startsWith(`${template}/`);
}

export function scoreCoreRoute(pathname: string, source: RouteTargetSource, depth: number): number {
  const normalizedPath = normalizePath(pathname);
  let score = normalizedPath === "/" ? 10_000 : 1_000;

  for (const group of PATH_PRIORITY_GROUPS) {
    if (group.paths.some((candidate) => pathMatches(normalizedPath, candidate))) {
      score = Math.max(score, group.score);
      break;
    }
  }

  if (source === "nav") {
    score += 120;
  }

  score -= Math.min(depth, 5) * 10;
  score -= Math.min(normalizedPath.length, 120);

  return score;
}

function hasResourceExtension(pathname: string): boolean {
  return RESOURCE_EXT_RE.test(pathname);
}

export function shouldExcludeRoute(pathname: string): boolean {
  const normalizedPath = normalizePath(pathname).toLowerCase();
  if (normalizedPath === "/") {
    return false;
  }
  if (EXCLUDED_EXACT.has(normalizedPath)) {
    return true;
  }
  if (PAGE_PAGINATION_RE.test(normalizedPath)) {
    return true;
  }
  if (hasResourceExtension(normalizedPath)) {
    return true;
  }
  if (EXCLUDED_PREFIXES.some((prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`))) {
    return true;
  }
  return false;
}

function normalizeSameDomainUrl(rawHref: string, entry: URL): NormalizedRouteCandidate | null {
  let parsed: URL;
  try {
    parsed = new URL(rawHref, entry);
  } catch {
    return null;
  }

  if (!isAllowedBrandHost(parsed.hostname, entry)) {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return null;
  }

  const path = normalizePath(parsed.pathname || "/");
  if (shouldExcludeRoute(path)) {
    return null;
  }

  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = path;

  return {
    url: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
    path,
    hostname: normalizeHostname(parsed.hostname),
  };
}

function scoreDiscoveredRoute(
  routeUrl: string,
  pathname: string,
  source: RouteTargetSource,
  depth: number,
  entry: URL,
): number {
  const normalizedPath = normalizePath(pathname);
  const parsedUrl = new URL(routeUrl);
  const normalizedHost = normalizeHostname(parsedUrl.hostname);
  const normalizedEntryHost = normalizeHostname(entry.hostname);

  if (normalizedHost !== normalizedEntryHost) {
    let score = 1_000;
    if (isBrandBlogHost(normalizedHost, entry)) {
      score = BLOG_GROUP_SCORE;
    }
    if (source === "nav") {
      score += 120;
    }
    score -= Math.min(depth, 5) * 10;
    score -= Math.min(normalizedPath.length, 120);
    return score;
  }

  return scoreCoreRoute(normalizedPath, source, depth);
}

async function collectRawLinks(
  entryUrl: string,
  waitUntil: WaitUntilState,
  onNavigationFallback?: (event: NavigationFallbackEvent) => void,
): Promise<RawLink[]> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: {
      width: DEFAULT_DESKTOP_VIEWPORT.width,
      height: DEFAULT_DESKTOP_VIEWPORT.height,
    },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  try {
    await gotoWithFallback({
      page,
      url: entryUrl,
      waitUntil,
      timeoutMs: 75_000,
      phase: "discovery",
      fallbackWaitUntil: "domcontentloaded",
      onFallback: onNavigationFallback,
    });
    const links = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
      return anchors.map((anchor) => {
        const href = anchor.getAttribute("href") ?? "";
        const absoluteHref = anchor.href || href;
        const title =
          anchor.textContent?.replace(/\s+/g, " ").trim().slice(0, 120) ||
          anchor.getAttribute("aria-label") ||
          "";
        const inNav = Boolean(anchor.closest("header, nav"));
        const inMain = Boolean(anchor.closest("main"));

        return {
          href: absoluteHref,
          title,
          source: inNav ? ("nav" as const) : ("link" as const),
          depth: inNav ? 0 : inMain ? 1 : 2,
        };
      });
    });
    return links;
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function discoverCoreRoutes(options: DiscoverCoreRoutesOptions): Promise<RouteDiscoveryResult> {
  const entry = new URL(options.entryUrl);
  const rawLinks = await collectRawLinks(options.entryUrl, options.waitUntil, options.onNavigationFallback);

  const dedup = new Map<string, RouteDiscoveryTarget>();

  const homeUrl = `${entry.protocol}//${entry.host}/`;
  dedup.set(homeUrl, {
    url: homeUrl,
    path: "/",
    title: "Home",
    source: "nav",
    depth: 0,
    priorityScore: scoreCoreRoute("/", "nav", 0),
  });

  for (const rawLink of rawLinks) {
    if (!rawLink.href || rawLink.href.includes("?") || rawLink.href.includes("#")) {
      continue;
    }
    const normalized = normalizeSameDomainUrl(rawLink.href, entry);
    if (!normalized) {
      continue;
    }
    const route: RouteDiscoveryTarget = {
      url: normalized.url,
      path: normalized.path,
      title: rawLink.title || undefined,
      source: rawLink.source,
      depth: rawLink.depth,
      priorityScore: scoreDiscoveredRoute(normalized.url, normalized.path, rawLink.source, rawLink.depth, entry),
    };

    const existing = dedup.get(route.url);
    if (!existing) {
      dedup.set(route.url, route);
      continue;
    }

    if (
      route.priorityScore > existing.priorityScore ||
      (route.priorityScore === existing.priorityScore && route.source === "nav" && existing.source !== "nav")
    ) {
      dedup.set(route.url, route);
    }
  }

  const routes = [...dedup.values()]
    .sort((a, b) => b.priorityScore - a.priorityScore || a.url.localeCompare(b.url));

  return {
    entryUrl: options.entryUrl,
    routes,
  };
}

export function __testables() {
  return {
    normalizePath,
    normalizeSameDomainUrl,
    pathMatches,
    isAllowedBrandHost,
    scoreDiscoveredRoute,
  };
}
