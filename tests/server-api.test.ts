import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server/app.js";
import { createPendingImportResult, normalizeImportResult } from "../src/core/import-state.js";
import { getAssetCropManifestPath } from "../src/server/asset-crop.js";
import { JobsRepository } from "../src/server/db.js";
import { JobQueue } from "../src/server/queue.js";
import type { ExecuteInstructionParams, ExecuteInstructionResult } from "../src/core/job-service.js";
import type { ExecuteCoreRoutesParams, ExecuteCoreRoutesResult } from "../src/core/core-routes-service.js";
import type { PlaywrightRuntimeService, PlaywrightRuntimeState } from "../src/server/playwright-runtime.js";
import type { RunManifest } from "../src/types.js";

async function writeTestJpeg(filePath: string, width = 1280, height = 720): Promise<void> {
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 246, g: 247, b: 250 },
    },
  })
    .jpeg({ quality: 82 })
    .toFile(filePath);
}

async function writeThreeBandTestJpeg(filePath: string): Promise<void> {
  const width = 100;
  const height = 300;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const color = y < 100 ? [255, 0, 0] : y < 200 ? [0, 255, 0] : [0, 0, 255];
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
    }
  }
  await sharp(pixels, {
    raw: {
      width,
      height,
      channels: 3,
    },
  })
    .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
    .toFile(filePath);
}

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

