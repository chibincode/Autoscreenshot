import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobsRepository } from "../src/server/db.js";
import { normalizeEagleFolderRules } from "../src/core/eagle-folder-rules.js";

const DEFAULT_OPTIONS = {
  quality: 92,
  dpr: "auto" as const,
  sectionScope: "classic" as const,
  classicMaxSections: 10,
  mode: "single" as const,
  maxRoutes: 12,
  outputDir: "./output",
};

describe("jobs repository route targets", () => {
  let tmpDir = "";
  let dbPath = "";
  let repo: JobsRepository;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-db-"));
    dbPath = path.join(tmpDir, "jobs.db");
    repo = new JobsRepository(dbPath);
  });

  afterAll(async () => {
    repo.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("stores and updates route target state", () => {
    const jobId = "job-route-1";
    repo.createJob({
      id: jobId,
      instruction: "open https://example.com",
      options: { ...DEFAULT_OPTIONS, mode: "core-routes" },
    });

    repo.replaceRouteTargets(jobId, [
      {
        url: "https://example.com/",
        path: "/",
        source: "nav",
        depth: 0,
        priorityScore: 100,
      },
      {
        url: "https://example.com/pricing",
        path: "/pricing",
        source: "nav",
        depth: 0,
        priorityScore: 90,
      },
    ]);

    const routes = repo.listRouteTargets(jobId);
    expect(routes).toHaveLength(2);
    expect(routes[0].status).toBe("queued");

    repo.updateRouteTargetStatus({
      jobId,
      url: "https://example.com/pricing",
      status: "running",
      attemptCount: 1,
      startedAt: new Date().toISOString(),
    });

    const updated = repo
      .listRouteTargets(jobId)
      .find((route) => route.url === "https://example.com/pricing");

    expect(updated?.status).toBe("running");
    expect(updated?.attemptCount).toBe(1);
  });

  it("archives only finished terminal jobs older than the cutoff", () => {
    const rawDb = new Database(dbPath);
    const cutoffIso = "2026-04-02T00:00:00.000Z";
    const oldFinishedAt = "2026-04-02T00:00:00.000Z";
    const recentFinishedAt = "2026-04-02T00:00:00.001Z";

    const createFinishedJob = (jobId: string, status: "success" | "partial_success" | "failed" | "cancelled") => {
      repo.createJob({
        id: jobId,
        instruction: `job ${jobId}`,
        options: DEFAULT_OPTIONS,
      });
      repo.setJobResult({
        jobId,
        status,
        taskJson: JSON.stringify({ url: "https://example.com" }),
        error: status === "failed" ? "failed once" : status === "cancelled" ? "Cancelled by user" : null,
      });
    };

    createFinishedJob("old-success", "success");
    createFinishedJob("old-partial", "partial_success");
    createFinishedJob("old-failed", "failed");
    createFinishedJob("old-cancelled", "cancelled");
    createFinishedJob("recent-success", "success");
    createFinishedJob("already-archived", "success");
    repo.createJob({
      id: "running-job",
      instruction: "running job",
      options: DEFAULT_OPTIONS,
    });
    repo.setJobRunning("running-job");

    rawDb.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").run(oldFinishedAt, "old-success");
    rawDb.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").run(oldFinishedAt, "old-partial");
    rawDb.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").run(oldFinishedAt, "old-failed");
    rawDb.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").run(oldFinishedAt, "old-cancelled");
    rawDb.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").run(recentFinishedAt, "recent-success");
    rawDb
      .prepare("UPDATE jobs SET finished_at = ?, archived_at = ? WHERE id = ?")
      .run(oldFinishedAt, "2026-04-01T00:00:00.000Z", "already-archived");
    rawDb.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").run(oldFinishedAt, "running-job");
    rawDb.close();

    const result = repo.archiveFinishedJobsBefore({
      cutoffIso,
      statuses: ["success", "partial_success", "failed", "cancelled"],
    });

    expect(result.jobIds.sort()).toEqual(["old-cancelled", "old-failed", "old-partial", "old-success"]);
    expect(repo.getJob("old-success")?.archivedAt).toBeTruthy();
    expect(repo.getJob("old-partial")?.archivedAt).toBeTruthy();
    expect(repo.getJob("old-failed")?.archivedAt).toBeTruthy();
    expect(repo.getJob("old-cancelled")?.archivedAt).toBeTruthy();
    expect(repo.getJob("recent-success")?.archivedAt).toBeNull();
    expect(repo.getJob("already-archived")?.archivedAt).toBe("2026-04-01T00:00:00.000Z");
    expect(repo.getJob("running-job")?.archivedAt).toBeNull();
  });

  it("finds recent jobs by normalized source url", () => {
    const rules = normalizeEagleFolderRules({});
    repo.createJob({
      id: "job-dedupe-1",
      instruction: "https://www.example.com/en/pricing?ref=one#hero",
      options: DEFAULT_OPTIONS,
    });
    repo.createJob({
      id: "job-dedupe-2",
      instruction: "https://example.com/pricing",
      options: DEFAULT_OPTIONS,
    });
    repo.createJob({
      id: "job-other",
      instruction: "https://example.com/about",
      options: DEFAULT_OPTIONS,
    });

    repo.replaceAssets("job-dedupe-1", {
      runId: "job-dedupe-1",
      instruction: "https://www.example.com/en/pricing?ref=one#hero",
      createdAt: "2026-04-13T10:00:00.000Z",
      task: {
        url: "https://www.example.com/en/pricing?ref=one#hero",
        waitUntil: "networkidle",
        captures: [{ mode: "fullPage" }],
        image: { format: "jpg", quality: 92, dpr: "auto" },
        viewport: { width: 1920, height: 1080 },
        tags: [],
        eagle: {},
      },
      sectionScope: "classic",
      outputDir: "./output/job-dedupe-1",
      assets: [
        {
          kind: "fullPage",
          label: "Pricing page",
          filePath: "/tmp/job-dedupe-1.jpg",
          fileName: "job-dedupe-1.jpg",
          sourceUrl: "https://www.example.com/en/pricing?ref=one#hero",
          quality: 92,
          dpr: 2,
          capturedAt: "2026-04-13T10:00:00.000Z",
          import: { ok: false, selected: true, status: "pending_confirmation" },
        },
      ],
    });
    repo.replaceAssets("job-dedupe-2", {
      runId: "job-dedupe-2",
      instruction: "https://example.com/pricing",
      createdAt: "2026-04-13T11:00:00.000Z",
      task: {
        url: "https://example.com/pricing",
        waitUntil: "networkidle",
        captures: [{ mode: "fullPage" }],
        image: { format: "jpg", quality: 92, dpr: "auto" },
        viewport: { width: 1920, height: 1080 },
        tags: [],
        eagle: {},
      },
      sectionScope: "classic",
      outputDir: "./output/job-dedupe-2",
      assets: [
        {
          kind: "fullPage",
          label: "Pricing page v2",
          filePath: "/tmp/job-dedupe-2.jpg",
          fileName: "job-dedupe-2.jpg",
          sourceUrl: "https://example.com/pricing",
          quality: 92,
          dpr: 2,
          capturedAt: "2026-04-13T11:00:00.000Z",
          import: { ok: false, selected: true, status: "pending_confirmation" },
        },
      ],
    });
    repo.replaceAssets("job-other", {
      runId: "job-other",
      instruction: "https://example.com/about",
      createdAt: "2026-04-13T09:00:00.000Z",
      task: {
        url: "https://example.com/about",
        waitUntil: "networkidle",
        captures: [{ mode: "fullPage" }],
        image: { format: "jpg", quality: 92, dpr: "auto" },
        viewport: { width: 1920, height: 1080 },
        tags: [],
        eagle: {},
      },
      sectionScope: "classic",
      outputDir: "./output/job-other",
      assets: [
        {
          kind: "fullPage",
          label: "About page",
          filePath: "/tmp/job-other.jpg",
          fileName: "job-other.jpg",
          sourceUrl: "https://example.com/about",
          quality: 92,
          dpr: 2,
          capturedAt: "2026-04-13T09:00:00.000Z",
          import: { ok: false, selected: true, status: "pending_confirmation" },
        },
      ],
    });

    const matches = repo.findRecentJobsBySourceUrl({
      normalizedUrl: "https://example.com/pricing",
      urlNormalization: rules.urlNormalization,
      limit: 3,
    });

    expect(matches.map((job) => job.id)).toEqual(["job-dedupe-2", "job-dedupe-1"]);
    expect(matches.every((job) => job.mode === "single")).toBe(true);
    expect(matches[0]?.assetCount).toBe(1);
  });
});
