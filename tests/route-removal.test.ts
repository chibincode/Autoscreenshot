import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server/app.js";
import { JobsRepository } from "../src/server/db.js";
import { JobQueue } from "../src/server/queue.js";
import type { RouteDiscoveryTarget, RunManifest } from "../src/types.js";

const routes: RouteDiscoveryTarget[] = [
  { url: "https://example.com/", path: "/", source: "nav", depth: 0, priorityScore: 1000 },
  { url: "https://example.com/pricing", path: "/pricing", source: "nav", depth: 0, priorityScore: 900 },
];
const jobOptions = {
  mode: "core-routes" as const, quality: 92, dpr: "auto" as const,
  sectionScope: "classic" as const, classicMaxSections: 10, maxRoutes: 12, outputDir: "./output",
};

function manifestFor(jobId: string, outputDir: string, failedPricing = false): RunManifest {
  const now = new Date().toISOString();
  return {
    runId: jobId, instruction: "https://example.com", createdAt: now, outputDir, sectionScope: "classic",
    task: {
      url: "https://example.com", waitUntil: "networkidle", captures: [{ mode: "fullPage" }],
      image: { format: "jpg", quality: 92, dpr: 2 }, viewport: { width: 1920, height: 1080 }, tags: [], eagle: {},
    },
    routes: routes.map((route, index) => ({
      ...route, title: null, status: failedPricing && index === 1 ? "failed" : "success",
      error: null, attemptCount: 1, startedAt: now, finishedAt: now, updatedAt: now,
      assetCount: failedPricing && index === 1 ? 0 : 1, lastExecutedAt: now,
    })),
    assets: routes.filter((_, index) => !failedPricing || index === 0).map((route, index) => ({
      kind: "fullPage", label: "full_page", fileName: `${index}.jpg`,
      filePath: path.join(outputDir, `${index}.jpg`), sourceUrl: route.url, quality: 92, dpr: 2, capturedAt: now,
      import: { ok: false, selected: true, status: "pending_confirmation" },
    })),
  };
}

