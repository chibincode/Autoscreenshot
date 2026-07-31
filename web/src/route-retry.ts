export type RetryableJobStatus =
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "success"
  | "partial_success"
  | "failed"
  | "cancelled";

export type RetryableRouteStatus = "queued" | "running" | "success" | "failed" | "skipped";

export function isTerminalJobStatus(status: RetryableJobStatus): boolean {
  return status !== "queued" && status !== "running";
}

export function canRerunRoute(jobStatus: RetryableJobStatus, routeStatus: RetryableRouteStatus): boolean {
  return (
    isTerminalJobStatus(jobStatus) &&
    (routeStatus === "success" || routeStatus === "failed")
  );
}
