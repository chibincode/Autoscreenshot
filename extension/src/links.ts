export function buildConsoleJobUrl(serviceBaseUrl: string, jobId: string): string {
  const target = new URL(serviceBaseUrl);
  target.searchParams.set("job", jobId);
  target.searchParams.delete("asset");
  return target.toString();
}

export function buildConsoleAssetUrl(
  serviceBaseUrl: string,
  selection: { jobId: string; assetId: number },
): string {
  const target = new URL(serviceBaseUrl);
  target.searchParams.set("job", selection.jobId);
  target.searchParams.set("asset", String(selection.assetId));
  return target.toString();
}
