import path from "node:path";
import { parseInstruction } from "../ai/intent-parser.js";
import { captureTask, isRetryableCaptureError } from "../browser/capture.js";
import type {
  EagleFolderRules,
  FullPageType,
  JobExecutionOptions,
  ParsedTask,
  RouteDiscoveryTarget,
  RouteTargetStatus,
  RouteTargetSummary,
  RunManifest,
} from "../types.js";
import { loadEagleFolderRules } from "./eagle-folder-rules.js";
import { classifyFullPageType } from "./fullpage-classifier.js";
import { discoverCoreRoutes } from "./route-discovery.js";
import { importManifestAssets, resolveJobOptions } from "./job-service.js";
import { ensureDir, readManifest, writeManifestToPath } from "../utils/manifest.js";

const FORCED_VIEWPORT = { width: 1920, height: 1080 } as const;
const CORE_ROUTE_TYPE_LIMITS: Partial<Record<Exclude<FullPageType, "unmatched">, number>> = {
  home: 1,
  blog_detail: 1,
  customer_detail: 1,
  product_detail: 1,
  download_detail: 1,
};
const COVERAGE_FAMILY_ORDER: Array<Exclude<FullPageType, "unmatched">> = [
  "home",
  "products_list",
  "product_detail",
  "pricing",
  "customers_list",
  "customer_detail",
  "integration",
  "help",
  "contact",
  "blog_list",
  "blog_detail",
  "about",
  "careers",
  "news",
  "login",
  "signup",
];
const KNOWN_DETAIL_FAMILIES = new Set<Exclude<FullPageType, "unmatched">>([
  "customer_detail",
  "blog_detail",
  "product_detail",
  "download_detail",
]);

type LogLevel = "info" | "warn" | "error";
type LogHandler = (level: LogLevel, message: string) => void;

