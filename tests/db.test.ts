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

  it("tracks completed imports and selects jobs after the history cutoff", () => {
    const buildManifest = (jobId: string, imported: boolean) => ({
      runId: jobId,
      instruction: `job ${jobId}`,
      createdAt: "2026-04-01T00:00:00.000Z",
      task: {
        url: `https://example.com/${jobId}`,
        waitUntil: "networkidle" as const,
        captures: [{ mode: "fullPage" as const }],
        image: { format: "jpg" as const, quality: 92, dpr: 2 as const },
        viewport: { width: 1920, height: 1080 },
        tags: [],
        eagle: {},
      },
      sectionScope: "classic" as const,
      outputDir: `/tmp/${jobId}`,
      assets: [
        {
          kind: "fullPage" as const,
          label: "full_page",
          filePath: `/tmp/${jobId}/capture.jpg`,
          fileName: "capture.jpg",
          sourceUrl: `https://example.com/${jobId}`,
          quality: 92,
          dpr: 2,
          capturedAt: "2026-04-01T00:00:00.000Z",
          import: imported
            ? { ok: true, selected: true, status: "imported" as const, eagleId: `eagle-${jobId}` }
            : { ok: false, selected: true, status: "pending_confirmation" as const },
        },
      ],
    });
    const createFinishedJob = (jobId: string, imported: boolean) => {
      repo.createJob({
        id: jobId,
        instruction: `job ${jobId}`,
        options: DEFAULT_OPTIONS,
      });
      repo.setJobResult({
        jobId,
        status: imported ? "success" : "awaiting_confirmation",
        taskJson: JSON.stringify({ url: `https://example.com/${jobId}` }),
        outputDir: `/tmp/${jobId}`,
      });
      repo.replaceAssets(jobId, buildManifest(jobId, imported));
    };

    createFinishedJob("history-old-import", true);
    createFinishedJob("history-recent-import", true);
    createFinishedJob("history-pending-import", false);

    expect(repo.getJob("history-old-import")?.importCompletedAt).toBeTruthy();
    expect(repo.getJob("history-pending-import")?.importCompletedAt).toBeNull();

    const rawDb = new Database(dbPath);
    rawDb
      .prepare("UPDATE jobs SET import_completed_at = ? WHERE id = ?")
      .run("2026-04-01T00:00:00.000Z", "history-old-import");
    rawDb
      .prepare("UPDATE jobs SET import_completed_at = ? WHERE id = ?")
      .run("2026-04-02T00:00:00.001Z", "history-recent-import");
    rawDb.close();

    expect(
      repo.listImportedJobsReadyForHistory("2026-04-02T00:00:00.000Z").map((job) => job.id),
    ).toEqual(["history-old-import"]);

    repo.replaceAssets("history-old-import", buildManifest("history-old-import", false));
    expect(repo.getJob("history-old-import")?.importCompletedAt).toBeNull();
    expect(
      repo.listImportedJobsReadyForHistory("2026-04-03T00:00:00.000Z").map((job) => job.id),
    ).toEqual(["history-recent-import"]);
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

    repo.setJobResult({
      jobId: "job-dedupe-2",
      status: "success",
      taskJson: JSON.stringify({ url: "https://example.com/pricing" }),
    });
    const cleanedJob = repo.cleanJobFiles("job-dedupe-2");
    const matchesAfterCleanup = repo.findRecentJobsBySourceUrl({
      normalizedUrl: "https://example.com/pricing",
      urlNormalization: rules.urlNormalization,
      limit: 3,
    });
    const archivedSummary = repo
      .listJobs({ archivedOnly: true })
      .items.find((job) => job.id === "job-dedupe-2");

    expect(cleanedJob?.cleanedAt).toBeTruthy();
    expect(cleanedJob?.archivedAt).toBeTruthy();
    expect(repo.getAssets("job-dedupe-2")).toEqual([]);
    expect(matchesAfterCleanup.map((job) => job.id)).toEqual(["job-dedupe-2", "job-dedupe-1"]);
    expect(matchesAfterCleanup[0]?.assetCount).toBe(1);
    expect(archivedSummary).toMatchObject({
      id: "job-dedupe-2",
      assetCount: 1,
      pendingConfirmationCount: 1,
    });
    expect(archivedSummary?.cleanedAt).toBeTruthy();
  });

  it("falls back to instruction url in job summaries when task_json is still empty", () => {
    repo.createJob({
      id: "job-summary-fallback",
      instruction: "open https://example.com/pricing and capture full page",
      options: DEFAULT_OPTIONS,
    });

    const jobs = repo.listJobs({});
    const summary = jobs.items.find((job) => job.id === "job-summary-fallback");

    expect(summary?.sourceUrl).toBe("https://example.com/pricing");
  });
});
