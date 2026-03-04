import type { EagleFolderRules, FullPageType } from "../types.js";

const FULL_PAGE_MATCH_ORDER: Array<Exclude<FullPageType, "unmatched">> = [
  "home",
  "pricing",
  "about",
  "careers",
  "blog_list",
  "blog_detail",
  "news",
  "help",
  "login",
  "signup",
  "products_list",
  "product_detail",
  "downloads_list",
  "download_detail",
  "integration",
];

function normalizePathname(pathname: string): string {
  if (!pathname) {
    return "/";
  }
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
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

  const localePrefixPattern = /^\/([a-z]{2}(?:-[a-z]{2})?)(?=\/|$)/i;
  const localeMatch = pathname.match(localePrefixPattern);
  if (!localeMatch) {
    return pathname;
  }

  const stripped = pathname.slice(localeMatch[0].length) || "/";
  return normalizePathname(stripped);
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
): { type: FullPageType; normalizedPathname: string } {
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

  return {
    type: "unmatched",
    normalizedPathname,
  };
}
