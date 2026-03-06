import path from "node:path";
import { parseInstruction } from "../ai/intent-parser.js";
import { captureTask, isRetryableCaptureError } from "../browser/capture.js";
import type {
  JobExecutionOptions,
  ParsedTask,
  RouteDiscoveryTarget,
  RouteTargetStatus,
  RouteTargetSummary,
  RunManifest,
} from "../types.js";
import { discoverCoreRoutes } from "./route-discovery.js";
import { importManifestAssets, resolveJobOptions } from "./job-service.js";
import { ensureDir, readManifest, writeManifestToPath } from "../utils/manifest.js";

const FORCED_VIEWPORT = { width: 1920, height: 1080 } as const;

type LogLevel = "info" | "warn" | "error";
type LogHandler = (level: LogLevel, message: string) => void;

export interface ExecuteCoreRoutesParams {
  instruction: string;
  options?: Partial<JobExecutionOptions>;
  runId: string;
  outputDir: string;
  manifestPath: string;
  log?: LogHandler;
  onRoutesDiscovered?: (routes: RouteDiscoveryTarget[]) => Promise<void> | void;
  onRouteStatus?: (update: {
    route: RouteDiscoveryTarget;
    status: RouteTargetStatus;
    error?: string;
    attemptCount: number;
    startedAt?: string;
    finishedAt?: string;
  }) => Promise<void> | void;
}

export interface ExecuteCoreRoutesResult {
  runId: string;
  manifestPath: string;
  manifest: RunManifest;
  routes: RouteTargetSummary[];
  fallbackRoutes: number;
}

export interface RetryCoreRouteByManifestParams {
  manifestPath: string;
  routeUrl: string;
  routePath: string;
  routeTitle?: string | null;
  routeSource: "nav" | "link";
  routeDepth: number;
  routePriorityScore: number;
  routeAttemptCount: number;
  log?: LogHandler;
}

function emit(log: LogHandler | undefined, level: LogLevel, message: string): void {
  if (log) {
    log(level, message);
  }
}

function initialDprForCoreRoutes(options: JobExecutionOptions): 1 | 2 {
  if (options.dpr === 1) {
    return 1;
  }
  return 2;
}

function normalizeBaseTask(task: ParsedTask): ParsedTask {
  return {
    ...task,
    viewport: {
      width: FORCED_VIEWPORT.width,
      height: FORCED_VIEWPORT.height,
    },
    captures: [{ mode: "fullPage" }],
  };
}

async function captureRouteWithFallback(params: {
  baseTask: ParsedTask;
  route: RouteDiscoveryTarget;
  outputDir: string;
  sectionScope: JobExecutionOptions["sectionScope"];
  classicMaxSections: number;
  initialDpr: 1 | 2;
  log?: LogHandler;
}): Promise<{ assets: RunManifest["assets"]; attemptCount: number; fallbackToDpr1: boolean }> {
  const routeTask: ParsedTask = {
    ...params.baseTask,
    url: params.route.url,
    captures: [{ mode: "fullPage" }],
    image: {
      ...params.baseTask.image,
      dpr: params.initialDpr,
    },
  };

  const runCapture = async (dpr: 1 | 2) =>
    captureTask(
      {
        ...routeTask,
        image: {
          ...routeTask.image,
          dpr,
        },
      },
      {
        outputDir: params.outputDir,
        sectionScope: params.sectionScope,
        classicMaxSections: params.classicMaxSections,
      },
    );

  try {
    const captureResult = await runCapture(params.initialDpr);
    return {
      assets: captureResult.assets.map((asset) => ({
        ...asset,
        sourceUrl: params.route.url,
        import: {
          ok: false,
          error: "Pending import",
        },
      })),
      attemptCount: 1,
      fallbackToDpr1: false,
    };
  } catch (error) {
    if (params.initialDpr === 1 || !isRetryableCaptureError(error)) {
      const failure = error instanceof Error ? error : new Error(String(error));
      (failure as Error & { attempts?: number }).attempts = 1;
      throw failure;
    }

    emit(
      params.log,
      "warn",
      `route_retry_dpr1 path=${params.route.path} reason=${error instanceof Error ? error.message : String(error)}`,
    );

    try {
      const captureResult = await runCapture(1);
      return {
        assets: captureResult.assets.map((asset) => ({
          ...asset,
          sourceUrl: params.route.url,
          import: {
            ok: false,
            error: "Pending import",
          },
        })),
        attemptCount: 2,
        fallbackToDpr1: true,
      };
    } catch (retryError) {
      const failure = retryError instanceof Error ? retryError : new Error(String(retryError));
      (failure as Error & { attempts?: number }).attempts = 2;
      throw failure;
    }
  }
}

