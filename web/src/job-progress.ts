export type ActivityStatus =
  | "queued"
  | "running"
  | "awaiting_confirmation"
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

export function describeCompletedCoreRoutesStatus(params: {
  status: ActivityStatus;
  routeProgress: Pick<RouteProgressSummary, "success" | "failed" | "done" | "total">;
  selectedPending: number;
  selectedPendingMissingFolderCount: number;
}): string | null {
  const { routeProgress, selectedPending, selectedPendingMissingFolderCount, status } = params;

  if (status === "awaiting_confirmation") {
    if (selectedPendingMissingFolderCount > 0) {
      return `核心路由已完成 · ${routeProgress.success} 条成功 · ${selectedPendingMissingFolderCount} 张待指定文件夹`;
    }
    return `核心路由已完成 · ${routeProgress.success} 条成功 · ${selectedPending} 张已预选，待确认导入`;
  }

  if (status === "partial_success") {
    const routeSummary = `核心路由已完成 · ${routeProgress.success} 条成功 / ${routeProgress.failed} 条失败`;
    if (selectedPending > 0) {
      return `${routeSummary} · 当前还没有导入到 Eagle`;
    }
    return routeSummary;
  }

  if (status === "success") {
    return `核心路由已完成 · ${routeProgress.success} 条成功`;
  }

  if (status === "failed") {
    return `核心路由失败 · ${routeProgress.failed} 条失败`;
  }

  return null;
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
