import type { EagleFolderRules, FullPageType } from "../types.js";
import {
  normalizeHostname,
  normalizePathname,
  stripLocalePrefix,
} from "./url-normalization.js";

const FULL_PAGE_MATCH_ORDER: Array<Exclude<FullPageType, "unmatched">> = [
  "home",
  "pricing",
  "about",
  "careers",
  "contact",
  "customers_list",
  "customer_detail",
  "projects_list",
  "project_detail",
  "blog_list",
  "blog_detail",
  "changelog_list",
  "changelog_detail",
  "news",
  "help",
  "login",
  "signup",
  "products_list",
  "product_detail",
  "downloads_list",
  "download_detail",
  "integration",
  "brandkit",
  "security",
];

const PROJECT_DETAIL_STRONG_TITLE_PATTERN =
  /\b(case study|brand identity|website redesign|web redesign|platform redesign|product redesign|app redesign|web design|website design|product design|ux\/ui design)\b/i;
const PROJECT_DETAIL_TRANSFORMATION_PATTERN = /\b(rebrand(?:ing)?|branding|redesign(?:ed|ing)?)\b/i;
const PROJECT_DETAIL_DELIVERABLE_PATTERN =
  /\b(website|web|platform|product|app|application|identity|development)\b/i;
const PROJECT_DETAIL_DISCIPLINE_PATTERNS = [
  /\bbrand(?:ing)?\b/i,
  /\bweb(?:site)?\b/i,
  /\bmarketing design\b/i,
  /\bproduct design\b/i,
  /\bplatform\b/i,
  /\bportfolio\b/i,
  /\bframer\b/i,
  /\bwebflow\b/i,
  /\binteractive\b/i,
];
const FLAT_PROJECT_DETAIL_EXCLUDED_SLUGS = new Set([
  "service",
  "services",
  "capabilities",
  "expertise",
  "offerings",
  "solutions",
]);

function isBrandBlogHost(hostname: string): boolean {
  return /^blog\./i.test(normalizeHostname(hostname));
}

function isLikelyFlatProjectDetail(pathname: string, pageTitle?: string | null): boolean {
  const segments = normalizePathname(pathname).split("/").filter(Boolean);
  const title = pageTitle?.trim() ?? "";
  if (
    segments.length !== 1 ||
    !title ||
    FLAT_PROJECT_DETAIL_EXCLUDED_SLUGS.has(segments[0].toLowerCase())
  ) {
    return false;
  }

  const disciplineSignalCount = PROJECT_DETAIL_DISCIPLINE_PATTERNS.filter((pattern) =>
    pattern.test(title),
  ).length;

  return (
    PROJECT_DETAIL_STRONG_TITLE_PATTERN.test(title) ||
    (PROJECT_DETAIL_TRANSFORMATION_PATTERN.test(title) &&
      PROJECT_DETAIL_DELIVERABLE_PATTERN.test(title)) ||
    disciplineSignalCount >= 3
  );
}

export function normalizePathnameForClassification(
  sourceUrl: string,
  rules: EagleFolderRules["urlNormalization"],
): string {
  let pathname = "/";
  try {
    const parsedUrl = new URL(sourceUrl);
    pathname = parsedUrl.pathname || "/";
    if (!rules.stripQuery && parsedUrl.search) {
      pathname += parsedUrl.search;
    }
    if (!rules.stripHash && parsedUrl.hash) {
      pathname += parsedUrl.hash;
    }
  } catch {
    pathname = "/";
  }
  pathname = normalizePathname(pathname);

  if (!rules.stripLocalePrefix) {
    return pathname;
  }

  return stripLocalePrefix(pathname);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchPathRule(pathname: string, rule: string): boolean {
  const normalizedPath = normalizePathname(pathname).toLowerCase();
  const normalizedRule = normalizePathname(rule).toLowerCase();

  if (normalizedRule.includes(":slug")) {
    const pattern = `^${escapeRegExp(normalizedRule).replace(":slug", "[^/]+")}$`;
    return new RegExp(pattern, "i").test(normalizedPath);
  }

  if (normalizedRule.endsWith("/*")) {
    const prefix = normalizedRule.slice(0, -1);
    return normalizedPath.startsWith(prefix) && normalizedPath.length > prefix.length;
  }

  return normalizedPath === normalizedRule;
}

export function classifyFullPageType(
  sourceUrl: string,
  rules: EagleFolderRules,
  context: { pageTitle?: string | null } = {},
): { type: FullPageType; normalizedPathname: string } {
  try {
    const parsedUrl = new URL(sourceUrl);
    const normalizedHostname = normalizeHostname(parsedUrl.hostname);
    const normalizedPathname = normalizePathnameForClassification(sourceUrl, rules.urlNormalization);

    if (isBrandBlogHost(normalizedHostname)) {
      return {
        type: normalizedPathname === "/" ? "blog_list" : "blog_detail",
        normalizedPathname,
      };
    }
  } catch {
    // Fall through to pathname-only classification.
  }

  const normalizedPathname = normalizePathnameForClassification(sourceUrl, rules.urlNormalization);

  for (const type of FULL_PAGE_MATCH_ORDER) {
    const mapping = rules.fullPage[type];
    if (!mapping || mapping.pathRules.length === 0) {
      continue;
    }
    if (mapping.pathRules.some((rule) => matchPathRule(normalizedPathname, rule))) {
      return {
        type,
        normalizedPathname,
      };
    }
  }

  if (isLikelyFlatProjectDetail(normalizedPathname, context.pageTitle)) {
    return {
      type: "project_detail",
      normalizedPathname,
    };
  }

  return {
    type: "unmatched",
    normalizedPathname,
  };
}
