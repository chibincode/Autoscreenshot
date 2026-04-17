export type JobMode = "single" | "core-routes";
export type JobStatus =
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "success"
  | "partial_success"
  | "failed"
  | "cancelled";

export type RouteStatus = "queued" | "running" | "success" | "failed" | "skipped";

export interface AssetFeedbackJob {
  id: string;
  status: JobStatus;
  mode: JobMode;
}

export interface AssetFeedbackAsset {
  id: number;
  kind: "fullPage" | "section";
  sectionType: string | null;
  label: string;
  fileName: string;
  quality: number;
  dpr: number;
  capturedAt: string;
  selectedForImport: boolean;
  importStatus: "pending_confirmation" | "imported" | "failed";
  importOk: boolean;
  importError: string | null;
  eagleId: string | null;
  previewUrl: string;
  thumbnailUrl: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
  sourceUrl: string | null;
}

export interface AssetFeedbackRoute {
  id: number;
  url: string;
  path: string;
  status: RouteStatus;
  error: string | null;
  attemptCount: number;
  assetCount: number;
}

export type CoreRoutePreviewState = "ready" | "pending" | "failed" | "empty";

export interface AssetLookupIndex {
  assetById: Map<number, AssetFeedbackAsset>;
  assetsBySourceUrl: Map<string, AssetFeedbackAsset[]>;
  latestAssetBySourceUrl: Map<string, AssetFeedbackAsset>;
}

export function formatPendingImportLabel(selectedForImport: boolean): string {
  return selectedForImport ? "Selected, pending import" : "Not selected";
}

export function buildJobStatusHint(job: AssetFeedbackJob): string | null {
  if (job.mode === "core-routes" && job.status === "partial_success") {
    return "For core-routes jobs, partial_success means some routes succeeded and others failed or were skipped. It does not mean Eagle import has already happened.";
  }
  if (job.status === "awaiting_confirmation") {
    return "awaiting_confirmation means assets are only selected for import and still need confirmation before Eagle import starts.";
  }
  return null;
}

function compareAssets(left: AssetFeedbackAsset, right: AssetFeedbackAsset): number {
  if (left.kind !== right.kind) {
    return left.kind === "fullPage" ? -1 : 1;
  }
  const byCapturedAt = Date.parse(right.capturedAt) - Date.parse(left.capturedAt);
  if (byCapturedAt !== 0) {
    return byCapturedAt;
  }
  return right.id - left.id;
}

export function buildAssetLookupIndex(assets: AssetFeedbackAsset[]): AssetLookupIndex {
  const assetById = new Map<number, AssetFeedbackAsset>();
  const grouped = new Map<string, AssetFeedbackAsset[]>();

  for (const asset of assets) {
    assetById.set(asset.id, asset);
    if (!asset.sourceUrl) {
      continue;
    }
    const existing = grouped.get(asset.sourceUrl);
    if (existing) {
      existing.push(asset);
    } else {
      grouped.set(asset.sourceUrl, [asset]);
    }
  }

  const assetsBySourceUrl = new Map<string, AssetFeedbackAsset[]>();
  const latestAssetBySourceUrl = new Map<string, AssetFeedbackAsset>();
  for (const [sourceUrl, groupedAssets] of grouped.entries()) {
    const sortedAssets = [...groupedAssets].sort(compareAssets);
    assetsBySourceUrl.set(sourceUrl, sortedAssets);
    const first = sortedAssets[0];
    if (first) {
      latestAssetBySourceUrl.set(sourceUrl, first);
    }
  }

  return {
    assetById,
    assetsBySourceUrl,
    latestAssetBySourceUrl,
  };
}

export function findAssetForRoute(
  route: Pick<AssetFeedbackRoute, "url">,
  assets: AssetFeedbackAsset[],
): AssetFeedbackAsset | null {
  return findAssetForRouteFromIndex(route, buildAssetLookupIndex(assets));
}

export function findAssetsForRoute(
  route: Pick<AssetFeedbackRoute, "url">,
  assets: AssetFeedbackAsset[],
): AssetFeedbackAsset[] {
  return findAssetsForRouteFromIndex(route, buildAssetLookupIndex(assets));
}

export function findAssetForRouteFromIndex(
  route: Pick<AssetFeedbackRoute, "url">,
  index: AssetLookupIndex,
): AssetFeedbackAsset | null {
  return index.latestAssetBySourceUrl.get(route.url) ?? null;
}

export function findAssetsForRouteFromIndex(
  route: Pick<AssetFeedbackRoute, "url">,
  index: AssetLookupIndex,
): AssetFeedbackAsset[] {
  return index.assetsBySourceUrl.get(route.url) ?? [];
}

export function getCoreRoutePreviewState(
  routeStatus: RouteStatus,
  asset: AssetFeedbackAsset | null,
): CoreRoutePreviewState {
  if (asset) {
    return "ready";
  }
  if (routeStatus === "queued" || routeStatus === "running") {
    return "pending";
  }
  if (routeStatus === "failed") {
    return "failed";
  }
  return "empty";
}

export function canFocusDebugAsset(
  asset: Pick<AssetFeedbackAsset, "kind" | "sectionType">,
  hasSectionDebug: boolean,
): boolean {
  return (
    hasSectionDebug &&
    asset.kind === "section" &&
    Boolean(asset.sectionType) &&
    asset.sectionType !== "unknown"
  );
}

export function buildFeedbackContext(params: {
  job: AssetFeedbackJob;
  asset: AssetFeedbackAsset;
  assetUrl: string;
  route?: AssetFeedbackRoute | null;
}): string {
  const { asset, assetUrl, job, route } = params;
  const lines = [
    `job_id=${job.id}`,
    `job_mode=${job.mode}`,
    `job_status=${job.status}`,
    `job_status_hint=${buildJobStatusHint(job) ?? "-"}`,
    `asset_id=${asset.id}`,
    `asset_file=${asset.fileName}`,
    `asset_label=${asset.label}`,
    `asset_kind=${asset.kind}`,
    `asset_section_type=${asset.sectionType ?? "-"}`,
    `asset_source_url=${asset.sourceUrl ?? "-"}`,
    `asset_preview_url=${assetUrl}`,
    `asset_quality=${asset.quality}`,
    `asset_dpr=${asset.dpr}`,
    `asset_captured_at=${asset.capturedAt}`,
    `asset_selected_for_import=${asset.selectedForImport ? "yes" : "no"}`,
    `asset_import_status=${asset.importStatus}`,
    `asset_import_display=${formatPendingImportLabel(asset.selectedForImport)}`,
    `asset_import_started=${asset.importStatus === "pending_confirmation" ? "no" : "yes"}`,
    `asset_import_error=${asset.importError ?? "-"}`,
    `asset_eagle_id=${asset.eagleId ?? "-"}`,
  ];

  if (route) {
    lines.push(
      `route_id=${route.id}`,
      `route_path=${route.path}`,
      `route_url=${route.url}`,
      `route_status=${route.status}`,
      `route_attempts=${route.attemptCount}`,
      `route_asset_count=${route.assetCount}`,
      `route_error=${route.error ?? "-"}`,
    );
  }

  lines.push("User feedback:");
  return lines.join("\n");
}
