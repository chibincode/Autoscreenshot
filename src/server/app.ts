import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { nanoid } from "nanoid";
import { extractFirstHttpUrl } from "../ai/intent-parser.js";
import { DEFAULT_JOB_OPTIONS } from "../core/defaults.js";
import {
  EAGLE_FOLDER_RULES_RELATIVE_PATH,
  loadEagleFolderRules,
} from "../core/eagle-folder-rules.js";
import {
  buildFolderIndex,
  resolveFullPageFolder,
  resolveSectionFolder,
} from "../core/folder-resolver.js";
import { classifyFullPageType } from "../core/fullpage-classifier.js";
import {
  executeInstruction,
  importSelectedByManifestPath,
  resolveJobOptions,
  retryImportByManifestPath,
  type ExecuteInstructionParams,
  type ExecuteInstructionResult,
} from "../core/job-service.js";
import {
  buildAssetFingerprint,
  buildManifestAssetFingerprint,
  deriveJobStatusFromImportSummary,
  normalizeImportResult,
  summarizeAssetRecords,
  summarizeManifestImports,
} from "../core/import-state.js";
import {
  executeCoreRoutesInstruction,
  retryCoreRouteByManifest,
  type ExecuteCoreRoutesParams,
  type ExecuteCoreRoutesResult,
} from "../core/core-routes-service.js";
import { EagleClient } from "../eagle/client.js";
import { readManifest, writeManifestToPath } from "../utils/manifest.js";
import type {
  AssetRecord,
  AssetPreviewRecord,
  CreateJobRequest,
  EagleFlatFolder,
  FolderSelectionSource,
  JobDetailResponse,
  JobEvent,
  JobExecutionOptions,
  JobStatus,
  JobMode,
  JobRecord,
  RouteTargetSummary,
  RunManifest,
} from "../types.js";
import { buildThumbnailUrl, getThumbnailDimensions, getThumbnailPath } from "./asset-thumbnails.js";
import { JobsRepository } from "./db.js";
import {
  buildPlaywrightRuntimeService,
  type PlaywrightRuntimeService,
} from "./playwright-runtime.js";
import { JobQueue } from "./queue.js";

export interface BuildServerOptions {
  repo?: JobsRepository;
  queue?: JobQueue;
  webDistDir?: string;
  playwrightRuntimeService?: PlaywrightRuntimeService;
  executeInstructionFn?: (params: ExecuteInstructionParams) => Promise<ExecuteInstructionResult>;
  executeCoreRoutesInstructionFn?: (params: ExecuteCoreRoutesParams) => Promise<ExecuteCoreRoutesResult>;
  retryImportFn?: (manifestPath: string, log?: ExecuteInstructionParams["log"]) => Promise<RunManifest>;
  importSelectedFn?: (manifestPath: string, log?: ExecuteInstructionParams["log"]) => Promise<RunManifest>;
  retryCoreRouteFn?: (params: Parameters<typeof retryCoreRouteByManifest>[0]) => ReturnType<typeof retryCoreRouteByManifest>;
}

const AUTO_ARCHIVE_AGE_DAYS = 7;
const AUTO_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_ARCHIVE_TERMINAL_STATUSES: JobStatus[] = [
  "success",
  "partial_success",
  "failed",
  "cancelled",
];

function statusFromManifest(manifest: RunManifest | null): JobStatus {
  if (!manifest) {
    return "failed";
  }
  return deriveJobStatusFromImportSummary(summarizeManifestImports(manifest));
}

function statusFromCoreRouteState(manifest: RunManifest | null, routes: RouteTargetSummary[]): JobStatus {
  if (!manifest || routes.length === 0) {
    return "failed";
  }
  const successCount = routes.filter((route) => route.status === "success").length;
  if (successCount === 0) {
    return "failed";
  }
  if (routes.some((route) => route.status === "failed" || route.status === "queued" || route.status === "running")) {
    return "partial_success";
  }
  return statusFromManifest(manifest);
}

function isTerminalJobStatus(status: JobStatus): boolean {
  return status !== "queued" && status !== "running";
}

function parseJobMode(optionsJson: string): JobMode {
  try {
    const parsed = JSON.parse(optionsJson) as { mode?: unknown };
    return parsed.mode === "core-routes" ? "core-routes" : "single";
  } catch {
    return "single";
  }
}

function normalizeCreateJobRequest(body: CreateJobRequest): {
  instruction: string;
  options: JobExecutionOptions;
} {
  if (!body || typeof body !== "object") {
    throw new Error("Invalid request body");
  }
  if (!body.instruction || typeof body.instruction !== "string" || !body.instruction.trim()) {
    throw new Error("instruction is required");
  }
  const options = resolveJobOptions({
    quality: body.quality,
    dpr: body.dpr,
    sectionScope: body.sectionScope,
    classicMaxSections: body.classicMaxSections,
    mode: body.mode,
    maxRoutes: body.maxRoutes,
    outputDir: body.outputDir,
  });
  return {
    instruction: body.instruction.trim(),
    options,
  };
}

function emitToQueue(queue: JobQueue, event: JobEvent): void {
  queue.emit(event);
}

