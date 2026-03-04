import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EagleFolderRules, FullPageType, SectionType } from "../types.js";

export const EAGLE_FOLDER_RULES_RELATIVE_PATH = "data/eagle-folder-rules.json";

const SECTION_KEYS: Array<Exclude<SectionType, "unknown">> = [
  "hero",
  "feature",
  "testimonial",
  "pricing",
  "team",
  "faq",
  "blog",
  "cta",
  "contact",
  "footer",
];

const FULL_PAGE_KEYS: Array<Exclude<FullPageType, "unmatched">> = [
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

function makeRootFallbackRules(): EagleFolderRules {
  return {
    version: 1,
    policy: {
      allowCreateFolder: false,
      missingFolderBehavior: "root",
    },
    fallbackByName: true,
    urlNormalization: {
      stripQuery: true,
      stripHash: true,
      stripLocalePrefix: true,
    },
    sections: {},
    fullPage: {},
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeEagleFolderRules(raw: unknown): EagleFolderRules {
  const base = makeRootFallbackRules();
  if (!raw || typeof raw !== "object") {
    return base;
  }

  const input = raw as Record<string, unknown>;
  const policyRaw = (input.policy ?? {}) as Record<string, unknown>;
  const urlNormalizationRaw = (input.urlNormalization ?? {}) as Record<string, unknown>;
  const sectionsRaw = (input.sections ?? {}) as Record<string, unknown>;
  const fullPageRaw = (input.fullPage ?? {}) as Record<string, unknown>;

  const sections = SECTION_KEYS.reduce<EagleFolderRules["sections"]>((acc, key) => {
    const sectionValue = sectionsRaw[key];
    if (!sectionValue || typeof sectionValue !== "object") {
      return acc;
    }
    const sectionRule = sectionValue as Record<string, unknown>;
    const folderId =
      typeof sectionRule.folderId === "string" && sectionRule.folderId.trim()
        ? sectionRule.folderId.trim()
        : undefined;
    const nameHints = normalizeStringArray(sectionRule.nameHints);
    acc[key] = {
      ...(folderId ? { folderId } : {}),
      ...(nameHints.length > 0 ? { nameHints } : {}),
    };
    return acc;
  }, {});

  const fullPage = FULL_PAGE_KEYS.reduce<EagleFolderRules["fullPage"]>((acc, key) => {
    const fullPageValue = fullPageRaw[key];
    if (!fullPageValue || typeof fullPageValue !== "object") {
      return acc;
    }
    const fullPageRule = fullPageValue as Record<string, unknown>;
    const folderId =
      typeof fullPageRule.folderId === "string" && fullPageRule.folderId.trim()
        ? fullPageRule.folderId.trim()
        : undefined;
    const pathRules = normalizeStringArray(fullPageRule.pathRules);
    acc[key] = {
      pathRules,
      ...(folderId ? { folderId } : {}),
    };
    return acc;
  }, {});

  return {
    version:
      typeof input.version === "number" && Number.isFinite(input.version)
        ? Math.max(1, Math.round(input.version))
        : base.version,
    policy: {
      allowCreateFolder:
        typeof policyRaw.allowCreateFolder === "boolean"
          ? policyRaw.allowCreateFolder
          : base.policy.allowCreateFolder,
      missingFolderBehavior: "root",
    },
    fallbackByName:
      typeof input.fallbackByName === "boolean"
        ? input.fallbackByName
        : base.fallbackByName,
    urlNormalization: {
      stripQuery:
        typeof urlNormalizationRaw.stripQuery === "boolean"
          ? urlNormalizationRaw.stripQuery
          : base.urlNormalization.stripQuery,
      stripHash:
        typeof urlNormalizationRaw.stripHash === "boolean"
          ? urlNormalizationRaw.stripHash
          : base.urlNormalization.stripHash,
      stripLocalePrefix:
        typeof urlNormalizationRaw.stripLocalePrefix === "boolean"
          ? urlNormalizationRaw.stripLocalePrefix
          : base.urlNormalization.stripLocalePrefix,
    },
    sections,
    fullPage,
  };
}

export function getEagleFolderRulesPath(cwd = process.cwd()): string {
  return path.resolve(cwd, EAGLE_FOLDER_RULES_RELATIVE_PATH);
}

export async function loadEagleFolderRules(cwd = process.cwd()): Promise<{
  path: string;
  rules: EagleFolderRules;
  loadedFromFile: boolean;
  warnings: string[];
}> {
  const rulesPath = getEagleFolderRulesPath(cwd);
  if (!existsSync(rulesPath)) {
    return {
      path: rulesPath,
      rules: makeRootFallbackRules(),
      loadedFromFile: false,
      warnings: [
        `Eagle folder rules file not found at ${rulesPath}; importing assets to root as fallback`,
      ],
    };
  }

  try {
    const raw = await fs.readFile(rulesPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      path: rulesPath,
      rules: normalizeEagleFolderRules(parsed),
      loadedFromFile: true,
      warnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      path: rulesPath,
      rules: makeRootFallbackRules(),
      loadedFromFile: false,
      warnings: [
        `Failed reading Eagle folder rules at ${rulesPath}: ${message}. Importing assets to root as fallback`,
      ],
    };
  }
}
