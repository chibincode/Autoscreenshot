export function readSelectedJobIdFromSearch(search: string): string | null {
  const jobId = new URLSearchParams(search).get("job");
  const trimmed = jobId?.trim();
  return trimmed ? trimmed : null;
}

export function readSelectedAssetIdFromSearch(search: string): number | null {
  const assetId = new URLSearchParams(search).get("asset");
  if (!assetId) {
    return null;
  }
  const parsed = Number(assetId);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function syncSelectionToUrl(
  currentUrl: string,
  selection: { jobId: string | null; assetId: number | null },
): string {
  const url = new URL(currentUrl);
  if (selection.jobId) {
    url.searchParams.set("job", selection.jobId);
  } else {
    url.searchParams.delete("job");
  }
  if (selection.jobId && selection.assetId !== null) {
    url.searchParams.set("asset", String(selection.assetId));
  } else {
    url.searchParams.delete("asset");
  }
  return url.toString();
}
