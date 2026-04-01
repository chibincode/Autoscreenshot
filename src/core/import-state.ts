import type {
  AssetImportStatus,
  AssetRecord,
  EagleImportResult,
  JobStatus,
  RunManifest,
} from "../types.js";

export const LEGACY_PENDING_IMPORT_ERROR = "Pending import";

export type ImportAttemptMode = "selected_pending" | "selected_failed";

type ImportLike = Partial<EagleImportResult> | null | undefined;

export function createPendingImportResult(selected = true): EagleImportResult {
  return {
    ok: false,
    selected,
    status: "pending_confirmation",
  };
}

export function normalizeImportResult(value: ImportLike): EagleImportResult {
  const raw = value ?? {};
  let status: AssetImportStatus;
  if (
    raw.status === "pending_confirmation" ||
    raw.status === "imported" ||
    raw.status === "failed"
  ) {
    status = raw.status;
  } else if (raw.ok) {
    status = "imported";
  } else if (
    typeof raw.error === "string" &&
    raw.error.trim() &&
    raw.error !== LEGACY_PENDING_IMPORT_ERROR
  ) {
    status = "failed";
  } else {
    status = "pending_confirmation";
  }

  const selected = typeof raw.selected === "boolean" ? raw.selected : true;
  return {
    ok: status === "imported",
    selected,
    status,
    eagleId: typeof raw.eagleId === "string" && raw.eagleId.trim() ? raw.eagleId : undefined,
    error:
      status === "failed" && typeof raw.error === "string" && raw.error.trim()
        ? raw.error
        : undefined,
  };
}

export function importResultFromAssetRecord(
  asset: Pick<AssetRecord, "selectedForImport" | "importStatus" | "importError" | "eagleId">,
): EagleImportResult {
  return normalizeImportResult({
    selected: asset.selectedForImport,
    status: asset.importStatus,
    eagleId: asset.eagleId ?? undefined,
    error: asset.importError ?? undefined,
  });
}

export function shouldImportAsset(assetImport: ImportLike, mode: ImportAttemptMode): boolean {
  const normalized = normalizeImportResult(assetImport);
  if (!normalized.selected) {
    return false;
  }
  if (mode === "selected_pending") {
    return normalized.status === "pending_confirmation";
  }
  return normalized.status === "failed";
}

export function buildAssetFingerprint(
  asset: Pick<
    AssetRecord,
    "kind" | "sectionType" | "label" | "filePath" | "fileName" | "sourceUrl" | "quality" | "dpr" | "capturedAt"
  >,
): string {
  return [
    asset.kind,
    asset.sectionType ?? "",
    asset.label,
    asset.filePath,
    asset.fileName,
    asset.sourceUrl,
    String(asset.quality),
    String(asset.dpr),
    asset.capturedAt,
  ].join("::");
}

export function buildManifestAssetFingerprint(
  asset: RunManifest["assets"][number],
): string {
  return [
    asset.kind,
    asset.sectionType ?? "",
    asset.label,
    asset.filePath,
    asset.fileName,
    asset.sourceUrl,
    String(asset.quality),
    String(asset.dpr),
    asset.capturedAt,
  ].join("::");
}

export function summarizeManifestImports(manifest: RunManifest): {
  total: number;
  imported: number;
  failed: number;
  pendingConfirmation: number;
  selectedPending: number;
  selectedFailed: number;
} {
  let imported = 0;
  let failed = 0;
  let pendingConfirmation = 0;
  let selectedPending = 0;
  let selectedFailed = 0;

  for (const asset of manifest.assets) {
    const normalized = normalizeImportResult(asset.import);
    if (normalized.status === "imported") {
      imported += 1;
      continue;
    }
    if (normalized.status === "failed") {
      failed += 1;
      if (normalized.selected) {
        selectedFailed += 1;
      }
      continue;
    }
    pendingConfirmation += 1;
    if (normalized.selected) {
      selectedPending += 1;
    }
  }

  return {
    total: manifest.assets.length,
    imported,
    failed,
    pendingConfirmation,
    selectedPending,
    selectedFailed,
  };
}

export function summarizeAssetRecords(
  assets: Array<Pick<AssetRecord, "selectedForImport" | "importStatus">>,
): {
  total: number;
  imported: number;
  failed: number;
  pendingConfirmation: number;
  selectedPending: number;
  selectedFailed: number;
} {
  let imported = 0;
  let failed = 0;
  let pendingConfirmation = 0;
  let selectedPending = 0;
  let selectedFailed = 0;

  for (const asset of assets) {
    if (asset.importStatus === "imported") {
      imported += 1;
      continue;
    }
    if (asset.importStatus === "failed") {
      failed += 1;
      if (asset.selectedForImport) {
        selectedFailed += 1;
      }
      continue;
    }
    pendingConfirmation += 1;
    if (asset.selectedForImport) {
      selectedPending += 1;
    }
  }

  return {
    total: assets.length,
    imported,
    failed,
    pendingConfirmation,
    selectedPending,
    selectedFailed,
  };
}

export function deriveJobStatusFromImportSummary(
  summary: {
    total: number;
    imported: number;
    failed: number;
    pendingConfirmation: number;
  },
): JobStatus {
  if (summary.total === 0) {
    return "failed";
  }
  if (summary.failed > 0) {
    return "partial_success";
  }
  if (summary.pendingConfirmation > 0) {
    return "awaiting_confirmation";
  }
  if (summary.imported > 0) {
    return "success";
  }
  return "failed";
}