const DEFAULT_EAGLE_FOLDER_TREE = [
  {
    id: "pages-root",
    name: "Pages",
    children: [
      {
        id: "JZR6J2FS0KW4W",
        name: "Page_Home",
      },
      {
        id: "page-pricing-id",
        name: "Page_Pricing",
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
];

function mockEagleFolderList(folderTree = DEFAULT_EAGLE_FOLDER_TREE): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/api/folder/list")) {
      return new Response(
        JSON.stringify({
          status: "success",
          data: folderTree,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
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
      await writeTestJpeg(imagePath, 1440, 900);

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
                security: 0,
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
      const existing = JSON.parse(await fs.readFile(manifestPath, "utf8")) as RunManifest;
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
      const existing = JSON.parse(await fs.readFile(manifestPath, "utf8")) as RunManifest;
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
      await writeTestJpeg(imagePath, 1920, 2560);

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
      await writeTestJpeg(routeImage, 1600, 2400);
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
    expect(data.defaults.mode).toBe("core-routes");
    expect(data.defaults.maxRoutes).toBe(12);
    expect(data.eagleImportPolicy).toBeDefined();
    expect(data.eagleImportPolicy?.allowCreateFolder).toBe(false);
    expect(data.eagleImportPolicy?.mappingSource).toContain("data/eagle-folder-rules.json");
    expect(data.eagleImportPolicy?.fallback).toBe("root");
  });

  it("returns plugin context with history and Eagle duplicate hits", async () => {
    repo.createJob({
      id: "plugin-hit-job",
      instruction: "open https://www.example.com/en/pricing?ref=promo#hero",
      options: {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
        classicMaxSections: 10,
        mode: "single",
        maxRoutes: 12,
        outputDir: "./output",
      },
    });
    repo.replaceAssets("plugin-hit-job", {
      runId: "plugin-hit-job",
      instruction: "open https://www.example.com/en/pricing?ref=promo#hero",
      createdAt: "2026-04-13T12:00:00.000Z",
      task: {
        url: "https://www.example.com/en/pricing?ref=promo#hero",
        waitUntil: "networkidle",
        captures: [{ mode: "fullPage" }],
        image: { format: "jpg", quality: 92, dpr: "auto" },
        viewport: { width: 1920, height: 1080 },
        tags: [],
        eagle: {},
      },
      sectionScope: "classic",
      outputDir: "./output/plugin-hit-job",
      assets: [
        {
          kind: "fullPage",
          label: "Pricing",
          filePath: "/tmp/plugin-hit-job.jpg",
          fileName: "plugin-hit-job.jpg",
          sourceUrl: "https://www.example.com/en/pricing?ref=promo#hero",
          quality: 92,
          dpr: 2,
          capturedAt: "2026-04-13T12:00:00.000Z",
          import: { ok: true, selected: true, status: "imported", eagleId: "eagle-item-1" },
        },
      ],
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/library/info")) {
        return new Response(JSON.stringify({ status: "success", data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/item/list?")) {
        return new Response(
          JSON.stringify({
            status: "success",
            data: [
              {
                id: "eagle-item-1",
                name: "Example Pricing",
                url: "https://example.com/pricing#pricing",
                mtime: 1776062400000,
              },
              {
                id: "eagle-item-2",
                name: "Ignore About",
                url: "https://example.com/about",
                mtime: 1776061400000,
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

    const response = await app.inject({
      method: "GET",
      url: "/api/plugin/context?url=https://example.com/pricing",
    });

    expect(response.statusCode).toBe(200);
    const data = response.json() as RunManifest & {
      normalizedUrl: string;
      history: { hitCount: number; recentJobs: Array<{ id: string }> };
      eagle: {
        available: boolean;
        hitCount: number;
        recentItems: Array<{ id: string; clickable: boolean; jobId?: string; assetId?: number }>;
      };
      runtime: { serverHealthy: boolean; eagleHealthy: boolean; playwrightHealthy: boolean };
    };
    expect(data.normalizedUrl).toBe("https://example.com/pricing");
    expect(data.history.hitCount).toBe(1);
    expect(data.history.recentJobs[0]?.id).toBe("plugin-hit-job");
    expect(data.eagle.available).toBe(true);
    expect(data.eagle.hitCount).toBe(1);
    expect(data.eagle.recentItems[0]?.id).toBe("eagle-item-1");
    expect(data.eagle.recentItems[0]?.clickable).toBe(true);
    expect(data.eagle.recentItems[0]?.jobId).toBe("plugin-hit-job");
    expect(typeof data.eagle.recentItems[0]?.assetId).toBe("number");
    expect(data.runtime.serverHealthy).toBe(true);
    expect(data.runtime.playwrightHealthy).toBe(true);
    expect(data.runtime.eagleHealthy).toBe(true);
  });

  it("marks unmatched Eagle hits as non-clickable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/library/info")) {
        return new Response(JSON.stringify({ status: "success", data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/item/list?")) {
        return new Response(
          JSON.stringify({
            status: "success",
            data: [
              {
                id: "orphan-eagle-item",
                name: "Orphan item",
                url: "https://example.com/pricing",
                mtime: 1776062400000,
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

    const response = await app.inject({
      method: "GET",
      url: "/api/plugin/context?url=https://example.com/pricing",
    });

    expect(response.statusCode).toBe(200);
    const data = response.json() as {
      eagle: { recentItems: Array<{ id: string; clickable: boolean; jobId?: string; assetId?: number }> };
    };
    expect(data.eagle.recentItems[0]).toMatchObject({
      id: "orphan-eagle-item",
      clickable: false,
    });
    expect(data.eagle.recentItems[0]?.jobId).toBeUndefined();
    expect(data.eagle.recentItems[0]?.assetId).toBeUndefined();
  });

  it("finds Eagle hits when only the www variant is returned by Eagle search", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/library/info")) {
        return new Response(JSON.stringify({ status: "success", data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/item/list?")) {
        const parsedUrl = new URL(url);
        const candidateUrl = parsedUrl.searchParams.get("url");
        return new Response(
          JSON.stringify({
            status: "success",
            data:
              candidateUrl === "https://www.example.com/pricing"
                ? [
                    {
                      id: "eagle-item-www-only",
                      name: "Pricing Page",
                      url: "https://www.example.com/pricing",
                      mtime: 1776063400000,
                    },
                  ]
                : [],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/plugin/context?url=https://example.com/pricing",
    });

    expect(response.statusCode).toBe(200);
    const data = response.json() as {
      normalizedUrl: string;
      eagle: { hitCount: number; recentItems: Array<{ id: string; url: string; clickable: boolean }> };
    };
    expect(data.normalizedUrl).toBe("https://example.com/pricing");
    expect(data.eagle.hitCount).toBe(1);
    expect(data.eagle.recentItems[0]).toMatchObject({
      id: "eagle-item-www-only",
      url: "https://www.example.com/pricing",
      clickable: false,
    });
  });

  it("returns plugin context when Eagle duplicate check is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/library/info") || url.endsWith("/api/application/info")) {
        throw new Error("connect ECONNREFUSED");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/plugin/context?url=https://example.com/pricing",
    });

    expect(response.statusCode).toBe(200);
    const data = response.json() as {
      eagle: { available: boolean; hitCount: number };
      runtime: { eagleHealthy: boolean; messages: string[] };
    };
    expect(data.eagle.available).toBe(false);
    expect(data.eagle.hitCount).toBe(0);
    expect(data.runtime.eagleHealthy).toBe(false);
    expect(data.runtime.messages.some((message) => message.includes("Eagle duplicate check unavailable"))).toBe(true);
  });

  it("rejects plugin context for non-http pages", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/plugin/context?url=chrome://new-tab-page",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Only regular http(s) page URLs are supported");
  });

  it("returns flattened Eagle folders sorted by path", async () => {
    mockEagleFolderList([
      {
        id: "sections-root",
        name: "Sections",
        children: [
          { id: "section-general-id", name: "Section_Gerneral" },
        ],
      },
      {
        id: "pages-root",
        name: "Pages",
        children: [
          { id: "page-pricing-id", name: "Page_Pricing" },
          { id: "page-home-id", name: "Page_Home" },
        ],
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/eagle/folders",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: "pages-root", name: "Pages", path: "Pages" },
      { id: "page-home-id", name: "Page_Home", path: "Pages/Page_Home" },
      { id: "page-pricing-id", name: "Page_Pricing", path: "Pages/Page_Pricing" },
      { id: "sections-root", name: "Sections", path: "Sections" },
      { id: "section-general-id", name: "Section_Gerneral", path: "Sections/Section_Gerneral" },
    ]);
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
    mockEagleFolderList();

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
        thumbnailUrl: string;
        thumbnailWidth: number;
        thumbnailHeight: number;
        resolvedEagleFolderId: string | null;
        resolvedEagleFolderPath: string | null;
        targetEagleFolderId: string | null;
        targetEagleFolderPath: string | null;
        folderSelectionSource: string;
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
    expect(detailData.assets[0].thumbnailUrl).toContain("/api/assets/");
    expect(detailData.assets[0].thumbnailWidth).toBe(360);
    expect(detailData.assets[0].thumbnailHeight).toBeGreaterThan(0);
    expect(detailData.assets[0].resolvedEagleFolderId).toBe("JZR6J2FS0KW4W");
    expect(detailData.assets[0].resolvedEagleFolderPath).toBe("Pages/Page_Home");
    expect(detailData.assets[0].targetEagleFolderId).toBe("JZR6J2FS0KW4W");
    expect(detailData.assets[0].targetEagleFolderPath).toBe("Pages/Page_Home");
    expect(detailData.assets[0].folderSelectionSource).toBe("auto");
    expect(detailData.assets[0].eagleFolderId).toBe("JZR6J2FS0KW4W");
    expect(detailData.assets[0].eagleFolderPath).toBe("Pages/Page_Home");
    expect(detailData.assets[0].selectedForImport).toBe(true);
    expect(detailData.assets[0].importStatus).toBe("pending_confirmation");
    expect(detailData.logs.length).toBeGreaterThan(0);
    expect(detailData.manifest.sectionDebug?.rawCandidates.length).toBe(1);

    const thumbnailResponse = await app.inject({
      method: "GET",
      url: detailData.assets[0].thumbnailUrl,
    });
    expect(thumbnailResponse.statusCode).toBe(200);
    expect(thumbnailResponse.headers["content-type"]).toContain("image/jpeg");
    expect(Buffer.byteLength(thumbnailResponse.body)).toBeGreaterThan(0);
  });

  it("rescans Core Pages and Section jobs with their original configuration", async () => {
    mockEagleFolderList();

    const cases = [
      {
        mode: "core-routes" as const,
        instruction: "open https://example.com and map the core pages",
        options: {
          quality: 87,
          dpr: 1 as const,
          sectionScope: "all-top-level" as const,
          classicMaxSections: 7,
          maxRoutes: 8,
          outputDir: tmpDir,
        },
      },
      {
        mode: "single" as const,
        instruction: "open https://example.com and capture the pricing section",
        options: {
          quality: 90,
          dpr: "auto" as const,
          sectionScope: "manual" as const,
          classicMaxSections: 4,
          maxRoutes: 5,
          outputDir: tmpDir,
        },
      },
    ];

    for (const testCase of cases) {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/jobs",
        payload: {
          instruction: testCase.instruction,
          mode: testCase.mode,
          ...testCase.options,
        },
      });
      expect(createResponse.statusCode).toBe(202);
      const sourceJobId = (createResponse.json() as { jobId: string }).jobId;
      const sourceStatus = await waitForTerminalStatus(app, sourceJobId);
      const sourceBefore = repo.getJob(sourceJobId);
      expect(sourceBefore).toBeDefined();

      const rescanResponse = await app.inject({
        method: "POST",
        url: `/api/jobs/${sourceJobId}/rescan`,
      });
      expect(rescanResponse.statusCode).toBe(202);
      const rescanData = rescanResponse.json() as {
        jobId: string;
        sourceJobId: string;
        status: string;
        mode: string;
      };
      expect(rescanData).toMatchObject({
        sourceJobId,
        status: "queued",
        mode: testCase.mode,
      });
      expect(rescanData.jobId).not.toBe(sourceJobId);

      await waitForTerminalStatus(app, rescanData.jobId);
      const sourceAfter = repo.getJob(sourceJobId);
      const rescannedJob = repo.getJob(rescanData.jobId);
      expect(sourceAfter?.status).toBe(sourceStatus);
      expect(sourceAfter?.optionsJson).toBe(sourceBefore?.optionsJson);
      expect(rescannedJob?.instruction).toBe(testCase.instruction);
      expect(JSON.parse(rescannedJob?.optionsJson ?? "{}")).toEqual(
        JSON.parse(sourceBefore?.optionsJson ?? "{}"),
      );
      expect(repo.getLogs(rescanData.jobId).some((log) => log.message.includes(sourceJobId))).toBe(true);
    }
  });

  it("rejects rescan while the source job is still active", async () => {
    const jobId = "active-rescan-job";
    repo.createJob({
      id: jobId,
      instruction: "open https://example.com",
      options: {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
        classicMaxSections: 10,
        mode: "core-routes",
        maxRoutes: 8,
        outputDir: tmpDir,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/rescan`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "Rescan is only available after the current job finishes",
    });
  });

  it("crops the bottom of a pending asset and restores the original", async () => {
    mockEagleFolderList();

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
      assets: Array<{
        id: number;
        imageWidth: number;
        imageHeight: number;
        canRestoreOriginal: boolean;
        previewUrl: string;
      }>;
    };
    const asset = detailBeforeData.assets[0];
    expect(asset).toMatchObject({
      imageWidth: 1440,
      imageHeight: 900,
      canRestoreOriginal: false,
    });

    const cropResponse = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/assets/${asset.id}/crop-bottom`,
      payload: {
        keepHeight: 700,
        expectedHeight: 900,
      },
    });
    expect(cropResponse.statusCode).toBe(200);
    expect(cropResponse.json()).toMatchObject({
      assetId: asset.id,
      imageWidth: 1440,
      imageHeight: 700,
      removedHeight: 200,
      canRestoreOriginal: true,
    });

    const croppedAsset = repo.getAssetById(asset.id);
    expect(croppedAsset).not.toBeNull();
    const croppedMetadata = await sharp(croppedAsset!.filePath).metadata();
    expect(croppedMetadata.height).toBe(700);

    const detailAfterCrop = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    const detailAfterCropData = detailAfterCrop.json() as {
      assets: Array<{
        imageHeight: number;
        canRestoreOriginal: boolean;
        previewUrl: string;
      }>;
    };
    expect(detailAfterCropData.assets[0]).toMatchObject({
      imageHeight: 700,
      canRestoreOriginal: true,
    });
    expect(detailAfterCropData.assets[0].previewUrl).not.toBe(asset.previewUrl);

    const restoreResponse = await app.inject({
      method: "DELETE",
      url: `/api/jobs/${jobId}/assets/${asset.id}/crop-bottom`,
    });
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json()).toMatchObject({
      assetId: asset.id,
      imageWidth: 1440,
      imageHeight: 900,
      canRestoreOriginal: false,
    });

    const restoredMetadata = await sharp(croppedAsset!.filePath).metadata();
    expect(restoredMetadata.height).toBe(900);
  });

  it("removes arbitrary horizontal bands and rebuilds repeated crops from the original", async () => {
    mockEagleFolderList();

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        instruction: "open https://example.com and capture",
      },
    });
    const jobId = (createResponse.json() as { jobId: string }).jobId;
    await waitForTerminalStatus(app, jobId);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    const assetId = (detailResponse.json() as { assets: Array<{ id: number }> }).assets[0]?.id;
    const asset = assetId ? repo.getAssetById(assetId) : null;
    expect(asset).not.toBeNull();
    await writeThreeBandTestJpeg(asset!.filePath);

    const staleResponse = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/assets/${asset!.id}/crop`,
      payload: {
        operation: {
          type: "remove-band",
          startY: 100,
          endY: 200,
        },
        expectedWidth: 101,
        expectedHeight: 300,
      },
    });
    expect(staleResponse.statusCode).toBe(409);

    const removeMiddleResponse = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/assets/${asset!.id}/crop`,
      payload: {
        operation: {
          type: "remove-band",
          startY: 100,
          endY: 200,
        },
        expectedWidth: 100,
        expectedHeight: 300,
      },
    });
    expect(removeMiddleResponse.statusCode).toBe(200);
    expect(removeMiddleResponse.json()).toMatchObject({
      imageWidth: 100,
      imageHeight: 200,
      removedHeight: 100,
      canRestoreOriginal: true,
    });

    const firstCrop = await sharp(asset!.filePath).raw().toBuffer({ resolveWithObject: true });
    const firstTopPixelOffset = (50 * firstCrop.info.width + 50) * firstCrop.info.channels;
    const firstBottomPixelOffset = (150 * firstCrop.info.width + 50) * firstCrop.info.channels;
    expect(firstCrop.data[firstTopPixelOffset]).toBeGreaterThan(220);
    expect(firstCrop.data[firstTopPixelOffset + 2]).toBeLessThan(30);
    expect(firstCrop.data[firstBottomPixelOffset]).toBeLessThan(30);
    expect(firstCrop.data[firstBottomPixelOffset + 2]).toBeGreaterThan(220);

    const removeSecondBandResponse = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/assets/${asset!.id}/crop`,
      payload: {
        operation: {
          type: "remove-band",
          startY: 50,
          endY: 100,
        },
        expectedWidth: 100,
        expectedHeight: 200,
      },
    });
    expect(removeSecondBandResponse.statusCode).toBe(200);
    expect(removeSecondBandResponse.json()).toMatchObject({
      imageWidth: 100,
      imageHeight: 150,
      removedHeight: 50,
    });

    const cropManifest = JSON.parse(
      await fs.readFile(getAssetCropManifestPath(asset!.filePath), "utf8"),
    ) as {
      retainedSegments: Array<{ startY: number; endY: number }>;
    };
    expect(cropManifest.retainedSegments).toEqual([
      { startY: 0, endY: 50 },
      { startY: 200, endY: 300 },
    ]);

    const secondCrop = await sharp(asset!.filePath).raw().toBuffer({ resolveWithObject: true });
    const secondTopPixelOffset = (25 * secondCrop.info.width + 50) * secondCrop.info.channels;
    const secondBottomPixelOffset = (75 * secondCrop.info.width + 50) * secondCrop.info.channels;
    expect(secondCrop.data[secondTopPixelOffset]).toBeGreaterThan(220);
    expect(secondCrop.data[secondTopPixelOffset + 2]).toBeLessThan(30);
    expect(secondCrop.data[secondBottomPixelOffset]).toBeLessThan(30);
    expect(secondCrop.data[secondBottomPixelOffset + 2]).toBeGreaterThan(220);

    const invalidRangeResponse = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/assets/${asset!.id}/crop`,
      payload: {
        operation: {
          type: "remove-band",
          startY: 0,
          endY: 100,
        },
        expectedWidth: 100,
        expectedHeight: 150,
      },
    });
    expect(invalidRangeResponse.statusCode).toBe(400);
    expect(invalidRangeResponse.json()).toMatchObject({
      error: "The crop must retain at least 64px",
    });

    const restoreResponse = await app.inject({
      method: "DELETE",
      url: `/api/jobs/${jobId}/assets/${asset!.id}/crop`,
    });
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json()).toMatchObject({
      imageWidth: 100,
      imageHeight: 300,
      canRestoreOriginal: false,
    });
    await expect(fs.access(getAssetCropManifestPath(asset!.filePath))).rejects.toThrow();
  });

  it("rejects crop edits while a job is running or after an asset is imported", async () => {
    mockEagleFolderList();

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        instruction: "open https://example.com and capture",
      },
    });
    const jobId = (createResponse.json() as { jobId: string }).jobId;
    await waitForTerminalStatus(app, jobId);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    const assetId = (detailResponse.json() as { assets: Array<{ id: number }> }).assets[0]?.id;
    expect(assetId).toBeTypeOf("number");

    repo.setJobRunning(jobId);
    const runningResponse = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/assets/${assetId}/crop`,
      payload: {
        operation: {
          type: "remove-bottom",
          keepHeight: 700,
        },
        expectedWidth: 1440,
        expectedHeight: 900,
      },
    });
    expect(runningResponse.statusCode).toBe(400);
    expect(runningResponse.json()).toMatchObject({
      error: "Asset cropping is not available while the job is running",
    });

    repo.setJobResult({
      jobId,
      status: "awaiting_confirmation",
    });
    const directDb = new Database(dbPath);
    directDb
      .prepare(
        "UPDATE assets SET import_status = 'imported', import_ok = 1, eagle_id = 'test-eagle-id' WHERE id = ?",
      )
      .run(assetId);
    directDb.close();

    const importedCropResponse = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/assets/${assetId}/crop`,
      payload: {
        operation: {
          type: "remove-bottom",
          keepHeight: 700,
        },
        expectedWidth: 1440,
        expectedHeight: 900,
      },
    });
    expect(importedCropResponse.statusCode).toBe(400);
    expect(importedCropResponse.json()).toMatchObject({
      error: "Imported assets cannot be cropped",
    });

    const importedRestoreResponse = await app.inject({
      method: "DELETE",
      url: `/api/jobs/${jobId}/assets/${assetId}/crop`,
    });
    expect(importedRestoreResponse.statusCode).toBe(400);
    expect(importedRestoreResponse.json()).toMatchObject({
      error: "Imported assets cannot be restored",
    });
  });

  it("stores a manual Eagle folder override for a pending asset", async () => {
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
      assets: Array<{ id: number }>;
    };
    const assetId = detailBeforeData.assets[0]?.id;
    if (!assetId) {
      throw new Error("Expected seeded asset");
    }

    mockEagleFolderList();
    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/assets/${assetId}/folder`,
      payload: {
        targetEagleFolderId: "page-pricing-id",
      },
    });
    expect(updateResponse.statusCode).toBe(200);

    mockEagleFolderList();
    const detailAfter = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    const detailAfterData = detailAfter.json() as {
      assets: Array<{
        folderOverrideId?: string | null;
        resolvedEagleFolderPath: string | null;
        targetEagleFolderId: string | null;
        targetEagleFolderPath: string | null;
        folderSelectionSource: string;
      }>;
    };
    expect(detailAfterData.assets[0].folderOverrideId).toBe("page-pricing-id");
    expect(detailAfterData.assets[0].resolvedEagleFolderPath).toBe("Pages/Page_Home");
    expect(detailAfterData.assets[0].targetEagleFolderId).toBe("page-pricing-id");
    expect(detailAfterData.assets[0].targetEagleFolderPath).toBe("Pages/Page_Pricing");
    expect(detailAfterData.assets[0].folderSelectionSource).toBe("manual");
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

  it("rescans one successful route without rerunning the other core pages", async () => {
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
    const initialStatus = await waitForTerminalStatus(app, createData.jobId);
    expect(initialStatus).toBe("partial_success");

    const detailBeforeResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/${createData.jobId}`,
    });
    const detailBefore = detailBeforeResponse.json() as {
      routes: Array<{
        id: number;
        url: string;
        status: string;
        attemptCount: number;
      }>;
      assets: Array<{
        id: number;
        sourceUrl: string;
        fileName: string;
      }>;
    };
    const successfulRoute = detailBefore.routes.find((route) => route.status === "success");
    expect(successfulRoute).toBeDefined();
    const previousRouteAssets = detailBefore.assets.filter(
      (asset) => asset.sourceUrl === successfulRoute!.url,
    );
    expect(previousRouteAssets).toHaveLength(1);

    const rescanResponse = await app.inject({
      method: "POST",
      url: `/api/jobs/${createData.jobId}/retry-route`,
      payload: {
        routeId: successfulRoute!.id,
      },
    });
    expect(rescanResponse.statusCode).toBe(202);

    const rescannedStatus = await waitForNextTerminalStatus(app, createData.jobId, initialStatus);
    expect(rescannedStatus).toBe("partial_success");

    const detailAfterResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/${createData.jobId}`,
    });
    const detailAfter = detailAfterResponse.json() as {
      routes: Array<{
        id: number;
        url: string;
        status: string;
        attemptCount: number;
      }>;
      assets: Array<{
        id: number;
        sourceUrl: string;
        fileName: string;
      }>;
    };
    const rescannedRoute = detailAfter.routes.find((route) => route.id === successfulRoute!.id);
    expect(rescannedRoute).toMatchObject({
      status: "success",
      attemptCount: successfulRoute!.attemptCount + 1,
    });
    const nextRouteAssets = detailAfter.assets.filter(
      (asset) => asset.sourceUrl === successfulRoute!.url,
    );
    expect(nextRouteAssets).toHaveLength(1);
    expect(nextRouteAssets[0]?.id).not.toBe(previousRouteAssets[0]?.id);
    expect(nextRouteAssets[0]?.fileName).toContain("retry-");
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

  it("cleans local files while preserving the lightweight job history", async () => {
    const jobId = "clean-finished-job";
    const outputRoot = path.join(tmpDir, "clean-output");
    const outputDir = path.join(outputRoot, jobId);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "capture.jpg"), "screenshot", "utf8");
    const manifestPath = path.join(outputDir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify({ runId: jobId }), "utf8");

    repo.createJob({
      id: jobId,
      instruction: "clean local files",
      options: {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
        classicMaxSections: 10,
        mode: "core-routes",
        maxRoutes: 12,
        outputDir: outputRoot,
      },
    });
    repo.setJobResult({
      jobId,
      status: "success",
      manifestPath,
      outputDir,
      taskJson: JSON.stringify({ url: "https://example.com" }),
    });
    repo.replaceAssets(jobId, {
      runId: jobId,
      instruction: "clean local files",
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
      outputDir,
      assets: [
        {
          kind: "fullPage",
          label: "full_page",
          filePath: path.join(outputDir, "capture.jpg"),
          fileName: "capture.jpg",
          sourceUrl: "https://example.com",
          quality: 92,
          dpr: 2,
          capturedAt: new Date().toISOString(),
          import: createPendingImportResult(),
        },
      ],
    });
    repo.replaceRouteTargets(jobId, [
      {
        url: "https://example.com/",
        path: "/",
        source: "nav",
        depth: 0,
        priorityScore: 100,
      },
    ]);
    repo.addLog(jobId, "info", "ready for cleanup");

    const response = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/cleanup`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jobId, filesDeleted: true });
    expect(response.json().cleanedAt).toEqual(expect.any(String));
    expect(response.json().archivedAt).toEqual(expect.any(String));

    const preservedJob = repo.getJob(jobId);
    expect(preservedJob).toMatchObject({
      id: jobId,
      status: "success",
      manifestPath: null,
      outputDir: null,
    });
    expect(preservedJob?.cleanedAt).toBeTruthy();
    expect(preservedJob?.archivedAt).toBeTruthy();
    await expect(fs.access(outputDir)).rejects.toThrow();

    const rawDb = new Database(dbPath);
    expect((rawDb.prepare("SELECT COUNT(*) AS count FROM assets WHERE job_id = ?").get(jobId) as { count: number }).count).toBe(0);
    expect((rawDb.prepare("SELECT COUNT(*) AS count FROM job_logs WHERE job_id = ?").get(jobId) as { count: number }).count).toBe(0);
    expect((rawDb.prepare("SELECT COUNT(*) AS count FROM route_targets WHERE job_id = ?").get(jobId) as { count: number }).count).toBe(0);
    expect((rawDb.prepare("SELECT COUNT(*) AS count FROM job_history_urls WHERE job_id = ?").get(jobId) as { count: number }).count).toBe(1);
    rawDb.close();

    const archivedSummary = repo
      .listJobs({ archivedOnly: true })
      .items.find((job) => job.id === jobId);
    expect(archivedSummary).toMatchObject({
      assetCount: 1,
      pendingConfirmationCount: 1,
      importSuccessCount: 0,
      importFailedCount: 0,
    });

    const repeatedCleanup = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/cleanup`,
    });
    expect(repeatedCleanup.statusCode).toBe(409);
    expect(repeatedCleanup.json()).toEqual({
      error: "Local files for this job have already been cleaned",
    });

    const unarchiveResponse = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/archive`,
      payload: { archived: false },
    });
    expect(unarchiveResponse.statusCode).toBe(409);
    expect(unarchiveResponse.json()).toEqual({
      error: "Jobs with cleaned local files must remain in history",
    });
  });

  it("rejects local file cleanup while a job is running", async () => {
    const jobId = "clean-running-job";
    repo.createJob({
      id: jobId,
      instruction: "still running",
      options: {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
        classicMaxSections: 10,
        mode: "single",
        maxRoutes: 12,
        outputDir: path.join(tmpDir, "clean-running-output"),
      },
    });
    repo.setJobRunning(jobId);

    const response = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/cleanup`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Local files can only be cleaned after the job finishes",
    });
    expect(repo.getJob(jobId)).not.toBeNull();
  });

  it("cleans files for every eligible archived job without touching active jobs", async () => {
    const isolatedTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-api-bulk-cleanup-"));
    const isolatedRepo = new JobsRepository(path.join(isolatedTmpDir, "jobs.db"));
    const isolatedApp = await buildServer({
      repo: isolatedRepo,
      queue: new JobQueue(),
    });
    const outputRoot = path.join(isolatedTmpDir, "output");
    const archivedJobIds = ["bulk-clean-archived-1", "bulk-clean-archived-2"];
    const activeJobId = "bulk-clean-active";

    const createFinishedJob = async (jobId: string, archived: boolean): Promise<string> => {
      const outputDir = path.join(outputRoot, jobId);
      const capturePath = path.join(outputDir, "capture.jpg");
      const manifestPath = path.join(outputDir, "manifest.json");
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(capturePath, "screenshot", "utf8");

      const manifest: RunManifest = {
        runId: jobId,
        instruction: `capture ${jobId}`,
        createdAt: new Date().toISOString(),
        task: {
          url: `https://example.com/${jobId}`,
          waitUntil: "networkidle",
          captures: [{ mode: "fullPage" }],
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
            filePath: capturePath,
            fileName: "capture.jpg",
            sourceUrl: `https://example.com/${jobId}`,
            quality: 92,
            dpr: 2,
            capturedAt: new Date().toISOString(),
            import: createPendingImportResult(),
          },
        ],
      };
      await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
      isolatedRepo.createJob({
        id: jobId,
        instruction: manifest.instruction,
        options: {
          quality: 92,
          dpr: "auto",
          sectionScope: "classic",
          classicMaxSections: 10,
          mode: "single",
          maxRoutes: 12,
          outputDir: outputRoot,
        },
      });
      isolatedRepo.setJobResult({
        jobId,
        status: "success",
        manifestPath,
        outputDir,
        taskJson: JSON.stringify(manifest.task),
      });
      isolatedRepo.replaceAssets(jobId, manifest);
      if (archived) {
        isolatedRepo.setJobArchived(jobId, true);
      }
      return outputDir;
    };

    try {
      const archivedOutputDirs = await Promise.all(
        archivedJobIds.map((jobId) => createFinishedJob(jobId, true)),
      );
      const activeOutputDir = await createFinishedJob(activeJobId, false);

      const previewResponse = await isolatedApp.inject({
        method: "GET",
        url: "/api/cleanup/archived",
      });
      expect(previewResponse.statusCode).toBe(200);
      expect(previewResponse.json()).toEqual({
        jobCount: 2,
        assetCount: 2,
      });

      const cleanupResponse = await isolatedApp.inject({
        method: "POST",
        url: "/api/cleanup/archived",
      });
      expect(cleanupResponse.statusCode).toBe(200);
      expect(cleanupResponse.json()).toMatchObject({
        eligibleJobCount: 2,
        eligibleAssetCount: 2,
        cleanedCount: 2,
        filesDeletedCount: 2,
        failedCount: 0,
        failures: [],
      });

      for (const [index, jobId] of archivedJobIds.entries()) {
        expect(isolatedRepo.getJob(jobId)?.cleanedAt).toBeTruthy();
        expect(isolatedRepo.getAssets(jobId)).toEqual([]);
        await expect(fs.access(archivedOutputDirs[index])).rejects.toThrow();
      }
      expect(isolatedRepo.getJob(activeJobId)?.cleanedAt).toBeNull();
      expect(isolatedRepo.getAssets(activeJobId)).toHaveLength(1);
      await expect(fs.access(activeOutputDir)).resolves.toBeUndefined();

      const emptyPreviewResponse = await isolatedApp.inject({
        method: "GET",
        url: "/api/cleanup/archived",
      });
      expect(emptyPreviewResponse.json()).toEqual({
        jobCount: 0,
        assetCount: 0,
      });
    } finally {
      await isolatedApp.close();
      isolatedRepo.close();
      await fs.rm(isolatedTmpDir, { recursive: true, force: true });
    }
  });

  it("auto-archives finished jobs older than a week on server startup", async () => {
    const isolatedTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-api-auto-archive-"));
    const isolatedDbPath = path.join(isolatedTmpDir, "jobs.db");
    const isolatedRepo = new JobsRepository(isolatedDbPath);
    const isolatedQueue = new JobQueue();

    const oldJobId = "old-finished-job";
    const recentJobId = "recent-finished-job";

    isolatedRepo.createJob({
      id: oldJobId,
      instruction: "old job",
      options: {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
        classicMaxSections: 10,
        mode: "single",
        maxRoutes: 12,
        outputDir: path.join(isolatedTmpDir, oldJobId),
      },
    });
    isolatedRepo.setJobResult({
      jobId: oldJobId,
      status: "success",
      taskJson: JSON.stringify({ url: "https://example.com/old" }),
    });

    isolatedRepo.createJob({
      id: recentJobId,
      instruction: "recent job",
      options: {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
        classicMaxSections: 10,
        mode: "single",
        maxRoutes: 12,
        outputDir: path.join(isolatedTmpDir, recentJobId),
      },
    });
    isolatedRepo.setJobResult({
      jobId: recentJobId,
      status: "success",
      taskJson: JSON.stringify({ url: "https://example.com/recent" }),
    });

    const now = Date.now();
    const oldFinishedAt = new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString();
    const recentFinishedAt = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();

    const rawDb = new Database(isolatedDbPath);
    rawDb.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").run(oldFinishedAt, oldJobId);
    rawDb.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").run(recentFinishedAt, recentJobId);
    rawDb.close();

    const isolatedApp = await buildServer({
      repo: isolatedRepo,
      queue: isolatedQueue,
      webDistDir: path.join(isolatedTmpDir, "no-ui"),
    });
    await isolatedApp.ready();

    try {
      const defaultListResponse = await isolatedApp.inject({
        method: "GET",
        url: "/api/jobs?page=1&pageSize=20",
      });
      expect(defaultListResponse.statusCode).toBe(200);
      const defaultListData = defaultListResponse.json() as { items: Array<{ id: string }> };
      expect(defaultListData.items.some((job) => job.id === oldJobId)).toBe(false);
      expect(defaultListData.items.some((job) => job.id === recentJobId)).toBe(true);

      const archivedListResponse = await isolatedApp.inject({
        method: "GET",
        url: "/api/jobs?page=1&pageSize=20&archivedOnly=true",
      });
      expect(archivedListResponse.statusCode).toBe(200);
      const archivedListData = archivedListResponse.json() as {
        items: Array<{ id: string; archivedAt: string | null }>;
      };
      expect(archivedListData.items.find((job) => job.id === oldJobId)?.archivedAt).toBeTruthy();
      expect(archivedListData.items.some((job) => job.id === recentJobId)).toBe(false);

      const unarchiveResponse = await isolatedApp.inject({
        method: "POST",
        url: `/api/jobs/${oldJobId}/archive`,
        payload: {
          archived: false,
        },
      });
      expect(unarchiveResponse.statusCode).toBe(200);

      const listAfterUnarchive = await isolatedApp.inject({
        method: "GET",
        url: "/api/jobs?page=1&pageSize=20",
      });
      const listAfterUnarchiveData = listAfterUnarchive.json() as { items: Array<{ id: string }> };
      expect(listAfterUnarchiveData.items.some((job) => job.id === oldJobId)).toBe(true);
    } finally {
      await isolatedApp.close();
      isolatedRepo.close();
      await fs.rm(isolatedTmpDir, { recursive: true, force: true });
    }
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

  it("rejects retry-route for routes that are neither successful nor failed", async () => {
    const seeded = await createManualCoreRoutesJob(repo, tmpDir, {
      id: "manual-skipped-job",
      jobStatus: "partial_success",
      routeStatus: "skipped",
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
      error: "retry-route is only available for successful or failed routes",
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

  it("saves full asset selection and treats fully unselected pending assets as non-blocking", async () => {
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
    expect(detailAfterData.job.status).toBe("failed");
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
    expect(updatedJob?.pendingConfirmationCount).toBe(0);
  });

  it("blocks selected import when a selected asset has no existing Eagle folder target", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        instruction: "open https://example.com and capture",
      },
    });
    const jobId = (createResponse.json() as { jobId: string }).jobId;
    await waitForTerminalStatus(app, jobId);

    mockEagleFolderList([
      {
        id: "sections-root",
        name: "Sections",
        children: [{ id: "section-general-id", name: "Section_Gerneral" }],
      },
    ]);

    const importResponse = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/import-selected`,
    });

    expect(importResponse.statusCode).toBe(400);
    expect(importResponse.json()).toMatchObject({
      error: "Selected pending assets must use an existing Eagle folder before import",
    });
  });

  it("treats importing only part of the assets as partial success", async () => {
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
    if (!job?.manifestPath || !job.outputDir) {
      throw new Error("Expected manifest path for seeded job");
    }

    const manifest = JSON.parse(await fs.readFile(job.manifestPath, "utf8")) as RunManifest;
    const secondaryImagePath = path.join(job.outputDir, "secondary.jpg");
    await writeTestJpeg(secondaryImagePath, 1280, 960);
    const expandedManifest: RunManifest = {
      ...manifest,
      assets: [
        ...manifest.assets,
        {
          kind: "fullPage",
          label: "full_page",
          filePath: secondaryImagePath,
          fileName: "secondary.jpg",
          sourceUrl: "https://example.com/pricing",
          quality: 92,
          dpr: 2,
          capturedAt: new Date().toISOString(),
          import: createPendingImportResult(),
        },
      ],
    };
    await fs.writeFile(job.manifestPath, JSON.stringify(expandedManifest, null, 2), "utf8");
    manifestMap.set(job.manifestPath, expandedManifest);
    repo.replaceAssets(jobId, expandedManifest);
    repo.setJobResult({
      jobId,
      status: "awaiting_confirmation",
      taskJson: JSON.stringify(expandedManifest.task),
      manifestPath: job.manifestPath,
      outputDir: expandedManifest.outputDir,
      error: null,
    });

    const detailBefore = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    const detailBeforeData = detailBefore.json() as {
      assets: Array<{ id: number }>;
    };
    expect(detailBeforeData.assets).toHaveLength(2);

    const selectionResponse = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/assets/selection`,
      payload: {
        selectedAssetIds: [detailBeforeData.assets[0].id],
      },
    });
    expect(selectionResponse.statusCode).toBe(200);

    mockEagleFolderList();
    const importResponse = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/import-selected`,
    });
    expect(importResponse.statusCode).toBe(202);

    const finalStatus = await waitForNextTerminalStatus(app, jobId, "awaiting_confirmation");
    expect(finalStatus).toBe("partial_success");
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
    mockEagleFolderList();

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

  it("persists queued state and rejects duplicate selected imports while one is queued", async () => {
    const isolatedTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-import-queue-"));
    const isolatedDbPath = path.join(isolatedTmpDir, "jobs.db");
    const isolatedRepo = new JobsRepository(isolatedDbPath);
    const isolatedQueue = new JobQueue();
    const jobId = "slow-import-job";
    const outputDir = path.join(isolatedTmpDir, jobId);
    await fs.mkdir(outputDir, { recursive: true });
    const imagePath = path.join(outputDir, "sample.jpg");
    await writeTestJpeg(imagePath, 1280, 960);

    const manifest: RunManifest = {
      runId: jobId,
      instruction: "open https://example.com/pricing and import",
      createdAt: new Date().toISOString(),
      task: {
        url: "https://example.com/pricing",
        waitUntil: "networkidle",
        captures: [{ mode: "fullPage" }],
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
          filePath: imagePath,
          fileName: "sample.jpg",
          sourceUrl: "https://example.com/pricing",
          quality: 92,
          dpr: 2,
          capturedAt: new Date().toISOString(),
          folderOverrideId: "page-pricing-id",
          import: createPendingImportResult(),
        },
      ],
      routes: [],
      scrollSceneDebug: [],
    };
    const manifestPath = path.join(outputDir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    isolatedRepo.createJob({
      id: jobId,
      instruction: manifest.instruction,
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
    isolatedRepo.replaceAssets(jobId, manifest);
    isolatedRepo.setJobResult({
      jobId,
      status: "awaiting_confirmation",
      taskJson: JSON.stringify(manifest.task),
      manifestPath,
      outputDir,
      error: null,
    });

    let releaseQueueBlocker = (): void => {
      // replaced when the blocking promise is created
    };
    const queueBlocked = new Promise<void>((resolve) => {
      releaseQueueBlocker = () => resolve();
    });
    isolatedQueue.enqueue("blocking-job", async () => {
      await queueBlocked;
    });

    let releaseImport = (): void => {
      // replaced when the blocking promise is created
    };
    const importBlocked = new Promise<void>((resolve) => {
      releaseImport = () => resolve();
    });
    let importCallCount = 0;
    const slowImportSelectedFn = async (inputManifestPath: string): Promise<RunManifest> => {
      importCallCount += 1;
      const existing = JSON.parse(await fs.readFile(inputManifestPath, "utf8")) as RunManifest;
      await importBlocked;
      const updated: RunManifest = {
        ...existing,
        assets: existing.assets.map((asset) => ({
          ...asset,
          import: {
            ok: true,
            selected: true,
            status: "imported",
            eagleId: "slow-import-eagle-id",
          },
        })),
      };
      await fs.writeFile(inputManifestPath, JSON.stringify(updated, null, 2), "utf8");
      return updated;
    };

    const isolatedApp = await buildServer({
      repo: isolatedRepo,
      queue: isolatedQueue,
      webDistDir: path.join(isolatedTmpDir, "no-ui"),
      importSelectedFn: slowImportSelectedFn,
    });
    await isolatedApp.ready();

    try {
      mockEagleFolderList();
      const importResponse = await isolatedApp.inject({
        method: "POST",
        url: `/api/jobs/${jobId}/import-selected`,
      });

      expect(importResponse.statusCode).toBe(202);

      const duplicateImportResponse = await isolatedApp.inject({
        method: "POST",
        url: `/api/jobs/${jobId}/import-selected`,
      });
      expect(duplicateImportResponse.statusCode).toBe(409);
      expect(duplicateImportResponse.json()).toEqual({
        error: "Eagle import for this job is already queued or running",
      });

      const detailWhileBlockedResponse = await isolatedApp.inject({
        method: "GET",
        url: `/api/jobs/${jobId}`,
      });
      const detailWhileBlockedData = detailWhileBlockedResponse.json() as {
        job: { status: string };
        assets: Array<{ importStatus: string }>;
      };
      expect(detailWhileBlockedData.job.status).toBe("queued");
      expect(detailWhileBlockedData.assets[0].importStatus).toBe("pending_confirmation");

      releaseQueueBlocker();
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseImport();
      const finalStatus = await waitForNextTerminalStatus(
        isolatedApp,
        jobId,
        detailWhileBlockedData.job.status,
      );
      expect(finalStatus).toBe("success");
      expect(importCallCount).toBe(1);
    } finally {
      await isolatedApp.close();
      await fs.rm(isolatedTmpDir, { recursive: true, force: true });
    }
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
    mockEagleFolderList();

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

  it("rejects duplicate failed import retries while one is queued", async () => {
    const isolatedTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-retry-queue-"));
    const isolatedDbPath = path.join(isolatedTmpDir, "jobs.db");
    const isolatedRepo = new JobsRepository(isolatedDbPath);
    const isolatedQueue = new JobQueue();
    const jobId = "slow-retry-job";
    const outputDir = path.join(isolatedTmpDir, jobId);
    await fs.mkdir(outputDir, { recursive: true });
    const imagePath = path.join(outputDir, "sample.jpg");
    await writeTestJpeg(imagePath, 1280, 960);

    const manifest: RunManifest = {
      runId: jobId,
      instruction: "open https://example.com/pricing and retry import",
      createdAt: new Date().toISOString(),
      task: {
        url: "https://example.com/pricing",
        waitUntil: "networkidle",
        captures: [{ mode: "fullPage" }],
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
          filePath: imagePath,
          fileName: "sample.jpg",
          sourceUrl: "https://example.com/pricing",
          quality: 92,
          dpr: 2,
          capturedAt: new Date().toISOString(),
          folderOverrideId: "page-pricing-id",
          import: {
            ok: false,
            selected: true,
            status: "failed",
            error: "seeded failure",
          },
        },
      ],
      routes: [],
      scrollSceneDebug: [],
    };
    const manifestPath = path.join(outputDir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    isolatedRepo.createJob({
      id: jobId,
      instruction: manifest.instruction,
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
    isolatedRepo.replaceAssets(jobId, manifest);
    isolatedRepo.setJobResult({
      jobId,
      status: "partial_success",
      taskJson: JSON.stringify(manifest.task),
      manifestPath,
      outputDir,
      error: "Some assets still require attention",
    });

    let releaseQueueBlocker = (): void => {
      // replaced when the blocking promise is created
    };
    const queueBlocked = new Promise<void>((resolve) => {
      releaseQueueBlocker = () => resolve();
    });
    isolatedQueue.enqueue("blocking-job", async () => {
      await queueBlocked;
    });

    let releaseRetry = (): void => {
      // replaced when the blocking promise is created
    };
    const retryBlocked = new Promise<void>((resolve) => {
      releaseRetry = () => resolve();
    });
    let retryCallCount = 0;
    const slowRetryImportFn = async (inputManifestPath: string): Promise<RunManifest> => {
      retryCallCount += 1;
      const existing = JSON.parse(await fs.readFile(inputManifestPath, "utf8")) as RunManifest;
      await retryBlocked;
      const updated: RunManifest = {
        ...existing,
        assets: existing.assets.map((asset) => ({
          ...asset,
          import: {
            ok: true,
            selected: true,
            status: "imported",
            eagleId: "slow-retry-eagle-id",
          },
        })),
      };
      await fs.writeFile(inputManifestPath, JSON.stringify(updated, null, 2), "utf8");
      return updated;
    };

    const isolatedApp = await buildServer({
      repo: isolatedRepo,
      queue: isolatedQueue,
      webDistDir: path.join(isolatedTmpDir, "no-ui"),
      retryImportFn: slowRetryImportFn,
    });
    await isolatedApp.ready();

    try {
      mockEagleFolderList();
      const retryResponse = await isolatedApp.inject({
        method: "POST",
        url: `/api/jobs/${jobId}/retry-import`,
      });
      expect(retryResponse.statusCode).toBe(202);

      const duplicateRetryResponse = await isolatedApp.inject({
        method: "POST",
        url: `/api/jobs/${jobId}/retry-import`,
      });
      expect(duplicateRetryResponse.statusCode).toBe(409);
      expect(duplicateRetryResponse.json()).toEqual({
        error: "Eagle import for this job is already queued or running",
      });

      const detailWhileBlockedResponse = await isolatedApp.inject({
        method: "GET",
        url: `/api/jobs/${jobId}`,
      });
      const detailWhileBlockedData = detailWhileBlockedResponse.json() as {
        job: { status: string };
      };
      expect(detailWhileBlockedData.job.status).toBe("queued");

      releaseQueueBlocker();
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseRetry();
      const finalStatus = await waitForNextTerminalStatus(isolatedApp, jobId, "queued");
      expect(finalStatus).toBe("success");
      expect(retryCallCount).toBe(1);
    } finally {
      await isolatedApp.close();
      await fs.rm(isolatedTmpDir, { recursive: true, force: true });
    }
  });
});
