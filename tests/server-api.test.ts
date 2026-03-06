import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server/app.js";
import { JobsRepository } from "../src/server/db.js";
import { JobQueue } from "../src/server/queue.js";
import type { ExecuteInstructionParams, ExecuteInstructionResult } from "../src/core/job-service.js";
import type { ExecuteCoreRoutesParams, ExecuteCoreRoutesResult } from "../src/core/core-routes-service.js";
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

describe("server api", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let tmpDir: string;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-api-"));
    dbPath = path.join(tmpDir, "jobs.db");
    const repo = new JobsRepository(dbPath);
    const queue = new JobQueue();
    const manifestMap = new Map<string, RunManifest>();

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
            import: {
              ok: true,
              eagleId: "eagle-item-1",
            },
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

    const retryImportFn = async (manifestPath: string): Promise<RunManifest> => {
      const existing = manifestMap.get(manifestPath);
      if (!existing) {
        throw new Error("manifest not found");
      }
      const updated: RunManifest = {
        ...existing,
        assets: existing.assets.map((asset) => ({
          ...asset,
          import: {
            ok: true,
            eagleId: asset.import.eagleId ?? "eagle-item-retry",
          },
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
            import: {
              ok: true,
              eagleId: "eagle-core-1",
            },
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

      const routeImage = path.join(existing.outputDir, `retry-${params.routePath.replace(/\\W+/g, "_")}.jpg`);
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
            import: {
              ok: true,
              eagleId: "eagle-core-retry",
            },
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

    app = await buildServer({
      repo,
      queue,
      webDistDir: path.join(tmpDir, "no-ui"),
      executeInstructionFn,
      executeCoreRoutesInstructionFn,
      retryImportFn,
      retryCoreRouteFn,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
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

  it("creates a job and returns detail", async () => {
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
    expect(["success", "partial_success"]).toContain(finalStatus);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/jobs?page=1&pageSize=10",
    });
    expect(listResponse.statusCode).toBe(200);
    const listData = listResponse.json() as { items: Array<{ id: string }> };
    expect(listData.items.some((job) => job.id === createData.jobId)).toBe(true);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/${createData.jobId}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detailData = detailResponse.json() as {
      assets: Array<{ previewUrl: string }>;
      logs: Array<{ message: string }>;
      manifest: {
        sectionDebug?: {
          rawCandidates: unknown[];
        };
      };
    };
    expect(detailData.assets.length).toBeGreaterThan(0);
    expect(detailData.assets[0].previewUrl).toContain("/api/assets/");
    expect(detailData.logs.length).toBeGreaterThan(0);
    expect(detailData.manifest.sectionDebug?.rawCandidates.length).toBe(1);
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

    const retriedStatus = await waitForTerminalStatus(app, createData.jobId);
    expect(["success", "partial_success"]).toContain(retriedStatus);
  });

  it("queues retry import", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        instruction: "open https://example.com and capture",
      },
    });
    const jobId = (createResponse.json() as { jobId: string }).jobId;
    await waitForTerminalStatus(app, jobId);

    const retryResponse = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/retry-import`,
    });
    expect(retryResponse.statusCode).toBe(202);

    const finalStatus = await waitForTerminalStatus(app, jobId);
    expect(["success", "partial_success"]).toContain(finalStatus);
  });
});
