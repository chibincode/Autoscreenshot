import type {
  EagleFlatFolder,
  EagleFolderRules,
  FolderResolveResult,
  FullPageType,
  SectionType,
} from "../types.js";

const DEFAULT_PAGE_GENERAL_FOLDER = "Page_Gerneral";
const DEFAULT_SECTION_GENERAL_FOLDER = "Section_Gerneral";

function normalizeFolderName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_\-]+/g, "");
}

function root(reason: FolderResolveResult["reason"]): FolderResolveResult {
  return {
    folderId: undefined,
    resolvedBy: "root",
    reason,
  };
}

function findExactFolderByName(
  folderName: string,
  folderIndex: ReturnType<typeof buildFolderIndex>,
): EagleFlatFolder | "ambiguous" | undefined {
  const normalizedTarget = normalizeFolderName(folderName);
  const matches = folderIndex.normalized
    .filter(({ normalizedName }) => normalizedName === normalizedTarget)
    .map(({ folder }) => folder);
  const uniqueMatches = [...new Map(matches.map((item) => [item.id, item])).values()];

  if (uniqueMatches.length === 1) {
    return uniqueMatches[0];
  }
  if (uniqueMatches.length > 1) {
    return "ambiguous";
  }
  return undefined;
}

function resolveGeneralFolder(
  folderName: string,
  folderIndex: ReturnType<typeof buildFolderIndex>,
): FolderResolveResult {
  const matched = findExactFolderByName(folderName, folderIndex);
  if (matched === "ambiguous") {
    return root("ambiguous_name");
  }
  if (!matched) {
    return root("type_unmatched");
  }
  return {
    folderId: matched.id,
    resolvedBy: "generic_fallback",
    reason: "default_general",
  };
}

export function buildFolderIndex(folders: EagleFlatFolder[]): {
  byId: Map<string, EagleFlatFolder>;
  normalized: Array<{ folder: EagleFlatFolder; normalizedName: string }>;
} {
  const byId = new Map<string, EagleFlatFolder>();
  const normalized: Array<{ folder: EagleFlatFolder; normalizedName: string }> = [];

  for (const folder of folders) {
    byId.set(folder.id, folder);
    normalized.push({
      folder,
      normalizedName: normalizeFolderName(folder.name),
    });
  }

  return { byId, normalized };
}

export function resolveSectionFolder(
  sectionType: SectionType | undefined,
  rules: EagleFolderRules,
  folderIndex: ReturnType<typeof buildFolderIndex>,
): FolderResolveResult {
  if (!sectionType || sectionType === "unknown") {
    return resolveGeneralFolder(DEFAULT_SECTION_GENERAL_FOLDER, folderIndex);
  }

  const rule = rules.sections[sectionType];
  let explicitFolderMissing = false;

  if (rule?.folderId) {
    if (folderIndex.byId.has(rule.folderId)) {
      return {
        folderId: rule.folderId,
        resolvedBy: "explicit",
        reason: "mapped",
      };
    }
    explicitFolderMissing = true;
  }

  if (rules.fallbackByName) {
    const hints = (rule?.nameHints && rule.nameHints.length > 0
      ? rule.nameHints
      : [sectionType])
      .map((hint) => normalizeFolderName(hint))
      .filter(Boolean);

    const matched = folderIndex.normalized
      .filter(({ normalizedName }) => hints.some((hint) => normalizedName.includes(hint)))
      .map(({ folder }) => folder);
    const uniqueMatches = [...new Map(matched.map((item) => [item.id, item])).values()];

    if (uniqueMatches.length === 1) {
      return {
        folderId: uniqueMatches[0].id,
        resolvedBy: "name_fallback",
        reason: "mapped",
      };
    }
    if (uniqueMatches.length > 1) {
      return root("ambiguous_name");
    }
  }

  if (explicitFolderMissing) {
    return root("missing_id");
  }

  return root("type_unmatched");
}

export function resolveFullPageFolder(
  fullPageType: FullPageType,
  rules: EagleFolderRules,
  folderIndex: ReturnType<typeof buildFolderIndex>,
): FolderResolveResult {
  if (fullPageType === "unmatched") {
    return resolveGeneralFolder(DEFAULT_PAGE_GENERAL_FOLDER, folderIndex);
  }

  const rule = rules.fullPage[fullPageType];
  if (!rule) {
    return root("type_unmatched");
  }

  if (!rule.folderId) {
    return root("type_unmatched");
  }

  if (!folderIndex.byId.has(rule.folderId)) {
    return root("missing_id");
  }

  return {
    folderId: rule.folderId,
    resolvedBy: "explicit",
    reason: "mapped",
  };
}
