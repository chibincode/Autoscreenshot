import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { nanoid } from "nanoid";
import { DEFAULT_JOB_OPTIONS } from "../core/defaults.js";
import {
  EAGLE_FOLDER_RULES_RELATIVE_PATH,
  loadEagleFolderRules,
} from "../core/eagle-folder-rules.js";
import {
  executeInstruction,
  resolveJobOptions,
  retryImportByManifestPath,
  summarizeManifest,
  type ExecuteInstructionParams,
  type ExecuteInstructionResult,
} from "../core/job-service.js";
import {
  executeCoreRoutesInstruction,
  retryCoreRouteByManifest,
  type ExecuteCoreRoutesParams,
  type ExecuteCoreRoutesResult,
} from "../core/core-routes-service.js";
import { readManifest } from "../utils/manifest.js";
import type {
  CreateJobRequest,
  JobDetail,
  JobEvent,
  JobExecutionOptions,
  JobStatus,
  JobMode,
  RouteTargetSummary,
  RunManifest,
} from "../types.js";
import { JobsRepository } from "./db.js";
import { JobQueue } from "./queue.js";

export interface BuildServerOptions {
  repo?: JobsRepository;
  queue?: JobQueue;
  webDistDir?: string;
  executeInstructionFn?: (params: ExecuteInstructionParams) => Promise<ExecuteInstructionResult>;
  executeCoreRoutesInstructionFn?: (params: ExecuteCoreRoutesParams) => Promise<ExecuteCoreRoutesResult>;
  retryImportFn?: (manifestPath: string, log?: ExecuteInstructionParams["log"]) => Promise<RunManifest>;
  retryCoreRouteFn?: (params: Parameters<typeof retryCoreRouteByManifest>[0]) => ReturnType<typeof retryCoreRouteByManifest>;
}

function statusFromManifest(manifest: RunManifest | null): JobStatus {
  if (!manifest) {
    return "failed";
  }
  const summary = summarizeManifest(manifest);
  if (summary.failed === 0) {
    return "success";
  }
  if (summary.imported > 0 || summary.total > 0) {
    return "partial_success";
  }
  return "failed";
}

function statusFromCoreRoutes(manifest: RunManifest | null): JobStatus {
  if (!manifest || !Array.isArray(manifest.routes) || manifest.routes.length === 0) {
    return "failed";
  }
  const successfulRoutes = manifest.routes.filter((route) => route.status === "success").length;
  const failedRoutes = manifest.routes.filter((route) => route.status === "failed").length;
  if (successfulRoutes === 0) {
    return "failed";
  }

  const manifestStatus = statusFromManifest(manifest);
  if (failedRoutes > 0) {
    return "partial_success";
  }
  return manifestStatus;
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

function serializeSse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const repo = options.repo ?? new JobsRepository();
  const queue = options.queue ?? new JobQueue();
  const webDistDir = options.webDistDir ?? path.resolve(process.cwd(), "web/dist");
  const executeInstructionFn = options.executeInstructionFn ?? executeInstruction;
  const executeCoreRoutesInstructionFn =
    options.executeCoreRoutesInstructionFn ?? executeCoreRoutesInstruction;
  const retryImportFn = options.retryImportFn ?? retryImportByManifestPath;
  const retryCoreRouteFn = options.retryCoreRouteFn ?? retryCoreRouteByManifest;

  app.addHook("onClose", async () => {
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
          const finalStatus =
            jobOptions.mode === "core-routes"
              ? statusFromCoreRouteState(result.manifest, repo.listRouteTargets(jobId))
              : statusFromManifest(result.manifest);
          repo.setJobResult({
            jobId,
            status: finalStatus,
            taskJson: JSON.stringify(result.manifest.task),
            manifestPath: result.manifestPath,
            outputDir: result.manifest.outputDir,
            error: finalStatus === "success" ? null : "Some assets failed to import into Eagle",
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
          repo.setJobResult({
            jobId,
            status: "failed",
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

  app.get<{
    Querystring: {
      status?: JobStatus;
      q?: string;
      page?: string;
      pageSize?: string;
    };
  }>("/api/jobs", async (request) => {
    const page = request.query.page ? Number(request.query.page) : 1;
    const pageSize = request.query.pageSize ? Number(request.query.pageSize) : 20;
    const result = repo.listJobs({
      status: request.query.status,
      q: request.query.q,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
    });
    return {
      items: result.items,
      total: result.total,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
    };
  });

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request, reply) => {
    const detail = repo.getJobDetail(request.params.jobId);
    if (!detail) {
      reply.code(404);
      return { error: "Job not found" };
    }

    let manifest = null;
    if (detail.job.manifestPath) {
      try {
        manifest = await readManifest(detail.job.manifestPath);
      } catch {
        manifest = null;
      }
    }

    return {
      ...detail,
      manifest,
      assets: detail.assets.map((asset) => ({
        ...asset,
        previewUrl: `/api/assets/${asset.id}/file`,
      })),
    };
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
          error: finalStatus === "success" ? null : "Some assets still failed to import",
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
          error: finalStatus === "success" ? null : "Some routes or assets are still failing",
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

  return app;
}
