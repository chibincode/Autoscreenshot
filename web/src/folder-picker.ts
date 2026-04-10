export interface EagleFolderOption {
  id: string;
  name: string;
  path: string;
}

export interface RankedEagleFolderOption {
  folder: EagleFolderOption;
  isCurrent: boolean;
  isSuggested: boolean;
}

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

export function filterAndRankFolders(
  folders: EagleFolderOption[],
  query: string,
  currentPath: string | null | undefined,
  suggestedPath: string | null | undefined,
): RankedEagleFolderOption[] {
  const normalizedQuery = normalizeText(query);
  const normalizedCurrentPath = normalizeText(currentPath);
  const normalizedSuggestedPath = normalizeText(suggestedPath);

  return folders
    .map((folder) => {
      const normalizedPath = normalizeText(folder.path);
      const normalizedName = normalizeText(folder.name);
      const isCurrent = Boolean(normalizedCurrentPath) && normalizedPath === normalizedCurrentPath;
      const isSuggested = Boolean(normalizedSuggestedPath) && normalizedPath === normalizedSuggestedPath;
      const matchRank = getMatchRank(normalizedPath, normalizedName, normalizedQuery);
      const matches = !normalizedQuery || Number.isFinite(matchRank);

      if (!matches) {
        return null;
      }

      return {
        folder,
        isCurrent,
        isSuggested,
        sortBucket: isCurrent ? 0 : isSuggested ? 1 : 2,
        matchRank,
      };
    })
    .filter((option): option is RankedEagleFolderOption & { sortBucket: number; matchRank: number } => option !== null)
    .sort((left, right) => {
      if (left.sortBucket !== right.sortBucket) {
        return left.sortBucket - right.sortBucket;
      }
      if (left.matchRank !== right.matchRank) {
        return left.matchRank - right.matchRank;
      }
      return left.folder.path.localeCompare(right.folder.path);
    })
    .map(({ folder, isCurrent, isSuggested }) => ({
      folder,
      isCurrent,
      isSuggested,
    }));
}
