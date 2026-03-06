import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  parseInstructionMock,
  captureTaskMock,
  discoverCoreRoutesMock,
  importManifestAssetsMock,
  resolveJobOptionsMock,
} = vi.hoisted(() => ({
  parseInstructionMock: vi.fn(),
  captureTaskMock: vi.fn(),
  discoverCoreRoutesMock: vi.fn(),
  importManifestAssetsMock: vi.fn(),
  resolveJobOptionsMock: vi.fn(),
}));

vi.mock("../src/ai/intent-parser.js", () => ({
  parseInstruction: parseInstructionMock,
}));

vi.mock("../src/browser/capture.js", () => ({
  captureTask: captureTaskMock,
  isRetryableCaptureError: (error: unknown) => String(error).includes("retryable"),
}));

vi.mock("../src/core/route-discovery.js", () => ({
  discoverCoreRoutes: discoverCoreRoutesMock,
}));

vi.mock("../src/core/job-service.js", () => ({
  importManifestAssets: importManifestAssetsMock,
  resolveJobOptions: resolveJobOptionsMock,
}));

import { executeCoreRoutesInstruction } from "../src/core/core-routes-service.js";

describe("core-routes-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveJobOptionsMock.mockReturnValue({
      quality: 92,
      dpr: "auto",
      sectionScope: "classic",
      classicMaxSections: 10,
      mode: "core-routes",
      maxRoutes: 12,
      outputDir: "./output",
    });
    parseInstructionMock.mockResolvedValue({
      url: "https://example.com",
      waitUntil: "networkidle",
      captures: [{ mode: "fullPage" }, { mode: "section" }],
      image: { format: "jpg", quality: 92, dpr: "auto" },
      viewport: { width: 1440, height: 900 },
      tags: ["site"],
      eagle: {},
    });
    discoverCoreRoutesMock.mockResolvedValue({
      entryUrl: "https://example.com",
      routes: [
        {
          url: "https://example.com/",
          path: "/",
          source: "nav",
          depth: 0,
          priorityScore: 1000,
        },
        {
          url: "https://example.com/pricing",
          path: "/pricing",
          source: "nav",
          depth: 0,
          priorityScore: 900,
        },
      ],
    });
    importManifestAssetsMock.mockImplementation(async (manifest: unknown) => manifest);
  });

  it("retries route with dpr=1 after retryable failure and keeps per-route status", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-core-routes-"));
    const outputDir = path.join(tmpDir, "run");
    const manifestPath = path.join(outputDir, "manifest.json");

    captureTaskMock
      .mockRejectedValueOnce(new Error("retryable timeout"))
      .mockResolvedValueOnce({
        assets: [
          {
            kind: "fullPage",
            label: "full_page",
            filePath: path.join(outputDir, "home.jpg"),
            fileName: "home.jpg",
            sourceUrl: "https://example.com/",
            quality: 92,
            dpr: 1,
            capturedAt: new Date().toISOString(),
          },
        ],
      })
      .mockRejectedValueOnce(new Error("fatal"));

    const result = await executeCoreRoutesInstruction({
      instruction: "open https://example.com",
      options: { mode: "core-routes" },
      runId: "job-core-1",
      outputDir,
      manifestPath,
    });

    expect(captureTaskMock).toHaveBeenCalledTimes(3);
    expect(captureTaskMock.mock.calls[0][0].image.dpr).toBe(2);
    expect(captureTaskMock.mock.calls[1][0].image.dpr).toBe(1);
    expect(result.fallbackRoutes).toBe(1);
    expect(result.routes.map((route) => route.status)).toEqual(["success", "failed"]);
    expect(result.manifest.assets.length).toBe(1);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