export interface ExecuteCoreRoutesParams {
  instruction: string;
  options?: Partial<JobExecutionOptions>;
  runId: string;
  outputDir: string;
  manifestPath: string;
  log?: LogHandler;
  shouldCancel?: () => boolean;
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
  cancelled: boolean;
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

interface PlannedCoreRoute {
  route: RouteDiscoveryTarget;
  fullPageType: FullPageType;
  selectedBy?: "coverage" | "fill";
}

interface PrunedCoreRouteFamily {
  familyKey: string;
  keptRoute: RouteDiscoveryTarget;
  prunedCount: number;
}

interface PlannedCoreRoutesResult {
  plannedRoutes: PlannedCoreRoute[];
  prunedFamilies: PrunedCoreRouteFamily[];
  rawCount: number;
}

function buildRouteSummary(params: {
  route: RouteDiscoveryTarget;
  status: RouteTargetStatus;
  attemptCount: number;
  assetCount: number;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastExecutedAt?: string | null;
}): RouteTargetSummary {
  const updatedAt = params.finishedAt ?? params.startedAt ?? new Date().toISOString();
  return {
    url: params.route.url,
    path: params.route.path,
    title: params.route.title ?? null,
    source: params.route.source,
    depth: params.route.depth,
    priorityScore: params.route.priorityScore,
    status: params.status,
    error: params.error ?? null,
    attemptCount: params.attemptCount,
    startedAt: params.startedAt ?? null,
    finishedAt: params.finishedAt ?? null,
    updatedAt,
    assetCount: params.assetCount,
    lastExecutedAt: params.lastExecutedAt ?? null,
  };
}

function normalizeHostname(value: string): string {
  return value.replace(/^www\./i, "").trim().toLowerCase();
}

function routeHostname(route: RouteDiscoveryTarget): string {
  try {
    return normalizeHostname(new URL(route.url).hostname);
  } catch {
    return "unknown-host";
  }
}

function splitRouteSegments(route: RouteDiscoveryTarget): string[] {
  return route.path.split("/").filter(Boolean);
}

function isPreferredRouteCandidate(
  candidate: RouteDiscoveryTarget,
  current: RouteDiscoveryTarget,
): boolean {
  if (candidate.priorityScore !== current.priorityScore) {
    return candidate.priorityScore > current.priorityScore;
  }
  if (candidate.source !== current.source) {
    return candidate.source === "nav";
  }
  return candidate.url.localeCompare(current.url) < 0;
}

function getGenericDetailFamilyCandidate(route: RouteDiscoveryTarget): string | null {
  const segments = splitRouteSegments(route);
  if (segments.length === 2) {
    return `${routeHostname(route)}/${segments[0]}`;
  }
  if (segments.length === 3) {
    return `${routeHostname(route)}/${segments[0]}/${segments[1]}`;
  }
  return null;
}

function collapseDetailFamilies(
  routes: RouteDiscoveryTarget[],
  rules: EagleFolderRules,
): {
  collapsedRoutes: PlannedCoreRoute[];
  prunedFamilies: PrunedCoreRouteFamily[];
} {
  const annotated = routes.map((route) => {
    const fullPageType = classifyFullPageType(route.url, rules).type;
    const genericDetailFamilyCandidate =
      fullPageType === "unmatched" ? getGenericDetailFamilyCandidate(route) : null;
    return {
      route,
      fullPageType,
      genericDetailFamilyCandidate,
    };
  });

  const genericFamilyCounts = new Map<string, number>();
  for (const candidate of annotated) {
    if (!candidate.genericDetailFamilyCandidate) {
      continue;
    }
    genericFamilyCounts.set(
      candidate.genericDetailFamilyCandidate,
      (genericFamilyCounts.get(candidate.genericDetailFamilyCandidate) ?? 0) + 1,
    );
  }

  const familyRepresentatives = new Map<string, { route: RouteDiscoveryTarget; index: number }>();
  const familyMemberIndexes = new Map<string, number[]>();

  for (let index = 0; index < annotated.length; index += 1) {
    const candidate = annotated[index];
    const familyKey = KNOWN_DETAIL_FAMILIES.has(candidate.fullPageType as Exclude<FullPageType, "unmatched">)
      ? candidate.fullPageType
      : candidate.genericDetailFamilyCandidate &&
          (genericFamilyCounts.get(candidate.genericDetailFamilyCandidate) ?? 0) >= 2
        ? candidate.genericDetailFamilyCandidate
        : null;

    if (!familyKey) {
      continue;
    }

    const memberIndexes = familyMemberIndexes.get(familyKey) ?? [];
    memberIndexes.push(index);
    familyMemberIndexes.set(familyKey, memberIndexes);

    const currentRepresentative = familyRepresentatives.get(familyKey);
    if (
      !currentRepresentative ||
      isPreferredRouteCandidate(candidate.route, currentRepresentative.route)
    ) {
      familyRepresentatives.set(familyKey, {
        route: candidate.route,
        index,
      });
    }
  }

  const keptIndexes = new Set<number>();
  const prunedFamilies: PrunedCoreRouteFamily[] = [];
  for (const [familyKey, memberIndexes] of familyMemberIndexes.entries()) {
    const representative = familyRepresentatives.get(familyKey);
    if (!representative) {
      continue;
    }
    keptIndexes.add(representative.index);
    if (memberIndexes.length > 1) {
      prunedFamilies.push({
        familyKey,
        keptRoute: representative.route,
        prunedCount: memberIndexes.length - 1,
      });
    }
  }

  const collapsedRoutes = annotated
    .filter((candidate, index) => {
      const isKnownDetail = KNOWN_DETAIL_FAMILIES.has(
        candidate.fullPageType as Exclude<FullPageType, "unmatched">,
      );
      const isGenericDetail =
        candidate.genericDetailFamilyCandidate &&
        (genericFamilyCounts.get(candidate.genericDetailFamilyCandidate) ?? 0) >= 2;

      if (isKnownDetail || isGenericDetail) {
        return keptIndexes.has(index);
      }
      return true;
    })
    .map((candidate) => ({
      route: candidate.route,
      fullPageType: candidate.fullPageType,
    }));

  return {
    collapsedRoutes,
    prunedFamilies: prunedFamilies.sort((a, b) => a.familyKey.localeCompare(b.familyKey)),
  };
}

function selectPlannedRoutes(
  routes: PlannedCoreRoute[],
  maxRoutes: number,
): PlannedCoreRoute[] {
  const selectedIndexes = new Set<number>();
  const selectedCounts = new Map<FullPageType, number>();

  const canSelectType = (type: FullPageType): boolean => {
    const limit = CORE_ROUTE_TYPE_LIMITS[type as Exclude<FullPageType, "unmatched">];
    if (typeof limit !== "number") {
      return true;
    }
    return (selectedCounts.get(type) ?? 0) < limit;
  };

  const markSelected = (index: number) => {
    const candidate = routes[index];
    selectedIndexes.add(index);
    selectedCounts.set(candidate.fullPageType, (selectedCounts.get(candidate.fullPageType) ?? 0) + 1);
  };

  for (const family of COVERAGE_FAMILY_ORDER) {
    if (selectedIndexes.size >= maxRoutes) {
      break;
    }
    const index = routes.findIndex(
      (candidate, candidateIndex) =>
        !selectedIndexes.has(candidateIndex) &&
        candidate.fullPageType === family &&
        canSelectType(candidate.fullPageType),
    );
    if (index >= 0) {
      markSelected(index);
    }
  }

  for (let index = 0; index < routes.length; index += 1) {
    if (selectedIndexes.size >= maxRoutes) {
      break;
    }
    if (selectedIndexes.has(index)) {
      continue;
    }
    if (!canSelectType(routes[index].fullPageType)) {
      continue;
    }
    markSelected(index);
  }

  const selectedRoutes: PlannedCoreRoute[] = [];
  for (let index = 0; index < routes.length; index += 1) {
    if (!selectedIndexes.has(index)) {
      continue;
    }
    const candidate = routes[index];
    const wasCoverageSelected =
      COVERAGE_FAMILY_ORDER.includes(candidate.fullPageType as Exclude<FullPageType, "unmatched">) &&
      routes.findIndex(
        (item, itemIndex) =>
          itemIndex <= index &&
          selectedIndexes.has(itemIndex) &&
          item.fullPageType === candidate.fullPageType,
      ) === index;
    selectedRoutes.push({
      ...candidate,
      selectedBy: wasCoverageSelected ? "coverage" : "fill",
    });
  }
  return selectedRoutes;
}

function planCoreRoutes(
  routes: RouteDiscoveryTarget[],
  rules: EagleFolderRules,
  maxRoutes: number,
): PlannedCoreRoutesResult {
  const { collapsedRoutes, prunedFamilies } = collapseDetailFamilies(routes, rules);
  const plannedRoutes = selectPlannedRoutes(collapsedRoutes, maxRoutes);
  return {
    plannedRoutes,
    prunedFamilies,
    rawCount: routes.length,
  };
}

function attemptCountFromError(error: unknown): number {
  const attempts = (error as { attempts?: unknown })?.attempts;
  return typeof attempts === "number" && Number.isFinite(attempts) && attempts > 0 ? attempts : 1;
}

async function markRemainingRoutesCancelled(params: {
  plannedRoutes: PlannedCoreRoute[];
  fromIndex: number;
  routeSummaries: RouteTargetSummary[];
  onRouteStatus?: ExecuteCoreRoutesParams["onRouteStatus"];
}): Promise<void> {
  const finishedAt = new Date().toISOString();
  for (let index = params.fromIndex; index < params.plannedRoutes.length; index += 1) {
    const route = params.plannedRoutes[index]!.route;
    params.routeSummaries.push(
      buildRouteSummary({
        route,
        status: "skipped",
        error: "Cancelled by user",
        attemptCount: 0,
        assetCount: 0,
        finishedAt,
      }),
    );
    await params.onRouteStatus?.({
      route,
      status: "skipped",
      error: "Cancelled by user",
      attemptCount: 0,
      finishedAt,
    });
  }
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
}): Promise<{
  assets: RunManifest["assets"];
  attemptCount: number;
  fallbackToDpr1: boolean;
  scrollSceneDebug?: RunManifest["scrollSceneDebug"];
}> {
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
        log: params.log,
        navigationFallback: {
          fallbackWaitUntil: "domcontentloaded",
          onFallback: (event) => {
            emit(
              params.log,
              "warn",
              `route_wait_fallback phase=${event.phase} url=${event.url} from=${event.from} to=${event.to} reason=${event.errorMessage}`,
            );
          },
        },
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
      scrollSceneDebug: captureResult.scrollSceneDebug?.map((scene) => ({
        ...scene,
        sourceUrl: params.route.url,
        routePath: params.route.path,
      })),
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
        scrollSceneDebug: captureResult.scrollSceneDebug?.map((scene) => ({
          ...scene,
          sourceUrl: params.route.url,
          routePath: params.route.path,
        })),
      };
    } catch (retryError) {
      const failure = retryError instanceof Error ? retryError : new Error(String(retryError));
      (failure as Error & { attempts?: number }).attempts = 2;
      throw failure;
    }
  }
}