export async function executeCoreRoutesInstruction(
  params: ExecuteCoreRoutesParams,
): Promise<ExecuteCoreRoutesResult> {
  const options = resolveJobOptions(params.options);
  const log = params.log;

  emit(log, "info", "Parsing instruction for core-routes mode");
  const parsedTask = await parseInstruction(params.instruction, {
    quality: options.quality,
    dpr: options.dpr,
    sectionScope: options.sectionScope,
  });

  const baseTask = normalizeBaseTask(parsedTask);
  if (
    parsedTask.viewport.width !== FORCED_VIEWPORT.width ||
    parsedTask.viewport.height !== FORCED_VIEWPORT.height
  ) {
    emit(
      log,
      "info",
      `viewport_overridden_to_1920x1080 from ${parsedTask.viewport.width}x${parsedTask.viewport.height}`,
    );
  }

  emit(log, "info", `Discovering core routes from ${baseTask.url}`);
  const discovery = await discoverCoreRoutes({
    entryUrl: baseTask.url,
    maxRoutes: options.maxRoutes,
    waitUntil: baseTask.waitUntil,
  });
  await params.onRoutesDiscovered?.(discovery.routes);
  emit(log, "info", `core_routes_discovered count=${discovery.routes.length}`);

  const routeSummaries: RouteTargetSummary[] = [];
  const assets: RunManifest["assets"] = [];
  let fallbackRoutes = 0;
  const preferredDpr = initialDprForCoreRoutes(options);

  for (const route of discovery.routes) {
    const startedAt = new Date().toISOString();
    emit(log, "info", `route_started path=${route.path} url=${route.url}`);
    await params.onRouteStatus?.({
      route,
      status: "running",
      attemptCount: 0,
      startedAt,
    });

    try {
      const captured = await captureRouteWithFallback({
        baseTask,
        route,
        outputDir: params.outputDir,
        sectionScope: options.sectionScope,
        classicMaxSections: options.classicMaxSections,
        initialDpr: preferredDpr,
        log,
      });
      if (captured.fallbackToDpr1) {
        fallbackRoutes += 1;
      }

      assets.push(...captured.assets);
      const finishedAt = new Date().toISOString();
      const summary: RouteTargetSummary = {
        url: route.url,
        path: route.path,
        title: route.title ?? null,
        source: route.source,
        depth: route.depth,
        priorityScore: route.priorityScore,
        status: "success",
        error: null,
        attemptCount: captured.attemptCount,
        startedAt,
        finishedAt,
        updatedAt: finishedAt,
        assetCount: captured.assets.length,
        lastExecutedAt: finishedAt,
      };
      routeSummaries.push(summary);

      await params.onRouteStatus?.({
        route,
        status: "success",
        attemptCount: captured.attemptCount,
        startedAt,
        finishedAt,
      });
      emit(log, "info", `route_success path=${route.path} assets=${captured.assets.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attemptCount =
        error && typeof error === "object" && "attempts" in error && typeof error.attempts === "number"
          ? error.attempts
          : 1;
      const finishedAt = new Date().toISOString();
      routeSummaries.push({
        url: route.url,
        path: route.path,
        title: route.title ?? null,
        source: route.source,
        depth: route.depth,
        priorityScore: route.priorityScore,
        status: "failed",
        error: message,
        attemptCount,
        startedAt,
        finishedAt,
        updatedAt: finishedAt,
        assetCount: 0,
        lastExecutedAt: finishedAt,
      });

      await params.onRouteStatus?.({
        route,
        status: "failed",
        error: message,
        attemptCount,
        startedAt,
        finishedAt,
      });
      emit(log, "error", `route_failed path=${route.path} reason=${message}`);
    }
  }

  const manifest: RunManifest = {
    runId: params.runId,
    instruction: params.instruction,
    createdAt: new Date().toISOString(),
    task: baseTask,
    sectionScope: options.sectionScope,
    outputDir: params.outputDir,
    routes: routeSummaries,
    assets,
  };

  await ensureDir(params.outputDir);
  await writeManifestToPath(params.manifestPath, manifest);
  emit(log, "info", `Manifest written: ${params.manifestPath}`);

  const importedManifest = await importManifestAssets(manifest, params.manifestPath, log);
  importedManifest.routes = routeSummaries;
  await writeManifestToPath(params.manifestPath, importedManifest);

  return {
    runId: params.runId,
    manifestPath: params.manifestPath,
    manifest: importedManifest,
    routes: routeSummaries,
    fallbackRoutes,
  };
}

export async function retryCoreRouteByManifest(
  params: RetryCoreRouteByManifestParams,
): Promise<{ manifest: RunManifest; route: RouteTargetSummary; fallbackToDpr1: boolean }> {
  const options = resolveJobOptions(undefined);
  const log = params.log;

  const manifestRaw = await readManifest(params.manifestPath);
  const baseTask = normalizeBaseTask(manifestRaw.task);

  const route: RouteDiscoveryTarget = {
    url: params.routeUrl,
    path: params.routePath,
    title: params.routeTitle ?? undefined,
    source: params.routeSource,
    depth: params.routeDepth,
    priorityScore: params.routePriorityScore,
  };

  const captured = await captureRouteWithFallback({
    baseTask,
    route,
    outputDir: manifestRaw.outputDir,
    sectionScope: options.sectionScope,
    classicMaxSections: options.classicMaxSections,
    initialDpr: 2,
    log,
  });

  const filteredAssets = manifestRaw.assets.filter((asset) => !(asset.kind === "fullPage" && asset.sourceUrl === route.url));
  manifestRaw.assets = [...filteredAssets, ...captured.assets];

  const routeSummary: RouteTargetSummary = {
    url: route.url,
    path: route.path,
    title: route.title ?? null,
    source: route.source,
    depth: route.depth,
    priorityScore: route.priorityScore,
    status: "success",
    error: null,
    attemptCount: params.routeAttemptCount + captured.attemptCount,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assetCount: captured.assets.length,
    lastExecutedAt: new Date().toISOString(),
  };

  if (Array.isArray(manifestRaw.routes)) {
    manifestRaw.routes = manifestRaw.routes
      .filter((item) => item.url !== route.url)
      .concat(routeSummary);
  }

  const importedManifest = await importManifestAssets(manifestRaw, params.manifestPath, log);
  return {
    manifest: importedManifest,
    route: routeSummary,
    fallbackToDpr1: captured.fallbackToDpr1,
  };
}
