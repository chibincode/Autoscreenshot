import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobsRepository } from "../src/server/db.js";

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
});