async function captureRouteWithCrashRetry(params: {
  baseTask: ParsedTask;
  route: RouteDiscoveryTarget;
  outputDir: string;
  sectionScope: JobExecutionOptions["sectionScope"];
  classicMaxSections: number;
  initialDpr: 1 | 2;
  log?: LogHandler;
}): Promise<{
  assets: RunManifest["assets"];
  attemptCount: number;
  fallbackToDpr1: boolean;
  scrollSceneDebug?: RunManifest["scrollSceneDebug"];
}> {
  try {
    return await captureRouteWithFallback(params);
  } catch (error) {
    const firstAttemptCount = attemptCountFromError(error);
    if (!isRetryableCaptureError(error)) {
      throw error;
    }

    emit(
      params.log,
      "warn",
      `route_retry_crash path=${params.route.path} reason=${error instanceof Error ? error.message : String(error)}`,
    );

    try {
      const retried = await captureRouteWithFallback(params);
      const totalAttemptCount = firstAttemptCount + retried.attemptCount;
      emit(
        params.log,
        "info",
        `route_retry_success path=${params.route.path} attempts=${totalAttemptCount}`,
      );
      return {
        assets: retried.assets,
        attemptCount: totalAttemptCount,
        fallbackToDpr1: retried.fallbackToDpr1 || firstAttemptCount > 1,
        scrollSceneDebug: retried.scrollSceneDebug,
      };
    } catch (retryError) {
      const totalAttemptCount = firstAttemptCount + attemptCountFromError(retryError);
      emit(
        params.log,
        "error",
        `route_retry_failed path=${params.route.path} attempts=${totalAttemptCount} reason=${retryError instanceof Error ? retryError.message : String(retryError)}`,
      );
      (retryError as Error & { attempts?: number }).attempts = totalAttemptCount;
      throw retryError;
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
    onNavigationFallback: (event) => {
      emit(
        log,
        "warn",
        `route_wait_fallback phase=${event.phase} url=${event.url} from=${event.from} to=${event.to} reason=${event.errorMessage}`,
      );
    },
    onRedirectResolved: (event) => {
      emit(log, "info", `core_routes_redirect_resolved from=${event.from} to=${event.to}`);
    },
  });
  emit(log, "info", `core_routes_discovered_raw count=${discovery.routes.length}`);

  const rulesState = await loadEagleFolderRules(process.cwd());
  for (const warning of rulesState.warnings) {
    emit(log, "warn", warning);
  }
  const planning = planCoreRoutes(discovery.routes, rulesState.rules, options.maxRoutes);
  emit(log, "info", `core_routes_planned count=${planning.plannedRoutes.length}`);
  for (const prunedFamily of planning.prunedFamilies) {
    emit(
      log,
      "info",
      `core_routes_pruned family=${prunedFamily.familyKey} kept=${prunedFamily.keptRoute.path} pruned=${prunedFamily.prunedCount}`,
    );
  }
  await params.onRoutesDiscovered?.(planning.plannedRoutes.map((plannedRoute) => plannedRoute.route));

  const routeSummaries: RouteTargetSummary[] = [];
  const assets: RunManifest["assets"] = [];
  const scrollSceneDebug: NonNullable<RunManifest["scrollSceneDebug"]> = [];
  let fallbackRoutes = 0;
  let cancelled = false;
  const preferredDpr = initialDprForCoreRoutes(options);

  for (let routeIndex = 0; routeIndex < planning.plannedRoutes.length; routeIndex += 1) {
    if (params.shouldCancel?.()) {
      cancelled = true;
      emit(log, "warn", "job_cancelled_by_user");
      await markRemainingRoutesCancelled({
        plannedRoutes: planning.plannedRoutes,
        fromIndex: routeIndex,
        routeSummaries,
        onRouteStatus: params.onRouteStatus,
      });
      break;
    }

    const plannedRoute = planning.plannedRoutes[routeIndex]!;
    const route = plannedRoute.route;
    const startedAt = new Date().toISOString();
    emit(log, "info", `route_started path=${route.path} url=${route.url}`);
    await params.onRouteStatus?.({
      route,
      status: "running",
      attemptCount: 0,
      startedAt,
    });

    try {
      const captured = await captureRouteWithCrashRetry({
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
      if (captured.scrollSceneDebug?.length) {
        scrollSceneDebug.push(...captured.scrollSceneDebug);
      }
      const finishedAt = new Date().toISOString();
      routeSummaries.push(
        buildRouteSummary({
          route,
          status: "success",
          attemptCount: captured.attemptCount,
          assetCount: captured.assets.length,
          startedAt,
          finishedAt,
          lastExecutedAt: finishedAt,
        }),
      );

      await params.onRouteStatus?.({
        route,
        status: "success",
        attemptCount: captured.attemptCount,
        startedAt,
        finishedAt,
      });
      emit(log, "info", `route_success path=${route.path} assets=${captured.assets.length}`);

      if (params.shouldCancel?.()) {
        cancelled = true;
        emit(log, "warn", `job_cancelled_after_route path=${route.path}`);
        await markRemainingRoutesCancelled({
          plannedRoutes: planning.plannedRoutes,
          fromIndex: routeIndex + 1,
          routeSummaries,
          onRouteStatus: params.onRouteStatus,
        });
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attemptCount =
        error && typeof error === "object" && "attempts" in error && typeof error.attempts === "number"
          ? error.attempts
          : 1;
      const finishedAt = new Date().toISOString();
      routeSummaries.push(
        buildRouteSummary({
          route,
          status: "failed",
          error: message,
          attemptCount,
          assetCount: 0,
          startedAt,
          finishedAt,
          lastExecutedAt: finishedAt,
        }),
      );

      await params.onRouteStatus?.({
        route,
        status: "failed",
        error: message,
        attemptCount,
        startedAt,
        finishedAt,
      });
      emit(log, "error", `route_failed path=${route.path} reason=${message}`);

      if (params.shouldCancel?.()) {
        cancelled = true;
        emit(log, "warn", `job_cancelled_after_route path=${route.path}`);
        await markRemainingRoutesCancelled({
          plannedRoutes: planning.plannedRoutes,
          fromIndex: routeIndex + 1,
          routeSummaries,
          onRouteStatus: params.onRouteStatus,
        });
        break;
      }
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
    scrollSceneDebug,
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
    cancelled,
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
    ...buildRouteSummary({
      route,
      status: "success",
      attemptCount: params.routeAttemptCount + captured.attemptCount,
      assetCount: captured.assets.length,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      lastExecutedAt: new Date().toISOString(),
    }),
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