function getAutoArchiveCutoffIso(now = new Date()): string {
  return new Date(now.getTime() - AUTO_ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function cancelOrphanedRoutes(repo: JobsRepository, jobId: string): void {
  const routes = repo.listRouteTargets(jobId);
  for (const route of routes) {
    if (route.status === "queued" || route.status === "running") {
      repo.updateRouteTargetById({
        id: route.id!,
        status: "skipped",
        error: "Cancelled by user",
      });
    }
  }
}

function serializeSse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

interface AssetFolderState {
  resolvedEagleFolderId: string | null;
  resolvedEagleFolderPath: string | null;
  targetEagleFolderId: string | null;
  targetEagleFolderPath: string | null;
  folderSelectionSource: FolderSelectionSource;
}

function sortEagleFolders(folders: EagleFlatFolder[]): EagleFlatFolder[] {
  return [...folders].sort((left, right) => left.path.localeCompare(right.path));
}

async function loadFlatEagleFolders(): Promise<EagleFlatFolder[]> {
  const eagle = new EagleClient();
  const folders = await eagle.listFolders();
  return sortEagleFolders(eagle.flattenFolders(folders));
}

function buildAssetRecordLookup(assets: AssetRecord[]): Map<string, AssetRecord[]> {
  const assetsByFingerprint = new Map<string, AssetRecord[]>();
  for (const asset of assets) {
    const fingerprint = buildAssetFingerprint(asset);
    const matches = assetsByFingerprint.get(fingerprint) ?? [];
    matches.push(asset);
    assetsByFingerprint.set(fingerprint, matches);
  }
  return assetsByFingerprint;
}

function resolveAssetFolderState(
  asset: Pick<AssetRecord, "kind" | "sectionType" | "sourceUrl" | "folderOverrideId">,
  rulesState: Awaited<ReturnType<typeof loadEagleFolderRules>>,
  folderIndex: ReturnType<typeof buildFolderIndex>,
): AssetFolderState {
  const resolvedFolderResult =
    asset.kind === "section"
      ? resolveSectionFolder(asset.sectionType ?? undefined, rulesState.rules, folderIndex)
      : resolveFullPageFolder(
          classifyFullPageType(asset.sourceUrl, rulesState.rules).type,
          rulesState.rules,
          folderIndex,
        );
  const resolvedFolder = resolvedFolderResult.folderId
    ? folderIndex.byId.get(resolvedFolderResult.folderId) ?? null
    : null;
  const overrideFolder = asset.folderOverrideId
    ? folderIndex.byId.get(asset.folderOverrideId) ?? null
    : null;

  if (overrideFolder) {
    return {
      resolvedEagleFolderId: resolvedFolderResult.folderId ?? null,
      resolvedEagleFolderPath: resolvedFolder?.path ?? null,
      targetEagleFolderId: overrideFolder.id,
      targetEagleFolderPath: overrideFolder.path,
      folderSelectionSource: "manual",
    };
  }

  if (resolvedFolder) {
    return {
      resolvedEagleFolderId: resolvedFolder.id,
      resolvedEagleFolderPath: resolvedFolder.path,
      targetEagleFolderId: resolvedFolder.id,
      targetEagleFolderPath: resolvedFolder.path,
      folderSelectionSource: "auto",
    };
  }

  return {
      resolvedEagleFolderId: resolvedFolderResult.folderId ?? null,
      resolvedEagleFolderPath: null,
      targetEagleFolderId: null,
      targetEagleFolderPath: null,
      folderSelectionSource: "missing",
    };
}

function findManifestAsset(
  manifest: RunManifest | null,
  asset: AssetRecord,
): RunManifest["assets"][number] | null {
  if (!manifest) {
    return null;
  }
  return (
    manifest.assets.find(
      (candidate) =>
        candidate.fileName === asset.fileName &&
        candidate.kind === asset.kind &&
        candidate.label === asset.label &&
        (candidate.sectionType ?? null) === asset.sectionType &&
        candidate.sourceUrl === asset.sourceUrl,
    ) ?? null
  );
}

function normalizeManifestImports(manifest: RunManifest): RunManifest {
  return {
    ...manifest,
    assets: manifest.assets.map((asset) => ({
      ...asset,
      import: normalizeImportResult(asset.import),
    })),
  };
}

function syncManifestSelection(
  manifest: RunManifest,
  assets: AssetRecord[],
  selectedAssetIds: Set<number>,
): RunManifest {
  const assetsByFingerprint = buildAssetRecordLookup(assets);

  return {
    ...manifest,
    assets: manifest.assets.map((asset) => {
      const fingerprint = buildManifestAssetFingerprint(asset);
      const matched = assetsByFingerprint.get(fingerprint)?.shift();
      const normalizedImport = normalizeImportResult(asset.import);
      if (!matched) {
        return {
          ...asset,
          import: normalizedImport,
        };
      }
      return {
        ...asset,
        import: {
          ...normalizedImport,
          selected: selectedAssetIds.has(matched.id),
        },
      };
    }),
  };
}

function syncManifestAssetFolderOverride(
  manifest: RunManifest,
  assets: AssetRecord[],
  assetId: number,
  folderOverrideId: string,
): RunManifest {
  const assetsByFingerprint = buildAssetRecordLookup(assets);

  return {
    ...manifest,
    assets: manifest.assets.map((asset) => {
      const fingerprint = buildManifestAssetFingerprint(asset);
      const matched = assetsByFingerprint.get(fingerprint)?.shift();
      if (!matched || matched.id !== assetId) {
        return asset;
      }
      return {
        ...asset,
        folderOverrideId,
      };
    }),
  };
}

async function decorateAssetsForResponse(
  assets: AssetRecord[],
  manifest: RunManifest | null,
  cwd = process.cwd(),
): Promise<AssetPreviewRecord[]> {
  const rulesState = await loadEagleFolderRules(cwd);
  let folderIndex = buildFolderIndex([]);

  try {
    folderIndex = buildFolderIndex(await loadFlatEagleFolders());
  } catch {
    folderIndex = buildFolderIndex([]);
  }

  return Promise.all(assets.map(async (asset) => {
    const manifestAsset = findManifestAsset(manifest, asset);
    const folderState = resolveAssetFolderState(
      {
        ...asset,
        folderOverrideId: manifestAsset?.folderOverrideId ?? asset.folderOverrideId,
      },
      rulesState,
      folderIndex,
    );
    const { thumbnailWidth, thumbnailHeight } = await getThumbnailDimensions(asset).catch(() => ({
      thumbnailWidth: 360,
      thumbnailHeight: 225,
    }));

    return {
      ...asset,
      pageTitle: manifestAsset?.pageTitle,
      previewUrl: `/api/assets/${asset.id}/file`,
      thumbnailUrl: buildThumbnailUrl(asset.id, thumbnailWidth),
      thumbnailWidth,
      thumbnailHeight,
      ...folderState,
      eagleFolderId: folderState.targetEagleFolderId,
      eagleFolderPath: folderState.targetEagleFolderPath,
    };
  }));
}

async function collectAssetsMissingFolderTarget(
  assets: AssetRecord[],
  manifest: RunManifest,
  mode: "selected_pending" | "selected_failed",
  cwd = process.cwd(),
): Promise<AssetRecord[]> {
  const rulesState = await loadEagleFolderRules(cwd);
  let folderIndex = buildFolderIndex([]);

  try {
    folderIndex = buildFolderIndex(await loadFlatEagleFolders());
  } catch {
    folderIndex = buildFolderIndex([]);
  }

  const manifestAssetsByFingerprint = new Map<string, RunManifest["assets"][number][]>();
  for (const asset of manifest.assets) {
    const fingerprint = buildManifestAssetFingerprint(asset);
    const matches = manifestAssetsByFingerprint.get(fingerprint) ?? [];
    matches.push(asset);
    manifestAssetsByFingerprint.set(fingerprint, matches);
  }

  return assets.filter((asset) => {
    if (!asset.selectedForImport) {
      return false;
    }
    if (mode === "selected_pending" && asset.importStatus !== "pending_confirmation") {
      return false;
    }
    if (mode === "selected_failed" && asset.importStatus !== "failed") {
      return false;
    }

    const fingerprint = buildAssetFingerprint(asset);
    const manifestAsset = manifestAssetsByFingerprint.get(fingerprint)?.shift();
    const folderState = resolveAssetFolderState(
      {
        ...asset,
        folderOverrideId: manifestAsset?.folderOverrideId ?? asset.folderOverrideId,
      },
      rulesState,
      folderIndex,
    );
    return folderState.folderSelectionSource === "missing";
  });
}

function deriveTerminalJobError(
  status: JobStatus,
  failureMessage: string,
): string | null {
  if (status === "success" || status === "awaiting_confirmation" || status === "partial_success") {
    return null;
  }
  if (status === "cancelled") {
    return "Cancelled by user";
  }
  return failureMessage;
}

async function refreshPersistedTerminalJobState(
  repo: JobsRepository,
  job: JobRecord | null,
): Promise<JobRecord | null> {
  if (!job || !job.manifestPath || job.status === "queued" || job.status === "running" || job.status === "cancelled") {
    return job;
  }

  let manifest: RunManifest;
  try {
    manifest = normalizeManifestImports(await readManifest(job.manifestPath));
  } catch {
    return job;
  }

  const mode = parseJobMode(job.optionsJson);
  const nextStatus =
    mode === "core-routes"
      ? statusFromCoreRouteState(manifest, repo.listRouteTargets(job.id))
      : statusFromManifest(manifest);
  const nextError = deriveTerminalJobError(
    nextStatus,
    mode === "core-routes" ? "Some routes or assets are still failing" : "Some assets still require attention",
  );

  if (job.status === nextStatus && job.error === nextError) {
    return job;
  }

  repo.setJobResult({
    jobId: job.id,
    status: nextStatus,
    taskJson: JSON.stringify(manifest.task),
    manifestPath: job.manifestPath,
    outputDir: manifest.outputDir,
    error: nextError,
  });
  return repo.getJob(job.id);
}

function runAutoArchiveSweep(
  repo: JobsRepository,
  log: FastifyInstance["log"],
  reason: "startup" | "interval",
): { jobIds: string[]; archivedAt: string | null; cutoffIso: string } {
  const cutoffIso = getAutoArchiveCutoffIso();
  const result = repo.archiveFinishedJobsBefore({
    cutoffIso,
    statuses: AUTO_ARCHIVE_TERMINAL_STATUSES,
  });
  log.info(
    {
      reason,
      cutoffIso,
      archivedCount: result.jobIds.length,
      archivedJobIds: result.jobIds,
    },
    "Auto-archive sweep completed",
  );
  return {
    ...result,
    cutoffIso,
  };
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const repo = options.repo ?? new JobsRepository();
  const queue = options.queue ?? new JobQueue();
  const webDistDir = options.webDistDir ?? path.resolve(process.cwd(), "web/dist");
  const playwrightRuntimeService =
    options.playwrightRuntimeService ?? buildPlaywrightRuntimeService({ cwd: process.cwd() });
  const executeInstructionFn = options.executeInstructionFn ?? executeInstruction;
  const executeCoreRoutesInstructionFn =
    options.executeCoreRoutesInstructionFn ?? executeCoreRoutesInstruction;
  const retryImportFn = options.retryImportFn ?? retryImportByManifestPath;
  const importSelectedFn = options.importSelectedFn ?? importSelectedByManifestPath;
  const retryCoreRouteFn = options.retryCoreRouteFn ?? retryCoreRouteByManifest;
  const autoArchiveTimer = setInterval(() => {
    try {
      runAutoArchiveSweep(repo, app.log, "interval");
    } catch (error) {
      app.log.error({ err: error }, "Auto-archive interval sweep failed");
    }
  }, AUTO_ARCHIVE_INTERVAL_MS);
  autoArchiveTimer.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(autoArchiveTimer);
    if (!options.repo) {
      repo.close();
    }
  });

  app.get("/api/config", async () => {
    const rulesState = await loadEagleFolderRules(process.cwd());
    return {
      defaults: DEFAULT_JOB_OPTIONS,
      queue: queue.getStats(),
      eagleImportPolicy: {
        allowCreateFolder: rulesState.rules.policy.allowCreateFolder,
        mappingSource: EAGLE_FOLDER_RULES_RELATIVE_PATH,
        fallback: rulesState.rules.policy.missingFolderBehavior,
      },
    };
  });

  app.get("/api/eagle/folders", async (_request, reply) => {
    try {
      return await loadFlatEagleFolders();
    } catch (error) {
      reply.code(503);
      return {
        error: error instanceof Error ? error.message : "Failed loading Eagle folders",
      };
    }
  });

  app.get("/api/runtime/playwright", async () => {
    return playwrightRuntimeService.check();
  });

  app.post("/api/runtime/playwright/repair", async () => {
    return playwrightRuntimeService.repair();
  });

  app.post<{ Body: CreateJobRequest }>("/api/jobs", async (request, reply) => {
    try {
      const { instruction, options: jobOptions } = normalizeCreateJobRequest(request.body);
      const jobId = nanoid(12);
      repo.createJob({
        id: jobId,
        instruction,
        options: jobOptions,
      });
      repo.addLog(jobId, "info", "Job created");

      queue.enqueue(jobId, async () => {
        repo.setJobRunning(jobId);
        repo.addLog(jobId, "info", "Job started");
        const log: ExecuteInstructionParams["log"] = (level, message) => {
          repo.addLog(jobId, level, message);
          emitToQueue(queue, {
            type: "log",
            jobId,
            level,
            message,
            at: new Date().toISOString(),
          });
        };

        emitToQueue(queue, {
          type: "status",
          jobId,
          status: "running",
          at: new Date().toISOString(),
        });

        try {
          const outputDir = path.join(path.resolve(process.cwd(), jobOptions.outputDir), jobId);
          const manifestPath = path.join(outputDir, "manifest.json");

          const result =
            jobOptions.mode === "core-routes"
              ? await executeCoreRoutesInstructionFn({
                  instruction,
                  options: jobOptions,
                  runId: jobId,
                  outputDir,
                  manifestPath,
                  log,
                  shouldCancel: () => queue.isCancellationRequested(jobId),
                  onRoutesDiscovered: async (routes) => {
                    repo.replaceRouteTargets(jobId, routes);
                    emitToQueue(queue, {
                      type: "assets_updated",
                      jobId,
                      at: new Date().toISOString(),
                    });
                  },
                  onRouteStatus: async (update) => {
                    repo.updateRouteTargetStatus({
                      jobId,
                      url: update.route.url,
                      status: update.status,
                      error: update.error ?? null,
                      attemptCount: update.attemptCount,
                      startedAt: update.startedAt ?? null,
                      finishedAt: update.finishedAt ?? null,
                    });
                    emitToQueue(queue, {
                      type: "assets_updated",
                      jobId,
                      at: new Date().toISOString(),
                    });
                  },
                })
              : await executeInstructionFn({
                  instruction,
                  options: jobOptions,
                  runId: jobId,
                  log,
                });

          repo.replaceAssets(jobId, result.manifest);
          const wasCancelled = jobOptions.mode === "core-routes" && "cancelled" in result && result.cancelled;
          const finalStatus =
            jobOptions.mode === "core-routes"
              ? wasCancelled
                ? "cancelled"
                : statusFromCoreRouteState(result.manifest, repo.listRouteTargets(jobId))
              : statusFromManifest(result.manifest);
          repo.setJobResult({
            jobId,
            status: finalStatus,
            taskJson: JSON.stringify(result.manifest.task),
            manifestPath: result.manifestPath,
            outputDir: result.manifest.outputDir,
            error:
              finalStatus === "success" || finalStatus === "awaiting_confirmation" || finalStatus === "partial_success"
                ? null
                : finalStatus === "cancelled"
                  ? "Cancelled by user"
                  : "Some assets still require attention",
          });

          emitToQueue(queue, {
            type: "assets_updated",
            jobId,
            at: new Date().toISOString(),
          });
          emitToQueue(queue, {
            type: "status",
            jobId,
            status: finalStatus,
            at: new Date().toISOString(),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          repo.addLog(jobId, "error", message);
          const parsedUrl = extractFirstHttpUrl(instruction);
          repo.setJobResult({
            jobId,
            status: "failed",
            taskJson: parsedUrl ? JSON.stringify({ url: parsedUrl }) : undefined,
            error: message,
          });
          emitToQueue(queue, {
            type: "status",
            jobId,
            status: "failed",
            at: new Date().toISOString(),
            message,
          });
        }
      });

      reply.code(202);
      return {
        jobId,
        status: "queued" as const,
      };
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Invalid payload",
      };
    }
  });

  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/cancel", async (request, reply) => {
    const job = repo.getJob(request.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: "Job not found" };
    }
    if (isTerminalJobStatus(job.status)) {
      reply.code(400);
      return { error: "cancel is only available for queued or running jobs" };
    }

    const mode = parseJobMode(job.optionsJson);
    if (job.status === "running" && mode !== "core-routes") {
      reply.code(400);
      return { error: "cancel currently supports queued jobs and running core-routes jobs only" };
    }

    const cancelResult = queue.cancel(job.id);
    if (cancelResult === "queued_cancelled") {
      repo.addLog(job.id, "info", "Job cancelled before execution");
      repo.setJobResult({
        jobId: job.id,
        status: "cancelled",
        error: "Cancelled by user",
      });
      emitToQueue(queue, {
        type: "log",
        jobId: job.id,
        level: "info",
        message: "Job cancelled before execution",
        at: new Date().toISOString(),
      });
      emitToQueue(queue, {
        type: "status",
        jobId: job.id,
        status: "cancelled",
        at: new Date().toISOString(),
        message: "Cancelled by user",
      });
      return { jobId: job.id, status: "cancelled" as const };
    }

    if (cancelResult === "running_cancel_requested") {
      repo.addLog(job.id, "warn", "Cancellation requested; current route will finish first");
      emitToQueue(queue, {
        type: "log",
        jobId: job.id,
        level: "warn",
        message: "Cancellation requested; current route will finish first",
        at: new Date().toISOString(),
      });
      return { jobId: job.id, status: "running" as const, cancellationRequested: true };
    }

    if (cancelResult === "not_found" && (job.status === "queued" || job.status === "running")) {
      repo.addLog(job.id, "warn", "Job cancelled after queue recovery mismatch");
      cancelOrphanedRoutes(repo, job.id);
      repo.setJobResult({
        jobId: job.id,
        status: "cancelled",
        error: "Cancelled by user",
      });
      emitToQueue(queue, {
        type: "log",
        jobId: job.id,
        level: "warn",
        message: "Job cancelled after queue recovery mismatch",
        at: new Date().toISOString(),
      });
      emitToQueue(queue, {
        type: "status",
        jobId: job.id,
        status: "cancelled",
        at: new Date().toISOString(),
        message: "Cancelled by user",
      });
      emitToQueue(queue, {
        type: "assets_updated",
        jobId: job.id,
        at: new Date().toISOString(),
      });
      return { jobId: job.id, status: "cancelled" as const, recovered: true };
    }

    reply.code(409);
    return { error: "Job is not cancellable in current queue state" };
  });

  app.get<{
    Querystring: {
      status?: JobStatus;
      q?: string;
      archivedOnly?: string;
      page?: string;
      pageSize?: string;
    };
  }>("/api/jobs", async (request) => {
    const page = request.query.page ? Number(request.query.page) : 1;
    const pageSize = request.query.pageSize ? Number(request.query.pageSize) : 20;
    const query = {
      status: request.query.status,
      q: request.query.q,
      archivedOnly:
        request.query.archivedOnly === "true" || request.query.archivedOnly === "1",
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
    };
    let result = repo.listJobs(query);

    let refreshed = false;
    for (const item of result.items) {
      const updatedJob = await refreshPersistedTerminalJobState(repo, repo.getJob(item.id));
      if (updatedJob && (updatedJob.status !== item.status || updatedJob.error !== item.error)) {
        refreshed = true;
      }
    }

    if (refreshed) {
      result = repo.listJobs(query);
    }

    return {
      items: result.items,
      total: result.total,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
    };
  });

  app.post<{
    Params: { jobId: string };
    Body: { archived?: boolean };
  }>("/api/jobs/:jobId/archive", async (request, reply) => {
    const job = repo.getJob(request.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: "Job not found" };
    }
    if (!isTerminalJobStatus(job.status)) {
      reply.code(400);
      return { error: "archive is only available for finished jobs" };
    }

    const shouldArchive = request.body?.archived ?? true;
    repo.setJobArchived(job.id, shouldArchive);
    const updatedJob = repo.getJob(job.id);
    if (!updatedJob) {
      reply.code(500);
      return { error: "Job update failed" };
    }

    const logMessage = shouldArchive ? "Job archived" : "Job unarchived";
    const logEntry = repo.addLog(job.id, "info", logMessage);
    emitToQueue(queue, {
      type: "log",
      jobId: job.id,
      level: logEntry.level,
      message: logEntry.message,
      at: logEntry.ts,
    });

    return {
      jobId: updatedJob.id,
      status: updatedJob.status,
      archivedAt: updatedJob.archivedAt,
    };
  });

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request, reply) => {
    await refreshPersistedTerminalJobState(repo, repo.getJob(request.params.jobId));
    const detail = repo.getJobDetail(request.params.jobId);
    if (!detail) {
      reply.code(404);
      return { error: "Job not found" };
    }

    let manifest = null;
    if (detail.job.manifestPath) {
      try {
        manifest = normalizeManifestImports(await readManifest(detail.job.manifestPath));
      } catch {
        manifest = null;
      }
    }

    const assets = await decorateAssetsForResponse(detail.assets, manifest);

    const response: JobDetailResponse = {
      ...detail,
      manifest,
      assets,
    };
    return response;
  });

  app.get<{ Params: { assetId: string } }>("/api/assets/:assetId/file", async (request, reply) => {
    const assetId = Number(request.params.assetId);
    if (!Number.isFinite(assetId)) {
      reply.code(400);
      return { error: "Invalid asset id" };
    }
    const asset = repo.getAssetById(assetId);
    if (!asset || !existsSync(asset.filePath)) {
      reply.code(404);
      return { error: "Asset not found" };
    }
    reply.type("image/jpeg");
    return reply.send(createReadStream(asset.filePath));
  });

  app.get<{
    Params: { assetId: string };
    Querystring: { w?: string; q?: string };
  }>("/api/assets/:assetId/thumbnail", async (request, reply) => {
    const assetId = Number(request.params.assetId);
    if (!Number.isFinite(assetId)) {
      reply.code(400);
      return { error: "Invalid asset id" };
    }
    const asset = repo.getAssetById(assetId);
    if (!asset || !existsSync(asset.filePath)) {
      reply.code(404);
      return { error: "Asset not found" };
    }

    try {
      const thumbnail = await getThumbnailPath(asset, {
        width: Number(request.query?.w),
        quality: Number(request.query?.q),
      });
      reply.type("image/jpeg");
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      return reply.send(createReadStream(thumbnail.filePath));
    } catch {
      reply.type("image/jpeg");
      return reply.send(createReadStream(asset.filePath));
    }
  });

  app.patch<{
    Params: { jobId: string; assetId: string };
    Body: { targetEagleFolderId?: string };
  }>("/api/jobs/:jobId/assets/:assetId/folder", async (request, reply) => {
    const job = repo.getJob(request.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: "Job not found" };
    }
    if (job.status === "running") {
      reply.code(400);
      return { error: "Folder selection is not available while the job is running" };
    }
    if (!job.manifestPath) {
      reply.code(400);
      return { error: "No manifest for this job" };
    }

    const assetId = Number(request.params.assetId);
    if (!Number.isFinite(assetId)) {
      reply.code(400);
      return { error: "Invalid asset id" };
    }

    const targetEagleFolderId = request.body?.targetEagleFolderId;
    if (typeof targetEagleFolderId !== "string" || !targetEagleFolderId.trim()) {
      reply.code(400);
      return { error: "targetEagleFolderId is required" };
    }

    const asset = repo.getAssets(job.id).find((candidate) => candidate.id === assetId);
    if (!asset) {
      reply.code(404);
      return { error: "Asset not found for this job" };
    }
    if (asset.importStatus === "imported") {
      reply.code(400);
      return { error: "Imported assets cannot change target folders" };
    }

    let folders: EagleFlatFolder[];
    try {
      folders = await loadFlatEagleFolders();
    } catch (error) {
      reply.code(503);
      return {
        error: error instanceof Error ? error.message : "Failed loading Eagle folders",
      };
    }

    const folder = folders.find((candidate) => candidate.id === targetEagleFolderId.trim());
    if (!folder) {
      reply.code(400);
      return { error: "targetEagleFolderId must reference an existing Eagle folder" };
    }

    let manifest: RunManifest;
    try {
      manifest = normalizeManifestImports(await readManifest(job.manifestPath));
    } catch {
      reply.code(500);
      return { error: "Failed to read manifest for this job" };
    }

    const assets = repo.getAssets(job.id);
    const updatedManifest = syncManifestAssetFolderOverride(manifest, assets, assetId, folder.id);
    await writeManifestToPath(job.manifestPath, updatedManifest);
    repo.replaceAssets(job.id, updatedManifest);

    const finalStatus =
      parseJobMode(job.optionsJson) === "core-routes"
        ? statusFromCoreRouteState(updatedManifest, repo.listRouteTargets(job.id))
        : statusFromManifest(updatedManifest);
    repo.setJobResult({
      jobId: job.id,
      status: finalStatus,
      taskJson: JSON.stringify(updatedManifest.task),
      manifestPath: job.manifestPath,
      outputDir: updatedManifest.outputDir,
      error:
        finalStatus === "success" || finalStatus === "awaiting_confirmation" || finalStatus === "partial_success"
          ? null
          : "Some assets still require attention",
    });

    emitToQueue(queue, {
      type: "assets_updated",
      jobId: job.id,
      at: new Date().toISOString(),
    });
    emitToQueue(queue, {
      type: "status",
      jobId: job.id,
      status: finalStatus,
      at: new Date().toISOString(),
    });

    return {
      jobId: job.id,
      assetId,
      status: finalStatus,
      targetEagleFolderId: folder.id,
      targetEagleFolderPath: folder.path,
    };
  });

  app.patch<{
    Params: { jobId: string };
    Body: { selectedAssetIds?: number[] };
  }>("/api/jobs/:jobId/assets/selection", async (request, reply) => {
    const job = repo.getJob(request.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: "Job not found" };
    }
    if (job.status === "running") {
      reply.code(400);
      return { error: "Asset selection is not available while the job is running" };
    }
    if (!job.manifestPath) {
      reply.code(400);
      return { error: "No manifest for this job" };
    }
    if (!Array.isArray(request.body?.selectedAssetIds)) {
      reply.code(400);
      return { error: "selectedAssetIds must be an array" };
    }

    const selectedAssetIds = request.body.selectedAssetIds.map((value) => Number(value));
    if (selectedAssetIds.some((value) => !Number.isFinite(value))) {
      reply.code(400);
      return { error: "selectedAssetIds must contain valid asset ids" };
    }

    const assets = repo.getAssets(job.id);
    const assetIds = new Set(assets.map((asset) => asset.id));
    if (selectedAssetIds.some((assetId) => !assetIds.has(assetId))) {
      reply.code(400);
      return { error: "Asset selection contains invalid ids" };
    }

    let manifest: RunManifest;
    try {
      manifest = normalizeManifestImports(await readManifest(job.manifestPath));
    } catch {
      reply.code(500);
      return { error: "Failed to read manifest for this job" };
    }

    const updatedManifest = syncManifestSelection(manifest, assets, new Set(selectedAssetIds));
    await writeManifestToPath(job.manifestPath, updatedManifest);
    repo.replaceAssets(job.id, updatedManifest);

    const finalStatus =
      parseJobMode(job.optionsJson) === "core-routes"
        ? statusFromCoreRouteState(updatedManifest, repo.listRouteTargets(job.id))
        : statusFromManifest(updatedManifest);
    repo.setJobResult({
      jobId: job.id,
      status: finalStatus,
      taskJson: JSON.stringify(updatedManifest.task),
      manifestPath: job.manifestPath,
      outputDir: updatedManifest.outputDir,
      error:
        finalStatus === "success" || finalStatus === "awaiting_confirmation" || finalStatus === "partial_success"
          ? null
          : "Some assets still require attention",
    });

    emitToQueue(queue, {
      type: "assets_updated",
      jobId: job.id,
      at: new Date().toISOString(),
    });
    emitToQueue(queue, {
      type: "status",
      jobId: job.id,
      status: finalStatus,
      at: new Date().toISOString(),
    });

    return {
      jobId: job.id,
      status: finalStatus,
      selectedAssetIds,
    };
  });

  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/import-selected", async (request, reply) => {
    const job = repo.getJob(request.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: "Job not found" };
    }
    if (!job.manifestPath) {
      reply.code(400);
      return { error: "No manifest for this job" };
    }
    if (job.status === "running") {
      reply.code(400);
      return { error: "Job is already running" };
    }

    const summary = summarizeAssetRecords(repo.getAssets(job.id));
    if (summary.selectedPending === 0) {
      reply.code(400);
      return { error: "No selected pending assets to import" };
    }

    let manifest: RunManifest;
    try {
      manifest = normalizeManifestImports(await readManifest(job.manifestPath));
    } catch {
      reply.code(500);
      return { error: "Failed to read manifest for this job" };
    }

    const assetsMissingTarget = await collectAssetsMissingFolderTarget(
      repo.getAssets(job.id),
      manifest,
      "selected_pending",
    );
    if (assetsMissingTarget.length > 0) {
      reply.code(400);
      return {
        error: "Selected pending assets must use an existing Eagle folder before import",
        assetIds: assetsMissingTarget.map((asset) => asset.id),
      };
    }

    queue.enqueue(job.id, async () => {
      repo.setJobRunning(job.id);
      repo.addLog(job.id, "info", "Import selected started");
      emitToQueue(queue, {
        type: "status",
        jobId: job.id,
        status: "running",
        at: new Date().toISOString(),
      });
      try {
        const manifest = await importSelectedFn(job.manifestPath!, (level, message) => {
          repo.addLog(job.id, level, message);
          emitToQueue(queue, {
            type: "log",
            jobId: job.id,
            level,
            message,
            at: new Date().toISOString(),
          });
        });
        repo.replaceAssets(job.id, manifest);
        const mode = parseJobMode(job.optionsJson);
        const finalStatus =
          mode === "core-routes"
            ? statusFromCoreRouteState(manifest, repo.listRouteTargets(job.id))
            : statusFromManifest(manifest);
        repo.setJobResult({
          jobId: job.id,
          status: finalStatus,
          taskJson: JSON.stringify(manifest.task),
          manifestPath: job.manifestPath,
          outputDir: manifest.outputDir,
          error:
            finalStatus === "success" || finalStatus === "awaiting_confirmation" || finalStatus === "partial_success"
              ? null
              : "Some assets still require attention",
        });
        emitToQueue(queue, {
          type: "assets_updated",
          jobId: job.id,
          at: new Date().toISOString(),
        });
        emitToQueue(queue, {
          type: "status",
          jobId: job.id,
          status: finalStatus,
          at: new Date().toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        repo.addLog(job.id, "error", message);
        repo.setJobResult({
          jobId: job.id,
          status: "failed",
          error: message,
        });
        emitToQueue(queue, {
          type: "status",
          jobId: job.id,
          status: "failed",
          at: new Date().toISOString(),
          message,
        });
      }
    });

    reply.code(202);
    return { jobId: job.id, status: "queued" };
  });

  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/retry-import", async (request, reply) => {
    const job = repo.getJob(request.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: "Job not found" };
    }
    if (!job.manifestPath) {
      reply.code(400);
      return { error: "No manifest for this job" };
    }
    if (job.status === "running") {
      reply.code(400);
      return { error: "Job is already running" };
    }
    const summary = summarizeAssetRecords(repo.getAssets(job.id));
    if (summary.selectedFailed === 0) {
      reply.code(400);
      return { error: "No selected failed assets to retry" };
    }

    let manifest: RunManifest;
    try {
      manifest = normalizeManifestImports(await readManifest(job.manifestPath));
    } catch {
      reply.code(500);
      return { error: "Failed to read manifest for this job" };
    }

    const assetsMissingTarget = await collectAssetsMissingFolderTarget(
      repo.getAssets(job.id),
      manifest,
      "selected_failed",
    );
    if (assetsMissingTarget.length > 0) {
      reply.code(400);
      return {
        error: "Selected failed assets must use an existing Eagle folder before retry",
        assetIds: assetsMissingTarget.map((asset) => asset.id),
      };
    }

    queue.enqueue(job.id, async () => {
      repo.setJobRunning(job.id);
      repo.addLog(job.id, "info", "Retry import started");
      emitToQueue(queue, {
        type: "status",
        jobId: job.id,
        status: "running",
        at: new Date().toISOString(),
      });
      try {
        const manifest = await retryImportFn(job.manifestPath!, (level, message) => {
          repo.addLog(job.id, level, message);
          emitToQueue(queue, {
            type: "log",
            jobId: job.id,
            level,
            message,
            at: new Date().toISOString(),
          });
        });
        repo.replaceAssets(job.id, manifest!);
        const mode = parseJobMode(job.optionsJson);
        const finalStatus =
          mode === "core-routes"
            ? statusFromCoreRouteState(manifest, repo.listRouteTargets(job.id))
            : statusFromManifest(manifest);
        repo.setJobResult({
          jobId: job.id,
          status: finalStatus,
          taskJson: JSON.stringify(manifest!.task),
          manifestPath: job.manifestPath,
          outputDir: manifest!.outputDir,
          error:
            finalStatus === "success" || finalStatus === "awaiting_confirmation" || finalStatus === "partial_success"
              ? null
              : "Some assets still require attention",
        });
        emitToQueue(queue, {
          type: "assets_updated",
          jobId: job.id,
          at: new Date().toISOString(),
        });
        emitToQueue(queue, {
          type: "status",
          jobId: job.id,
          status: finalStatus,
          at: new Date().toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        repo.addLog(job.id, "error", message);
        repo.setJobResult({
          jobId: job.id,
          status: "failed",
          error: message,
        });
        emitToQueue(queue, {
          type: "status",
          jobId: job.id,
          status: "failed",
          at: new Date().toISOString(),
          message,
        });
      }
    });

    reply.code(202);
    return { jobId: job.id, status: "queued" };
  });

  app.post<{
    Params: { jobId: string };
    Body: { routeId?: number };
  }>("/api/jobs/:jobId/retry-route", async (request, reply) => {
    const job = repo.getJob(request.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: "Job not found" };
    }
    if (!job.manifestPath) {
      reply.code(400);
      return { error: "No manifest for this job" };
    }
    if (parseJobMode(job.optionsJson) !== "core-routes") {
      reply.code(400);
      return { error: "retry-route is only available for core-routes mode jobs" };
    }

    const routeId = Number(request.body?.routeId);
    if (!Number.isFinite(routeId)) {
      reply.code(400);
      return { error: "routeId is required" };
    }
    const route = repo.getRouteTargetById(routeId);
    if (!route || route.jobId !== job.id) {
      reply.code(404);
      return { error: "Route target not found" };
    }
    if (!isTerminalJobStatus(job.status)) {
      reply.code(400);
      return { error: "retry-route is only available after the core-routes job has finished" };
    }
    if (route.status !== "failed") {
      reply.code(400);
      return { error: "retry-route is only available for failed routes" };
    }

    queue.enqueue(job.id, async () => {
      repo.setJobRunning(job.id);
      repo.addLog(job.id, "info", `Retry route started: ${route.path}`);
      emitToQueue(queue, {
        type: "status",
        jobId: job.id,
        status: "running",
        at: new Date().toISOString(),
      });

      const startedAt = new Date().toISOString();
      repo.updateRouteTargetById({
        id: route.id,
        status: "running",
        error: null,
        startedAt,
      });
      emitToQueue(queue, {
        type: "assets_updated",
        jobId: job.id,
        at: new Date().toISOString(),
      });

      try {
        const retried = await retryCoreRouteFn({
          manifestPath: job.manifestPath!,
          routeUrl: route.url,
          routePath: route.path,
          routeTitle: route.title,
          routeSource: route.source,
          routeDepth: route.depth,
          routePriorityScore: route.priorityScore,
          routeAttemptCount: route.attemptCount,
          log: (level, message) => {
            repo.addLog(job.id, level, message);
            emitToQueue(queue, {
              type: "log",
              jobId: job.id,
              level,
              message,
              at: new Date().toISOString(),
            });
          },
        });

        repo.updateRouteTargetById({
          id: route.id,
          status: "success",
          error: null,
          attemptCount: retried.route.attemptCount,
          startedAt: retried.route.startedAt ?? startedAt,
          finishedAt: retried.route.finishedAt ?? new Date().toISOString(),
        });
        repo.replaceAssets(job.id, retried.manifest);
        const finalStatus = statusFromCoreRouteState(retried.manifest, repo.listRouteTargets(job.id));
        repo.setJobResult({
          jobId: job.id,
          status: finalStatus,
          taskJson: JSON.stringify(retried.manifest.task),
          manifestPath: job.manifestPath,
          outputDir: retried.manifest.outputDir,
          error:
            finalStatus === "success" || finalStatus === "awaiting_confirmation" || finalStatus === "partial_success"
              ? null
              : "Some routes or assets are still failing",
        });

        emitToQueue(queue, {
          type: "assets_updated",
          jobId: job.id,
          at: new Date().toISOString(),
        });
        emitToQueue(queue, {
          type: "status",
          jobId: job.id,
          status: finalStatus,
          at: new Date().toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts =
          error && typeof error === "object" && "attempts" in error && typeof error.attempts === "number"
            ? error.attempts
            : 1;
        repo.addLog(job.id, "error", message);
        repo.updateRouteTargetById({
          id: route.id,
          status: "failed",
          error: message,
          attemptCount: route.attemptCount + attempts,
          finishedAt: new Date().toISOString(),
        });
        const latestManifest = job.manifestPath ? await readManifest(job.manifestPath).catch(() => null) : null;
        const finalStatus = statusFromCoreRouteState(latestManifest, repo.listRouteTargets(job.id));
        repo.setJobResult({
          jobId: job.id,
          status: finalStatus,
          error: message,
        });
        emitToQueue(queue, {
          type: "assets_updated",
          jobId: job.id,
          at: new Date().toISOString(),
        });
        emitToQueue(queue, {
          type: "status",
          jobId: job.id,
          status: finalStatus,
          at: new Date().toISOString(),
          message,
        });
      }
    });

    reply.code(202);
    return { jobId: job.id, routeId: route.id, status: "queued" };
  });

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId/events", async (request, reply) => {
    const jobId = request.params.jobId;
    const job = repo.getJob(jobId);
    if (!job) {
      reply.code(404);
      return { error: "Job not found" };
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(serializeSse({
      type: "status",
      jobId,
      status: job.status,
      at: new Date().toISOString(),
      message: "Connected",
    }));

    const listener = (event: JobEvent) => {
      if (event.jobId !== jobId) {
        return;
      }
      reply.raw.write(serializeSse(event));
    };
    queue.events.on("job-event", listener);

    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      queue.events.off("job-event", listener);
      reply.raw.end();
    });
  });

  if (existsSync(webDistDir)) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/",
      wildcard: false,
    });

    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api")) {
        reply.code(404);
        return { error: "Not found" };
      }
      return reply.sendFile("index.html");
    });
  }

  try {
    runAutoArchiveSweep(repo, app.log, "startup");
  } catch (error) {
    app.log.error({ err: error }, "Auto-archive startup sweep failed");
  }

  return app;
}