describe("page task removal", () => {
  let tmpDir: string;
  let repo: JobsRepository;
  let queue: JobQueue;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-route-removal-"));
    repo = new JobsRepository(path.join(tmpDir, "jobs.db"));
    queue = new JobQueue();
    app = await buildServer({ repo, queue, webDistDir: path.join(tmpDir, "no-ui") });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    repo.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function seed(jobId: string, failedPricing = false) {
    const outputDir = path.join(tmpDir, jobId);
    await fs.mkdir(outputDir, { recursive: true });
    const manifest = manifestFor(jobId, outputDir, failedPricing);
    const manifestPath = path.join(outputDir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    for (const asset of manifest.assets) await fs.writeFile(asset.filePath, "original image");
    repo.createJob({ id: jobId, instruction: "https://example.com", options: jobOptions });
    repo.replaceRouteTargets(jobId, routes);
    for (const route of manifest.routes!) {
      repo.updateRouteTargetStatus({ jobId, url: route.url, status: route.status });
    }
    repo.replaceAssets(jobId, manifest);
    repo.setJobResult({ jobId, status: failedPricing ? "partial_success" : "awaiting_confirmation", manifestPath, outputDir,
      taskJson: JSON.stringify(manifest.task) });
    return { manifest, manifestPath, targets: repo.listRouteTargets(jobId) };
  }

  it("removes a failed page, fixes the task status, and keeps the other capture unchanged", async () => {
    const { targets, manifestPath } = await seed("failed-page", true);
    const original = repo.getAssets("failed-page")[0];
    const response = await app.inject({ method: "DELETE", url: `/api/jobs/failed-page/routes/${targets[1].id}` });
    expect(response.statusCode).toBe(200);
    const detail = (await app.inject({ method: "GET", url: "/api/jobs/failed-page" })).json();
    expect(detail.routes).toHaveLength(1);
    expect(detail.job.status).toBe("awaiting_confirmation");
    expect(detail.assets[0].id).toBe(original.id);
    const saved = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    expect(saved.routes).toHaveLength(1);
    expect(repo.listJobs({}).items[0].pendingConfirmationCount).toBe(1);
    const retry = await app.inject({ method: "POST", url: "/api/jobs/failed-page/retry-route", payload: { routeId: targets[1].id } });
    expect(retry.statusCode).toBe(404);
  });

  it("removes successful captures from import and counts without deleting image files or Eagle items", async () => {
    const { targets, manifest, manifestPath } = await seed("successful-page");
    manifest.assets[0].import = { ok: true, selected: true, status: "imported", eagleId: "keep-eagle-item" };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    repo.replaceAssets("successful-page", manifest);
    const response = await app.inject({ method: "DELETE", url: `/api/jobs/successful-page/routes/${targets[0].id}` });
    expect(response.statusCode).toBe(200);
    expect(repo.getAssets("successful-page").map(asset => asset.sourceUrl)).toEqual([routes[1].url]);
    expect(await fs.readFile(manifest.assets[0].filePath, "utf8")).toBe("original image");
    const saved = JSON.parse(await fs.readFile(manifestPath, "utf8")) as RunManifest;
    expect(saved.assets.map(asset => asset.sourceUrl)).toEqual([routes[1].url]);
    expect(repo.listJobs({}).items[0]).toMatchObject({ assetCount: 1, pendingConfirmationCount: 1, importSuccessCount: 0 });
    await app.inject({ method: "DELETE", url: `/api/jobs/successful-page/routes/${targets[1].id}` });
    expect(repo.getJob("successful-page")?.status).toBe("cancelled");
    expect(repo.getAssets("successful-page")).toEqual([]);
    const importResponse = await app.inject({ method: "POST", url: "/api/jobs/successful-page/import-selected" });
    expect(importResponse.statusCode).toBe(400);
  });

  it("validates ownership and IDs without changing another task", async () => {
    const first = await seed("first");
    await seed("second");
    const wrongJob = await app.inject({ method: "DELETE", url: `/api/jobs/second/routes/${first.targets[0].id}` });
    expect(wrongJob.statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/jobs/first/routes/not-a-number" })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: "/api/jobs/missing/routes/1" })).statusCode).toBe(404);
    expect(repo.listRouteTargets("first")).toHaveLength(2);
    expect(repo.listRouteTargets("second")).toHaveLength(2);
  });

  it("blocks removal for queued or running Eagle imports", async () => {
    const { targets } = await seed("importing");
    let release!: () => void;
    queue.enqueue("blocker", () => new Promise<void>(resolve => { release = resolve; }));
    let releaseImport!: () => void;
    queue.enqueue("importing", () => new Promise<void>(resolve => { releaseImport = resolve; }), "import");
    try {
      const url = `/api/jobs/importing/routes/${targets[0].id}`;
      expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(409);
      release();
      await vi.waitFor(() => expect(queue.getStats().runningJobId).toBe("importing"));
      expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(409);
      expect(repo.listRouteTargets("importing")).toHaveLength(2);
    } finally {
      release();
      releaseImport?.();
      await vi.waitFor(() => expect(queue.hasJob("importing")).toBe(false));
    }
  });

  it("does not resurrect removed pages on rediscovery or late asset writes, and allows explicitly adding them back", async () => {
    const { targets, manifest } = await seed("late-result");
    repo.removeRouteTarget("late-result", targets[0].id!);
    repo.replaceRouteTargets("late-result", routes);
    repo.replaceAssets("late-result", manifest);
    expect(repo.listRouteTargets("late-result").map(route => route.url)).toEqual([routes[1].url]);
    expect(repo.getAssets("late-result").map(asset => asset.sourceUrl)).toEqual([routes[1].url]);
    const detail = (await app.inject({ method: "GET", url: "/api/jobs/late-result" })).json();
    expect(detail.manifest.assets.map((asset: { sourceUrl: string }) => asset.sourceUrl)).toEqual([routes[1].url]);
    const added = repo.createRouteTarget("late-result", { ...routes[0], source: "manual" });
    expect(added.status).toBe("queued");
    expect(repo.isRouteRemoved("late-result", routes[0].url)).toBe(false);
  });

  it("protects a page with a running motion recording", async () => {
    const { targets } = await seed("recording");
    const asset = repo.getAssets("recording")[0];
    const motionDir = path.join(path.dirname(asset.filePath), ".motion", String(asset.id));
    await fs.mkdir(motionDir, { recursive: true });
    await fs.writeFile(path.join(motionDir, "state.json"), JSON.stringify({ recordings: [
      { id: "00000000-0000-0000-0000-000000000001", status: "running" },
    ] }));
    const response = await app.inject({ method: "DELETE", url: `/api/jobs/recording/routes/${targets[0].id}` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("motion recording");
    expect(repo.listRouteTargets("recording")).toHaveLength(2);
  });

  it.each(["queued", "running"])("does not restore a page removed during a %s single-page rescan", async phase => {
    const { targets, manifest, manifestPath } = await seed("rescanning");
    await app.close();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const retry = vi.fn(async () => {
      await gate;
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      return { manifest, route: manifest.routes![0], fallbackToDpr1: false };
    });
    app = await buildServer({ repo, queue, retryCoreRouteFn: retry, webDistDir: path.join(tmpDir, "no-ui") });
    if (phase === "queued") queue.enqueue("blocker", () => gate);
    const response = await app.inject({ method: "POST", url: "/api/jobs/rescanning/retry-route", payload: { routeId: targets[0].id } });
    expect(response.statusCode).toBe(202);
    if (phase === "running") await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    try {
      expect((await app.inject({ method: "DELETE", url: `/api/jobs/rescanning/routes/${targets[0].id}` })).statusCode).toBe(200);
    } finally {
      release();
      await vi.waitFor(() => expect(queue.hasJob("rescanning")).toBe(false));
    }
    expect(retry).toHaveBeenCalledTimes(phase === "queued" ? 0 : 1);
    expect(repo.getAssets("rescanning").map(asset => asset.sourceUrl)).toEqual([routes[1].url]);
    const saved = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    expect(saved.assets.map((asset: { sourceUrl: string }) => asset.sourceUrl)).toEqual([routes[1].url]);
  });

  it("discards a running capture's late result and excludes a removed queued page from the final manifest", async () => {
    await app.close();
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let skipRoute: ((url: string) => boolean) | undefined;
    app = await buildServer({
      repo, queue, webDistDir: path.join(tmpDir, "no-ui"),
      executeCoreRoutesInstructionFn: async params => {
        await params.onRoutesDiscovered?.(routes);
        await params.onRouteStatus?.({ route: routes[0], status: "running", attemptCount: 1 });
        skipRoute = params.shouldSkipRoute;
        started();
        await gate;
        const manifest = manifestFor(params.runId, params.outputDir);
        await fs.mkdir(params.outputDir, { recursive: true });
        await fs.writeFile(params.manifestPath, JSON.stringify(manifest));
        return { runId: params.runId, manifestPath: params.manifestPath, manifest, routes: manifest.routes!, fallbackRoutes: 0, cancelled: false };
      },
    });
    const response = await app.inject({ method: "POST", url: "/api/jobs", payload: { instruction: "https://example.com", mode: "core-routes", outputDir: tmpDir } });
    const jobId = response.json().jobId as string;
    try {
      await didStart;
      for (const route of repo.listRouteTargets(jobId)) {
        expect((await app.inject({ method: "DELETE", url: `/api/jobs/${jobId}/routes/${route.id}` })).statusCode).toBe(200);
        expect(skipRoute?.(route.url)).toBe(true);
      }
    } finally {
      release();
      await vi.waitFor(() => expect(queue.hasJob(jobId)).toBe(false));
    }
    expect(repo.getAssets(jobId)).toEqual([]);
    expect(repo.listRouteTargets(jobId)).toEqual([]);
    expect(repo.getJob(jobId)?.status).toBe("cancelled");
    const saved = JSON.parse(await fs.readFile(repo.getJob(jobId)!.manifestPath!, "utf8"));
    expect(saved.assets).toEqual([]);
    expect(saved.routes).toEqual([]);
  });
});
