import type { EagleFolderRules } from "../types.js";

const DEFAULT_URL_NORMALIZATION_RULES: EagleFolderRules["urlNormalization"] = {
  stripQuery: true,
  stripHash: true,
  stripLocalePrefix: true,
};

export function normalizeHostname(hostname: string): string {
  return hostname.replace(/^www\./i, "").trim().toLowerCase();
}

export function normalizePathname(pathname: string): string {
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

export function stripLocalePrefix(pathname: string): string {
  const localePrefixPattern = /^\/([a-z]{2}(?:-[a-z]{2})?)(?=\/|$)/i;
  const localeMatch = pathname.match(localePrefixPattern);
  if (!localeMatch) {
    return pathname;
  }

  const stripped = pathname.slice(localeMatch[0].length) || "/";
  return normalizePathname(stripped);
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeUrlForComparison(
  sourceUrl: string,
  rules: EagleFolderRules["urlNormalization"] = DEFAULT_URL_NORMALIZATION_RULES,
): string | null {
  try {
    const parsedUrl = new URL(sourceUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }

    let pathname = normalizePathname(parsedUrl.pathname || "/");
    if (rules.stripLocalePrefix) {
      pathname = stripLocalePrefix(pathname);
    }

    const search = rules.stripQuery ? "" : parsedUrl.search;
    const hash = rules.stripHash ? "" : parsedUrl.hash;
    const normalized = new URL(`${parsedUrl.protocol}//${normalizeHostname(parsedUrl.hostname)}${pathname}`);
    normalized.search = search;
    normalized.hash = hash;
    return normalized.toString();
  } catch {
    return null;
  }
}

export function extractNormalizedHostname(sourceUrl: string): string | null {
  try {
    return normalizeHostname(new URL(sourceUrl).hostname);
  } catch {
    return null;
  }
}

export function buildEquivalentUrlQueries(
  sourceUrl: string,
  rules: EagleFolderRules["urlNormalization"] = DEFAULT_URL_NORMALIZATION_RULES,
): string[] {
  try {
    const parsedUrl = new URL(sourceUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return [];
    }

    const search = rules.stripQuery ? "" : parsedUrl.search;
    const hash = rules.stripHash ? "" : parsedUrl.hash;
    let pathname = normalizePathname(parsedUrl.pathname || "/");
    if (rules.stripLocalePrefix) {
      pathname = stripLocalePrefix(pathname);
    }

    const normalizedHost = normalizeHostname(parsedUrl.hostname);
    const hosts = [
      parsedUrl.hostname.trim().toLowerCase(),
      normalizedHost,
      `www.${normalizedHost}`,
    ];

    const uniqueUrls = new Set<string>();
    for (const host of hosts) {
      if (!host) {
        continue;
      }
      const candidate = new URL(`${parsedUrl.protocol}//${host}${pathname}`);
      candidate.search = search;
      candidate.hash = hash;
      uniqueUrls.add(candidate.toString());
    }

    return [...uniqueUrls];
  } catch {
    return [];
  }
}
