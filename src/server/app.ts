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
import { readManifest } from "../utils/manifest.js";
import type {
  CreateJobRequest,
  JobDetail,
  JobEvent,
  JobExecutionOptions,
  JobStatus,
  RunManifest,
} from "../types.js";
import { JobsRepository } from "./db.js";
import { JobQueue } from "./queue.js";

export interface BuildServerOptions {
  repo?: JobsRepository;
  queue?: JobQueue;
  webDistDir?: string;
  executeInstructionFn?: (params: ExecuteInstructionParams) => Promise<ExecuteInstructionResult>;
  retryImportFn?: (manifestPath: string, log?: ExecuteInstructionParams["log"]) => Promise<RunManifest>;
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
  const retryImportFn = options.retryImportFn ?? retryImportByManifestPath;

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
        emitToQueue(queue, {
          type: "status",
          jobId,
          status: "running",
          at: new Date().toISOString(),
        });

        try {
          const result = await executeInstructionFn({
            instruction,
            options: jobOptions,
            runId: jobId,
            log: (level, message) => {
              repo.addLog(jobId, level, message);
              emitToQueue(queue, {
                type: "log",
                jobId,
                level,
                message,
                at: new Date().toISOString(),
              });
            },
          });

          repo.replaceAssets(jobId, result.manifest);
          const finalStatus = statusFromManifest(result.manifest);
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
        const finalStatus = statusFromManifest(manifest);
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
