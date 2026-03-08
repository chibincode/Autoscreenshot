export type JobMode = "single" | "core-routes";
export type JobStatus =
  | "queued"
  | "running"
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
  importOk: boolean;
  importError: string | null;
  eagleId: string | null;
  previewUrl: string;
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

export function findAssetForRoute(
  route: Pick<AssetFeedbackRoute, "url">,
  assets: AssetFeedbackAsset[],
): AssetFeedbackAsset | null {
  const matches = assets.filter((asset) => asset.sourceUrl === route.url);
  if (matches.length === 0) {
    return null;
  }
  return [...matches].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "fullPage" ? -1 : 1;
    }
    const byCapturedAt = Date.parse(right.capturedAt) - Date.parse(left.capturedAt);
    if (byCapturedAt !== 0) {
      return byCapturedAt;
    }
    return right.id - left.id;
  })[0];
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
    `asset_import_status=${asset.importOk ? "success" : "failed"}`,
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
