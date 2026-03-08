export type ActivityStatus =
  | "queued"
  | "running"
  | "success"
  | "partial_success"
  | "failed"
  | "cancelled"
  | "skipped";

export type RouteProgressStatus = "queued" | "running" | "success" | "failed" | "skipped";

export interface RouteProgressRoute {
  path: string;
  url: string;
  status: RouteProgressStatus;
}

export interface RouteProgressSummary {
  total: number;
  done: number;
  queued: number;
  running: number;
  failed: number;
  success: number;
  skipped: number;
  completionRatio: number;
  currentRouteLabel: string | null;
}

export function isActiveStatus(status: ActivityStatus): boolean {
  return status === "running";
}

export function getCurrentRunningRouteLabel(routes: readonly RouteProgressRoute[]): string | null {
  const route = routes.find((candidate) => candidate.status === "running");
  if (!route) {
    return null;
  }
  return route.path || route.url;
}

export function deriveRouteProgress(routes: readonly RouteProgressRoute[]): RouteProgressSummary {
  const summary: RouteProgressSummary = {
    total: routes.length,
    done: 0,
    queued: 0,
    running: 0,
    failed: 0,
    success: 0,
    skipped: 0,
    completionRatio: 0,
    currentRouteLabel: getCurrentRunningRouteLabel(routes),
  };

  for (const route of routes) {
    if (route.status === "queued") {
      summary.queued += 1;
      continue;
    }
    if (route.status === "running") {
      summary.running += 1;
      continue;
    }

    summary.done += 1;
    if (route.status === "failed") {
      summary.failed += 1;
      continue;
    }
    if (route.status === "success") {
      summary.success += 1;
      continue;
    }
    if (route.status === "skipped") {
      summary.skipped += 1;
    }
  }

  summary.completionRatio = summary.total === 0 ? 0 : summary.done / summary.total;
  return summary;
}
