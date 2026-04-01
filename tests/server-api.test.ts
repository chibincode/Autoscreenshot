import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server/app.js";
import { createPendingImportResult, normalizeImportResult } from "../src/core/import-state.js";
import { JobsRepository } from "../src/server/db.js";
import { JobQueue } from "../src/server/queue.js";
import type { ExecuteInstructionParams, ExecuteInstructionResult } from "../src/core/job-service.js";
import type { ExecuteCoreRoutesParams, ExecuteCoreRoutesResult } from "../src/core/core-routes-service.js";
import type { PlaywrightRuntimeService, PlaywrightRuntimeState } from "../src/server/playwright-runtime.js";
import type { RunManifest } from "../src/types.js";

async function waitForTerminalStatus(
  app: Awaited<ReturnType<typeof buildServer>>,
  jobId: string,
): Promise<string> {
  for (let i = 0; i < 30; i += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    const data = response.json() as {
      job: {
        status: string;
      };
    };
    if (!["queued", "running"].includes(data.job.status)) {
      return data.job.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Job did not finish in expected time");
}

async function waitForNextTerminalStatus(
  app: Awaited<ReturnType<typeof buildServer>>,
  jobId: string,
  previousStatus: string,
): Promise<string> {
  let sawExecutionRestart = false;

  for (let i = 0; i < 60; i += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    const data = response.json() as {
      job: {
        status: string;
      };
    };
    const status = data.job.status;

    if (status === "queued" || status === "running") {
      sawExecutionRestart = true;
    }

    if (sawExecutionRestart && !["queued", "running"].includes(status)) {
      return status;
    }

    if (!sawExecutionRestart && status !== previousStatus && !["queued", "running"].includes(status)) {
      return status;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Job did not restart and finish in expected time");
}

async function createManualCoreRoutesJob(
  repo: JobsRepository,
  tmpDir: string,
  params: {
    id: string;
    jobStatus: "running" | "partial_success";
    routeStatus: "queued" | "running" | "success" | "failed" | "skipped";
  },
): Promise<{ jobId: string; routeId: number }> {
  const outputDir = path.join(tmpDir, params.id);
  await fs.mkdir(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({ runId: params.id, assets: [], routes: [] }), "utf8");

  repo.createJob({
    id: params.id,
    instruction: "manual core routes test job",
    options: {
      quality: 92,
      dpr: "auto",
      sectionScope: "classic",
      classicMaxSections: 10,
      mode: "core-routes",
      maxRoutes: 8,
      outputDir,
    },
  });
  repo.setJobResult({
    jobId: params.id,
    status: params.jobStatus,
    manifestPath,
    outputDir,
    taskJson: JSON.stringify({
      url: "https://example.com",
      waitUntil: "networkidle",
      captures: [{ mode: "fullPage" }],
      image: { format: "jpg", quality: 92, dpr: 2 },
      viewport: { width: 1920, height: 1080 },
      tags: [],
      eagle: {},
    }),
  });
  repo.replaceRouteTargets(params.id, [
    {
      url: "https://example.com/pricing",
      path: "/pricing",
      title: "Pricing",
      source: "nav",
      depth: 0,
      priorityScore: 900,
    },
  ]);
  repo.updateRouteTargetStatus({
    jobId: params.id,
    url: "https://example.com/pricing",
    status: params.routeStatus,
    error: params.routeStatus === "failed" ? "timeout" : null,
    attemptCount: 1,
    startedAt: new Date().toISOString(),
    finishedAt: params.routeStatus === "failed" || params.routeStatus === "success" ? new Date().toISOString() : null,
  });

  const route = repo.listRouteTargets(params.id)[0];
  if (!route || typeof route.id !== "number") {
    throw new Error("Expected seeded route target");
  }
  return { jobId: params.id, routeId: route.id };
}

describe("server api", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let tmpDir: string;
  let dbPath: string;
  let repo: JobsRepository;
  let queue: JobQueue;
  let playwrightRuntimeState: PlaywrightRuntimeState;
  let repairCalls: number;
  let manifestMap: Map<string, RunManifest>;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-api-"));
    dbPath = path.join(tmpDir, "jobs.db");
    repo = new JobsRepository(dbPath);
    queue = new JobQueue();
    repairCalls = 0;
    manifestMap = new Map<string, RunManifest>();

    const executeInstructionFn = async (
      params: ExecuteInstructionParams,
    ): Promise<ExecuteInstructionResult> => {
      const outputDir = path.join(tmpDir, params.runId ?? "run");
      await fs.mkdir(outputDir, { recursive: true });
      const imagePath = path.join(outputDir, "sample.jpg");
      await fs.writeFile(imagePath, "fake");

      const manifest: RunManifest = {
        runId: params.runId ?? "run",
        instruction: params.instruction,
        createdAt: new Date().toISOString(),
        task: {
          url: "https://example.com",
          waitUntil: "networkidle",
          captures: [{ mode: "fullPage" }],
          image: { format: "jpg", quality: 92, dpr: "auto" },
          viewport: { width: 1440, height: 900 },
          tags: [],
          eagle: {},
        },
        sectionScope: "classic",
        outputDir,
        sectionDebug: {
          scope: "classic",
          viewportHeight: 900,
          rawCandidates: [
            {
              selector: "#hero",
              tagName: "section",
              sectionType: "hero",
              confidence: 0.88,
              bbox: { x: 0, y: 0, width: 1440, height: 600 },
              textPreview: "Welcome to hero",
              scores: {
                hero: 7,
                feature: 1,
                testimonial: 0,
                pricing: 0,
                team: 0,
                faq: 0,
                blog: 0,
                cta: 0,
                contact: 0,
                footer: 0,
                unknown: 0,
              },
              signals: [{ label: "hero", weight: 2, rule: "keyword:hero" }],
            },
          ],
          mergedCandidates: [],
          selectedCandidates: [],
        },
        assets: [
          {
            kind: "fullPage",
            label: "full_page",
            filePath: imagePath,
            fileName: "sample.jpg",
            sourceUrl: "https://example.com",
            quality: 92,
            dpr: 2,
            capturedAt: new Date().toISOString(),
            import: createPendingImportResult(),
          },
        ],
      };

      const manifestPath = path.join(outputDir, "manifest.json");
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      manifestMap.set(manifestPath, manifest);
      return {
        runId: manifest.runId,
        manifestPath,
        manifest,
        fallbackToDpr1: false,
      };
    };

    const importSelectedFn = async (manifestPath: string): Promise<RunManifest> => {
      const existing = manifestMap.get(manifestPath);
      if (!existing) {
        throw new Error("manifest not found");
      }
      const updated: RunManifest = {
        ...existing,
        assets: existing.assets.map((asset) => ({
          ...asset,
          import:
            normalizeImportResult(asset.import).selected &&
            normalizeImportResult(asset.import).status === "pending_confirmation"
              ? {
                  ok: true,
                  selected: true,
                  status: "imported",
                  eagleId: asset.import.eagleId ?? "eagle-item-import-selected",
                }
              : normalizeImportResult(asset.import),
        })),
      };
      await fs.writeFile(manifestPath, JSON.stringify(updated, null, 2), "utf8");
      manifestMap.set(manifestPath, updated);
      return updated;
    };

    const retryImportFn = async (manifestPath: string): Promise<RunManifest> => {
      const existing = manifestMap.get(manifestPath);
      if (!existing) {
        throw new Error("manifest not found");
      }
      const updated: RunManifest = {
        ...existing,
        assets: existing.assets.map((asset) => ({
          ...asset,
          import:
            normalizeImportResult(asset.import).selected &&
            normalizeImportResult(asset.import).status === "failed"
              ? {
                  ok: true,
                  selected: true,
                  status: "imported",
                  eagleId: asset.import.eagleId ?? "eagle-item-retry",
                }
              : normalizeImportResult(asset.import),
        })),
      };
      await fs.writeFile(manifestPath, JSON.stringify(updated, null, 2), "utf8");
      manifestMap.set(manifestPath, updated);
      return updated;
    };

    const executeCoreRoutesInstructionFn = async (
      params: ExecuteCoreRoutesParams,
    ): Promise<ExecuteCoreRoutesResult> => {
      await fs.mkdir(params.outputDir, { recursive: true });
      const routes = [
        {
          url: "https://example.com/",
          path: "/",
          title: "Home",
          source: "nav" as const,
          depth: 0,
          priorityScore: 1000,
        },
        {
          url: "https://example.com/pricing",
          path: "/pricing",
          title: "Pricing",
          source: "nav" as const,
          depth: 0,
          priorityScore: 900,
        },
      ];
      await params.onRoutesDiscovered?.(routes);
      await params.onRouteStatus?.({
        route: routes[0],
        status: "running",
        attemptCount: 1,
        startedAt: new Date().toISOString(),
      });
      await params.onRouteStatus?.({
        route: routes[0],
        status: "success",
        attemptCount: 1,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      await params.onRouteStatus?.({
        route: routes[1],
        status: "running",
        attemptCount: 1,
        startedAt: new Date().toISOString(),
      });
      await params.onRouteStatus?.({
        route: routes[1],
        status: "failed",
        attemptCount: 1,
        error: "timeout",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const imagePath = path.join(params.outputDir, "core-home.jpg");
      await fs.writeFile(imagePath, "fake");

      const manifest: RunManifest = {
        runId: params.runId,
        instruction: params.instruction,
        createdAt: new Date().toISOString(),
        task: {
          url: "https://example.com",
          waitUntil: "networkidle",
          captures: [{ mode: "fullPage" }],
          image: { format: "jpg", quality: 92, dpr: 2 },
          viewport: { width: 1920, height: 1080 },
          tags: [],
          eagle: {},
        },
        sectionScope: "classic",
        outputDir: params.outputDir,
        routes: [
          {
            url: routes[0].url,
            path: routes[0].path,
            title: routes[0].title ?? null,
            source: routes[0].source,
            depth: routes[0].depth,
            priorityScore: routes[0].priorityScore,
            status: "success",
            error: null,
            attemptCount: 1,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            assetCount: 1,
            lastExecutedAt: new Date().toISOString(),
          },
          {
            url: routes[1].url,
            path: routes[1].path,
            title: routes[1].title ?? null,
            source: routes[1].source,
            depth: routes[1].depth,
            priorityScore: routes[1].priorityScore,
            status: "failed",
            error: "timeout",
            attemptCount: 1,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            assetCount: 0,
            lastExecutedAt: new Date().toISOString(),
          },
        ],
        assets: [
          {
            kind: "fullPage",
            label: "full_page",
            filePath: imagePath,
            fileName: "core-home.jpg",
            sourceUrl: "https://example.com/",
            quality: 92,
            dpr: 2,
            capturedAt: new Date().toISOString(),
            import: createPendingImportResult(),
          },
        ],
      };

      await fs.writeFile(params.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      manifestMap.set(params.manifestPath, manifest);

      return {
        runId: params.runId,
        manifestPath: params.manifestPath,
        manifest,
        routes: manifest.routes ?? [],
        fallbackRoutes: 0,
        cancelled: false,
      };
    };

    const retryCoreRouteFn = async (params: {
      manifestPath: string;
      routeUrl: string;
      routePath: string;
      routeTitle?: string | null;
      routeSource: "nav" | "link";
      routeDepth: number;
      routePriorityScore: number;
      routeAttemptCount: number;
      log?: (level: "info" | "warn" | "error", message: string) => void;
    }) => {
      const existing = manifestMap.get(params.manifestPath);
      if (!existing) {
        throw new Error("manifest not found");
      }

      const routeImage = path.join(existing.outputDir, `retry-${params.routePath.replace(/\W+/g, "_")}.jpg`);
      await fs.writeFile(routeImage, "fake");
      const next: RunManifest = {
        ...existing,
        assets: [
          ...existing.assets.filter((asset) => asset.sourceUrl !== params.routeUrl),
          {
            kind: "fullPage",
            label: "full_page",
            filePath: routeImage,
            fileName: path.basename(routeImage),
            sourceUrl: params.routeUrl,
            quality: 92,
            dpr: 2,
            capturedAt: new Date().toISOString(),
            import: createPendingImportResult(),
          },
        ],
      };
      await fs.writeFile(params.manifestPath, JSON.stringify(next, null, 2), "utf8");
      manifestMap.set(params.manifestPath, next);

      return {
        manifest: next,
        route: {
          url: params.routeUrl,
          path: params.routePath,
          title: params.routeTitle ?? null,
          source: params.routeSource,
          depth: params.routeDepth,
          priorityScore: params.routePriorityScore,
          status: "success" as const,
          error: null,
          attemptCount: params.routeAttemptCount + 1,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          assetCount: 1,
          lastExecutedAt: new Date().toISOString(),
        },
        fallbackToDpr1: false,
      };
    };

    playwrightRuntimeState = {
      healthy: true,
      needsRepair: false,
      repairing: false,
      status: "healthy",
      target: "chromium",
      message: "Chromium 截图运行环境正常",
      lastCheckedAt: new Date().toISOString(),
    };

    const playwrightRuntimeService: PlaywrightRuntimeService = {
      async check() {
        return playwrightRuntimeState;
      },
      async repair() {
        repairCalls += 1;
        playwrightRuntimeState = {
          healthy: true,
          needsRepair: false,
          repairing: false,
          status: "healthy",
          target: "chromium",
          message: "Chromium 截图运行环境正常",
          lastCheckedAt: new Date().toISOString(),
        };
        return playwrightRuntimeState;
      },
    };

    app = await buildServer({
      repo,
      queue,
      webDistDir: path.join(tmpDir, "no-ui"),
      playwrightRuntimeService,
      executeInstructionFn,
      executeCoreRoutesInstructionFn,
      importSelectedFn,
      retryImportFn,
      retryCoreRouteFn,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns config with eagle import policy summary", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/config",
    });
    expect(response.statusCode).toBe(200);
    const data = response.json() as {
      defaults: {
        classicMaxSections: number;
        mode: string;
        maxRoutes: number;
      };
      eagleImportPolicy?: {
        allowCreateFolder: boolean;
        mappingSource: string;
        fallback: string;
      };
    };
    expect(data.defaults.classicMaxSections).toBe(10);
    expect(data.defaults.mode).toBe("single");
    expect(data.defaults.maxRoutes).toBe(12);
    expect(data.eagleImportPolicy).toBeDefined();
    expect(data.eagleImportPolicy?.allowCreateFolder).toBe(false);
    expect(data.eagleImportPolicy?.mappingSource).toContain("data/eagle-folder-rules.json");
    expect(data.eagleImportPolicy?.fallback).toBe("root");
  });

  it("returns playwright runtime health", async () => {
    playwrightRuntimeState = {
      healthy: false,
      needsRepair: true,
      repairing: false,
      status: "needs_repair",
      target: "chromium",
      message: "Chromium 截图浏览器缺失，已提交任务会直接失败，请先修复。",
      detail: "headless shell missing",
      lastCheckedAt: new Date().toISOString(),
    };

    const response = await app.inject({
      method: "GET",
      url: "/api/runtime/playwright",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      healthy: false,
      needsRepair: true,
      target: "chromium",
      detail: "headless shell missing",
    });
  });

  it("repairs playwright runtime through api", async () => {
    repairCalls = 0;
    playwrightRuntimeState = {
      healthy: false,
      needsRepair: true,
      repairing: false,
      status: "needs_repair",
      target: "chromium",
      message: "Chromium 截图浏览器缺失，已提交任务会直接失败，请先修复。",
      lastCheckedAt: new Date().toISOString(),
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/runtime/playwright/repair",
    });

    expect(response.statusCode).toBe(200);
    expect(repairCalls).toBe(1);
    expect(response.json()).toMatchObject({
      healthy: true,
      needsRepair: false,
      target: "chromium",
    });
  });

  it("creates a job and returns detail", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/folder/list")) {
        return new Response(
          JSON.stringify({
            status: "success",
            data: [
              {
                id: "pages-root",
                name: "Pages",
                children: [
                  {
                    id: "JZR6J2FS0KW4W",
                    name: "Page_Home",
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        instruction: "open https://example.com and capture",
        classicMaxSections: 8,
      },
    });

    expect(createResponse.statusCode).toBe(202);
    const createData = createResponse.json() as { jobId: string };
    expect(createData.jobId).toBeTruthy();

    const finalStatus = await waitForTerminalStatus(app, createData.jobId);
    expect(finalStatus).toBe("awaiting_confirmation");

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/jobs?page=1&pageSize=10",
    });
    expect(listResponse.statusCode).toBe(200);
    const listData = listResponse.json() as {
      items: Array<{ id: string; pendingConfirmationCount: number; importSuccessCount: number }>;
    };
    const listedJob = listData.items.find((job) => job.id === createData.jobId);
    expect(listedJob).toBeDefined();
    expect(listedJob?.pendingConfirmationCount).toBe(1);
    expect(listedJob?.importSuccessCount).toBe(0);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/${createData.jobId}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detailData = detailResponse.json() as {
      assets: Array<{
        previewUrl: string;
        eagleFolderId: string | null;
        eagleFolderPath: string | null;
        pageTitle?: string;
        selectedForImport: boolean;
        importStatus: string;
      }>;
      logs: Array<{ message: string }>;
      manifest: {
        sectionDebug?: {
          rawCandidates: unknown[];
        };
      };
    };
    expect(detailData.assets.length).toBeGreaterThan(0);
    expect(detailData.assets[0].previewUrl).toContain("/api/assets/");
    expect(detailData.assets[0].eagleFolderId).toBe("JZR6J2FS0KW4W");
    expect(detailData.assets[0].eagleFolderPath).toBe("Pages/Page_Home");
    expect(detailData.assets[0].selectedForImport).toBe(true);
    expect(detailData.assets[0].importStatus).toBe("pending_confirmation");
    expect(detailData.logs.length).toBeGreaterThan(0);
    expect(detailData.manifest.sectionDebug?.rawCandidates.length).toBe(1);
  });

  it("keeps the parsed URL visible in job list when capture fails before assets are saved", async () => {
    const isolatedTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-api-failed-url-"));
    const isolatedDbPath = path.join(isolatedTmpDir, "jobs.db");
    const isolatedRepo = new JobsRepository(isolatedDbPath);
    const isolatedQueue = new JobQueue();
    const failingApp = await buildServer({
      repo: isolatedRepo,
      queue: isolatedQueue,
      webDistDir: path.join(isolatedTmpDir, "no-ui"),
      executeInstructionFn: async () => {
        throw new Error('page.goto: Timeout 60000ms exceeded. waiting until "networkidle"');
      },
      executeCoreRoutesInstructionFn: async () => {
        throw new Error("core-routes should not run in this test");
      },
      importSelectedFn: async () => {
        throw new Error("import-selected should not run in this test");
      },
      retryImportFn: async () => {
        throw new Error("retry-import should not run in this test");
      },
      retryCoreRouteFn: async () => {
        throw new Error("retry-route should not run in this test");
      },
    });
    await failingApp.ready();

    try {
      const createResponse = await failingApp.inject({
        method: "POST",
        url: "/api/jobs",
        payload: {
          instruction: "https://www.soci.ai/",
        },
      });

      expect(createResponse.statusCode).toBe(202);
      const createData = createResponse.json() as { jobId: string };
      const finalStatus = await waitForTerminalStatus(failingApp, createData.jobId);
      expect(finalStatus).toBe("failed");

      const listResponse = await failingApp.inject({
        method: "GET",
        url: "/api/jobs?page=1&pageSize=10",
      });
      expect(listResponse.statusCode).toBe(200);
      const listData = listResponse.json() as {
        items: Array<{ id: string; sourceUrl: string | null }>;
      };
      expect(listData.items.find((job) => job.id === createData.jobId)?.sourceUrl).toBe("https://www.soci.ai/");
    } finally {
      await failingApp.close();
      isolatedRepo.close();
      await fs.rm(isolatedTmpDir, { recursive: true, force: true });
    }
  });

  it("creates a core-routes job and retries one route", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        instruction: "open https://example.com and map core routes",
        mode: "core-routes",
        maxRoutes: 8,
      },
    });

    expect(createResponse.statusCode).toBe(202);
    const createData = createResponse.json() as { jobId: string };
    const finalStatus = await waitForTerminalStatus(app, createData.jobId);
    expect(finalStatus).toBe("partial_success");

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/${createData.jobId}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detailData = detailResponse.json() as {
      routes: Array<{ id: number; status: string; path: string }>;
    };
    expect(detailData.routes.length).toBeGreaterThan(0);
    const failedRoute = detailData.routes.find((route) => route.status === "failed");
    expect(failedRoute).toBeDefined();

    const retryResponse = await app.inject({
      method: "POST",
      url: `/api/jobs/${createData.jobId}/retry-route`,
      payload: {
        routeId: failedRoute!.id,
      },
    });
    expect(retryResponse.statusCode).toBe(202);

    const retriedStatus = await waitForNextTerminalStatus(app, createData.jobId, finalStatus);
    expect(retriedStatus).toBe("awaiting_confirmation");
  });

  it("shows general Eagle folders for unmatched page and unknown section assets", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/folder/list")) {
        return new Response(
          JSON.stringify({
            status: "success",
            data: [
              {
                id: "pages-root",
                name: "Pages",
                children: [
                  {
                    id: "page-general-id",
                    name: "Page_Gerneral",
                  },
                ],
              },
              {
                id: "sections-root",
                name: "Sections",
                children: [
                  {
                    id: "section-general-id",
                    name: "Section_Gerneral",
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const jobId = "general-folder-job";
    const outputDir = path.join(tmpDir, jobId);
    await fs.mkdir(outputDir, { recursive: true });
    const unmatchedFullPath = path.join(outputDir, "unmatched-full.jpg");
    const unknownSectionPath = path.join(outputDir, "unknown-section.jpg");
    await fs.writeFile(unmatchedFullPath, "fake");
    await fs.writeFile(unknownSectionPath, "fake");

    const manifest: RunManifest = {
      runId: jobId,
      instruction: "manual general fallback test",
      createdAt: new Date().toISOString(),
      task: {
        url: "https://example.com/platform/edge-ai",
        waitUntil: "networkidle",
        captures: [{ mode: "fullPage" }, { mode: "section" }],
        image: { format: "jpg", quality: 92, dpr: 2 },
        viewport: { width: 1920, height: 1080 },
        tags: [],
        eagle: {},
      },
      sectionScope: "classic",
      outputDir,
      assets: [
        {
          kind: "fullPage",
          label: "full_page",
          filePath: unmatchedFullPath,
          fileName: "unmatched-full.jpg",
          sourceUrl: "https://example.com/platform/edge-ai",
          quality: 92,
          dpr: 2,
          capturedAt: new Date().toISOString(),
          import: {
            ok: true,
            selected: true,
            status: "imported",
            eagleId: "eagle-general-page",
          },
        },
        {
          kind: "section",
          sectionType: "unknown",
          label: "section",
          filePath: unknownSectionPath,
          fileName: "unknown-section.jpg",
          sourceUrl: "https://example.com/platform/edge-ai",
          quality: 92,
          dpr: 2,
          capturedAt: new Date().toISOString(),
          import: {
            ok: true,
            selected: true,
            status: "imported",
            eagleId: "eagle-general-section",
          },
        },
      ],
    };
    const manifestPath = path.join(outputDir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    repo.createJob({
      id: jobId,
      instruction: manifest.instruction,
      options: {
        quality: 92,
        dpr: 2,
        sectionScope: "classic",
        classicMaxSections: 10,
        mode: "single",
        maxRoutes: 12,
        outputDir,
      },
    });
    repo.setJobResult({
      jobId,
      status: "success",
      manifestPath,
      outputDir,
      taskJson: JSON.stringify(manifest.task),
    });
    repo.replaceAssets(jobId, manifest);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });

    expect(detailResponse.statusCode).toBe(200);
    const detailData = detailResponse.json() as {
      assets: Array<{
        kind: "fullPage" | "section";
        eagleFolderId: string | null;
        eagleFolderPath: string | null;
      }>;
    };
    const fullPageAsset = detailData.assets.find((asset) => asset.kind === "fullPage");
    const sectionAsset = detailData.assets.find((asset) => asset.kind === "section");

    expect(fullPageAsset?.eagleFolderId).toBe("page-general-id");
    expect(fullPageAsset?.eagleFolderPath).toBe("Pages/Page_Gerneral");
    expect(sectionAsset?.eagleFolderId).toBe("section-general-id");
    expect(sectionAsset?.eagleFolderPath).toBe("Sections/Section_Gerneral");
  });

  it("archives finished jobs and hides them from the default queue list", async () => {
    const jobId = "archivable-job";
    const activeJobId = "still-visible-job";
    const outputDir = path.join(tmpDir, jobId);
    await fs.mkdir(outputDir, { recursive: true });
    const manifestPath = path.join(outputDir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify({ runId: jobId, assets: [] }), "utf8");

    repo.createJob({
      id: jobId,
      instruction: "archive me",
      options: {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
        classicMaxSections: 10,
        mode: "single",
        maxRoutes: 12,
        outputDir,
      },
    });
    repo.setJobResult({
      jobId,
      status: "success",
      manifestPath,
      outputDir,
      taskJson: JSON.stringify({
        url: "https://example.com",
        waitUntil: "networkidle",
        captures: [{ mode: "fullPage" }],
        image: { format: "jpg", quality: 92, dpr: 2 },
        viewport: { width: 1920, height: 1080 },
        tags: [],
        eagle: {},
      }),
    });
    repo.createJob({
      id: activeJobId,
      instruction: "still visible",
      options: {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
        classicMaxSections: 10,
        mode: "single",
        maxRoutes: 12,
        outputDir: path.join(tmpDir, activeJobId),
      },
    });

    const archiveResponse = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/archive`,
      payload: {
        archived: true,
      },
    });

    expect(archiveResponse.statusCode).toBe(200);
    const archiveData = archiveResponse.json() as { archivedAt: string | null };
    expect(archiveData.archivedAt).toBeTruthy();

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/jobs?page=1&pageSize=20",
    });
    const listData = listResponse.json() as { items: Array<{ id: string }> };
    expect(listData.items.some((job) => job.id === jobId)).toBe(false);

    const archivedListResponse = await app.inject({
      method: "GET",
      url: "/api/jobs?page=1&pageSize=20&archivedOnly=true",
    });
    const archivedListData = archivedListResponse.json() as {
      items: Array<{ id: string; archivedAt: string | null }>;
    };
    expect(archivedListData.items.find((job) => job.id === jobId)?.archivedAt).toBeTruthy();
    expect(archivedListData.items.some((job) => job.id === activeJobId)).toBe(false);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    const detailData = detailResponse.json() as { job: { archivedAt: string | null } };
    expect(detailData.job.archivedAt).toBeTruthy();

    const unarchiveResponse = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/archive`,
      payload: {
        archived: false,
      },
    });
    expect(unarchiveResponse.statusCode).toBe(200);
    expect(repo.getJob(jobId)?.archivedAt).toBeNull();
  });

  it("rejects archiving running jobs", async () => {
    repo.createJob({
      id: "running-archive-job",
      instruction: "running job",
      options: {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
        classicMaxSections: 10,
        mode: "single",
        maxRoutes: 12,
        outputDir: path.join(tmpDir, "running-archive-job"),
      },
    });
    repo.setJobRunning("running-archive-job");

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/running-archive-job/archive",
      payload: {
        archived: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "archive is only available for finished jobs",
    });
  });

  it("rejects retry-route while the core-routes job is still running", async () => {
    const seeded = await createManualCoreRoutesJob(repo, tmpDir, {
      id: "manual-running-job",
      jobStatus: "running",
      routeStatus: "failed",
    });

    const retryResponse = await app.inject({
      method: "POST",
      url: `/api/jobs/${seeded.jobId}/retry-route`,
      payload: {
        routeId: seeded.routeId,
      },
    });

    expect(retryResponse.statusCode).toBe(400);
    expect(retryResponse.json()).toEqual({
      error: "retry-route is only available after the core-routes job has finished",
    });
  });

  it("rejects retry-route for routes that are not failed", async () => {
    const seeded = await createManualCoreRoutesJob(repo, tmpDir, {
      id: "manual-success-job",
      jobStatus: "partial_success",
      routeStatus: "success",
    });

    const retryResponse = await app.inject({
      method: "POST",
      url: `/api/jobs/${seeded.jobId}/retry-route`,
      payload: {
        routeId: seeded.routeId,
      },
    });

    expect(retryResponse.statusCode).toBe(400);
    expect(retryResponse.json()).toEqual({
      error: "retry-route is only available for failed routes",
    });
  });

  it("cancels a queued job before execution", async () => {
    let releaseRunningJob = () => {
      // no-op until promise initializer runs
    };
    const runningJobDone = new Promise<void>((resolve) => {
      releaseRunningJob = resolve;
    });

    repo.createJob({
      id: "running-job",
      instruction: "running job",
      options: {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
        classicMaxSections: 10,
        mode: "single",
        maxRoutes: 12,
        outputDir: path.join(tmpDir, "running-job"),
      },
    });
    repo.setJobRunning("running-job");
    queue.enqueue("running-job", async () => {
      await runningJobDone;
    });

    repo.createJob({
      id: "queued-job",
      instruction: "queued job",
      options: {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
        classicMaxSections: 10,
        mode: "single",
        maxRoutes: 12,
        outputDir: path.join(tmpDir, "queued-job"),
      },
    });
    queue.enqueue("queued-job", async () => {
      throw new Error("queued job should have been cancelled before execution");
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const cancelResponse = await app.inject({
      method: "POST",
      url: "/api/jobs/queued-job/cancel",
    });

    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json()).toEqual({
      jobId: "queued-job",
      status: "cancelled",
    });
    expect(repo.getJob("queued-job")?.status).toBe("cancelled");

    releaseRunningJob();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  it("requests cancellation for a running core-routes job", async () => {
    repo.createJob({
      id: "running-core-job",
      instruction: "running core-routes job",
      options: {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
        classicMaxSections: 10,
        mode: "core-routes",
        maxRoutes: 8,
        outputDir: path.join(tmpDir, "running-core-job"),
      },
    });
    repo.setJobRunning("running-core-job");

    let releaseRunningJob = () => {
      // no-op until promise initializer runs
    };
    const runningJobDone = new Promise<void>((resolve) => {
      releaseRunningJob = resolve;
    });

    queue.enqueue("running-core-job", async () => {
      await runningJobDone;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const cancelResponse = await app.inject({
      method: "POST",
      url: "/api/jobs/running-core-job/cancel",
    });

    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json()).toEqual({
      jobId: "running-core-job",
      status: "running",
      cancellationRequested: true,
    });
    expect(queue.isCancellationRequested("running-core-job")).toBe(true);

    releaseRunningJob();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  it("cancels an orphaned running core-routes job after queue recovery mismatch", async () => {
    const seeded = await createManualCoreRoutesJob(repo, tmpDir, {
      id: "orphan-running-job",
      jobStatus: "running",
      routeStatus: "running",
    });

    const cancelResponse = await app.inject({
      method: "POST",
      url: `/api/jobs/${seeded.jobId}/cancel`,
    });

    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json()).toEqual({
      jobId: seeded.jobId,
      status: "cancelled",
      recovered: true,
    });

    expect(repo.getJob(seeded.jobId)?.status).toBe("cancelled");
    const route = repo.listRouteTargets(seeded.jobId)[0];
    expect(route?.status).toBe("skipped");
    expect(route?.error).toBe("Cancelled by user");
  });

  it("saves full asset selection and updates job summary counts", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        instruction: "open https://example.com and capture",
      },
    });
    const jobId = (createResponse.json() as { jobId: string }).jobId;
    await waitForTerminalStatus(app, jobId);

    const detailBefore = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    const detailBeforeData = detailBefore.json() as {
      assets: Array<{ id: number; selectedForImport: boolean }>;
    };
    expect(detailBeforeData.assets).toHaveLength(1);
    expect(detailBeforeData.assets[0].selectedForImport).toBe(true);

    const selectionResponse = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/assets/selection`,
      payload: {
        selectedAssetIds: [],
      },
    });
    expect(selectionResponse.statusCode).toBe(200);

    const detailAfter = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    const detailAfterData = detailAfter.json() as {
      job: { status: string };
      assets: Array<{ selectedForImport: boolean; importStatus: string }>;
    };
    expect(detailAfterData.job.status).toBe("awaiting_confirmation");
    expect(detailAfterData.assets[0].selectedForImport).toBe(false);
    expect(detailAfterData.assets[0].importStatus).toBe("pending_confirmation");

    const listAfter = await app.inject({
      method: "GET",
      url: "/api/jobs?page=1&pageSize=20",
    });
    const listAfterData = listAfter.json() as {
      items: Array<{ id: string; pendingConfirmationCount: number }>;
    };
    const updatedJob = listAfterData.items.find((job) => job.id === jobId);
    expect(updatedJob?.pendingConfirmationCount).toBe(1);
  });

  it("imports only selected pending assets", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        instruction: "open https://example.com and capture",
      },
    });
    const jobId = (createResponse.json() as { jobId: string }).jobId;
    await waitForTerminalStatus(app, jobId);

    const importResponse = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/import-selected`,
    });
    expect(importResponse.statusCode).toBe(202);

    const finalStatus = await waitForNextTerminalStatus(app, jobId, "awaiting_confirmation");
    expect(finalStatus).toBe("success");

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    const detailData = detailResponse.json() as {
      assets: Array<{ importStatus: string; eagleId: string | null }>;
    };
    expect(detailData.assets[0].importStatus).toBe("imported");
    expect(detailData.assets[0].eagleId).toBe("eagle-item-import-selected");
  });

  it("retries only selected failed assets", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        instruction: "open https://example.com and capture",
      },
    });
    const jobId = (createResponse.json() as { jobId: string }).jobId;
    await waitForTerminalStatus(app, jobId);

    const job = repo.getJob(jobId);
    if (!job?.manifestPath) {
      throw new Error("Expected manifest path for seeded job");
    }

    const manifest = JSON.parse(await fs.readFile(job.manifestPath, "utf8")) as RunManifest;
    const failedManifest: RunManifest = {
      ...manifest,
      assets: manifest.assets.map((asset) => ({
        ...asset,
        import: {
          ok: false,
          selected: true,
          status: "failed",
          error: "seeded failure",
        },
      })),
    };
    await fs.writeFile(job.manifestPath, JSON.stringify(failedManifest, null, 2), "utf8");
    manifestMap.set(job.manifestPath, failedManifest);
    repo.replaceAssets(jobId, failedManifest);
    repo.setJobResult({
      jobId,
      status: "partial_success",
      taskJson: JSON.stringify(failedManifest.task),
      manifestPath: job.manifestPath,
      outputDir: failedManifest.outputDir,
      error: "Some assets still require attention",
    });

    const retryResponse = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/retry-import`,
    });
    expect(retryResponse.statusCode).toBe(202);

    const finalStatus = await waitForNextTerminalStatus(app, jobId, "partial_success");
    expect(finalStatus).toBe("success");

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    const detailData = detailResponse.json() as {
      assets: Array<{ importStatus: string; eagleId: string | null }>;
    };
    expect(detailData.assets[0].importStatus).toBe("imported");
    expect(detailData.assets[0].eagleId).toBe("eagle-item-retry");
  });
});
