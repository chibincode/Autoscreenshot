export interface EagleFolderOption {
  id: string;
  name: string;
  path: string;
}

export interface RankedEagleFolderOption {
  folder: EagleFolderOption;
  isCurrent: boolean;
  isRecent: boolean;
  isSuggested: boolean;
}

export const RECENT_EAGLE_FOLDER_IDS_STORAGE_KEY = "autoscreenshot.recentEagleFolderIds.v1";
export const MAX_RECENT_EAGLE_FOLDERS = 8;

const TEXT_ALIASES: Array<[from: RegExp, to: string]> = [
  [/projiect/g, "project"],
  [/gerneral/g, "general"],
];

function normalizeText(value: string | null | undefined): string {
  let normalized = value?.trim().toLocaleLowerCase() ?? "";
  for (const [pattern, replacement] of TEXT_ALIASES) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized;
}

function fallbackCompactPath(path: string, maxLength: number): string {
  if (path.length <= maxLength) {
    return path;
  }

  const headLength = Math.max(10, Math.floor((maxLength - 3) * 0.58));
  const tailLength = Math.max(8, maxLength - headLength - 3);
  return `${path.slice(0, headLength)}...${path.slice(-tailLength)}`;
}

export function formatFolderNameForCard(path: string | null | undefined, maxLength = 22): string {
  const trimmedPath = path?.trim() ?? "";
  if (!trimmedPath) {
    return "";
  }

  const segments = trimmedPath.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? trimmedPath;
  if (lastSegment.length <= maxLength) {
    return lastSegment;
  }

  return fallbackCompactPath(lastSegment, maxLength);
}

export function formatFolderPathForCard(path: string | null | undefined, maxLength = 32): string {
  const trimmedPath = path?.trim() ?? "";
  if (!trimmedPath) {
    return "";
  }

  if (trimmedPath.length <= maxLength) {
    return trimmedPath;
  }

  const segments = trimmedPath.split("/").filter(Boolean);
  if (segments.length >= 3) {
    const compactPath = `${segments[0]}/.../${segments[segments.length - 1]}`;
    if (compactPath.length <= maxLength) {
      return compactPath;
    }
  }

  return fallbackCompactPath(trimmedPath, maxLength);
}

function getMatchRank(pathText: string, nameText: string, query: string): number {
  if (!query) {
    return 0;
  }
  if (pathText === query) {
    return 1;
  }
  if (nameText === query) {
    return 2;
  }
  if (pathText.startsWith(query)) {
    return 3;
  }
  if (nameText.startsWith(query)) {
    return 4;
  }
  if (pathText.includes(query)) {
    return 5;
  }
  if (nameText.includes(query)) {
    return 6;
  }
  return Number.POSITIVE_INFINITY;
}

export function parseRecentFolderIds(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return [...new Set(
      parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    )].slice(0, MAX_RECENT_EAGLE_FOLDERS);
  } catch {
    return [];
  }
}

export function rememberRecentFolderId(
  recentFolderIds: string[],
  folderId: string,
  maxItems = MAX_RECENT_EAGLE_FOLDERS,
): string[] {
  const normalizedFolderId = folderId.trim();
  if (!normalizedFolderId || maxItems <= 0) {
    return [];
  }
  return [
    normalizedFolderId,
    ...recentFolderIds.filter((item) => item !== normalizedFolderId),
  ].slice(0, maxItems);
}

export function filterAndRankFolders(
  folders: EagleFolderOption[],
  query: string,
  currentPath: string | null | undefined,
  suggestedPath: string | null | undefined,
  recentFolderIds: string[] = [],
): RankedEagleFolderOption[] {
  const normalizedQuery = normalizeText(query);
  const normalizedCurrentPath = normalizeText(currentPath);
  const normalizedSuggestedPath = normalizeText(suggestedPath);
  const recentFolderRanks = new Map(
    recentFolderIds.map((folderId, index) => [folderId, index]),
  );

  return folders
    .map((folder) => {
      const normalizedPath = normalizeText(folder.path);
      const normalizedName = normalizeText(folder.name);
      const isCurrent = Boolean(normalizedCurrentPath) && normalizedPath === normalizedCurrentPath;
      const isSuggested = Boolean(normalizedSuggestedPath) && normalizedPath === normalizedSuggestedPath;
      const recentRank = recentFolderRanks.get(folder.id);
      const isRecent = recentRank !== undefined && !isCurrent;
      const matchRank = getMatchRank(normalizedPath, normalizedName, normalizedQuery);
      const matches = !normalizedQuery || Number.isFinite(matchRank);

      if (!matches) {
        return null;
      }

      return {
        folder,
        isCurrent,
        isRecent,
        isSuggested,
        sortBucket: isCurrent ? 0 : isRecent ? 1 : isSuggested ? 2 : 3,
        recentRank: recentRank ?? Number.POSITIVE_INFINITY,
        matchRank,
      };
    })
    .filter((option): option is RankedEagleFolderOption & {
      sortBucket: number;
      recentRank: number;
      matchRank: number;
    } => option !== null)
    .sort((left, right) => {
      if (normalizedQuery && left.matchRank !== right.matchRank) {
        return left.matchRank - right.matchRank;
      }
      if (left.sortBucket !== right.sortBucket) {
        return left.sortBucket - right.sortBucket;
      }
      if (left.recentRank !== right.recentRank) {
        return left.recentRank - right.recentRank;
      }
      return left.folder.path.localeCompare(right.folder.path);
    })
    .map(({ folder, isCurrent, isRecent, isSuggested }) => ({
      folder,
      isCurrent,
      isRecent,
      isSuggested,
    }));
}
