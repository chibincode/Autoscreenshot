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
  isRetryableCaptureError: (error: unknown) =>
    /retryable|Target page, context or browser has been closed/i.test(String(error)),
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

  it("wires core-routes navigation fallback into discovery and capture logging", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-core-routes-fallback-"));
    const outputDir = path.join(tmpDir, "run");
    const manifestPath = path.join(outputDir, "manifest.json");
    const logs: string[] = [];

    captureTaskMock.mockImplementation(async (_task: unknown, options: any) => {
      options.navigationFallback?.onFallback?.({
        phase: "capture",
        url: "https://example.com/",
        from: "networkidle",
        to: "domcontentloaded",
        errorMessage: "page.goto: Timeout 60000ms exceeded.",
      });
      return {
        assets: [
          {
            kind: "fullPage",
            label: "full_page",
            filePath: path.join(outputDir, "home.jpg"),
            fileName: "home.jpg",
            sourceUrl: "https://example.com/",
            quality: 92,
            dpr: 2,
            capturedAt: new Date().toISOString(),
          },
        ],
      };
    });

    discoverCoreRoutesMock.mockImplementation(async (options: any) => {
      options.onNavigationFallback?.({
        phase: "discovery",
        url: "https://example.com/",
        from: "networkidle",
        to: "domcontentloaded",
        errorMessage: "page.goto: Timeout 75000ms exceeded.",
      });
      return {
        entryUrl: "https://example.com",
        routes: [
          {
            url: "https://example.com/",
            path: "/",
            source: "nav",
            depth: 0,
            priorityScore: 1000,
          },
        ],
      };
    });

    const result = await executeCoreRoutesInstruction({
      instruction: "open https://example.com",
      options: { mode: "core-routes" },
      runId: "job-core-fallback",
      outputDir,
      manifestPath,
      log: (_level, message) => {
        logs.push(message);
      },
    });

    expect(discoverCoreRoutesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        waitUntil: "networkidle",
        onNavigationFallback: expect.any(Function),
      }),
    );
    expect(captureTaskMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        navigationFallback: expect.objectContaining({
          fallbackWaitUntil: "domcontentloaded",
          onFallback: expect.any(Function),
        }),
      }),
    );
    expect(logs).toContain(
      "route_wait_fallback phase=discovery url=https://example.com/ from=networkidle to=domcontentloaded reason=page.goto: Timeout 75000ms exceeded.",
    );
    expect(logs).toContain(
      "route_wait_fallback phase=capture url=https://example.com/ from=networkidle to=domcontentloaded reason=page.goto: Timeout 60000ms exceeded.",
    );
    expect(result.routes[0]?.status).toBe("success");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("prioritizes family coverage before duplicate detail pages", async () => {
    resolveJobOptionsMock.mockReturnValue({
      quality: 92,
      dpr: "auto",
      sectionScope: "classic",
      classicMaxSections: 10,
      mode: "core-routes",
      maxRoutes: 9,
      outputDir: "./output",
    });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-core-routes-limits-"));
    const outputDir = path.join(tmpDir, "run");
    const manifestPath = path.join(outputDir, "manifest.json");
    const logs: string[] = [];

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
          url: "https://example.com/?duplicate-home=1",
          path: "/",
          source: "link",
          depth: 1,
          priorityScore: 990,
        },
        {
          url: "https://example.com/solutions",
          path: "/solutions",
          source: "nav",
          depth: 0,
          priorityScore: 995,
        },
        {
          url: "https://example.com/solutions/robotics",
          path: "/solutions/robotics",
          source: "link",
          depth: 1,
          priorityScore: 992,
        },
        {
          url: "https://example.com/pricing",
          path: "/pricing",
          source: "nav",
          depth: 0,
          priorityScore: 991,
        },
        {
          url: "https://example.com/use-cases/robotics",
          path: "/use-cases/robotics",
          source: "link",
          depth: 2,
          priorityScore: 980,
        },
        {
          url: "https://example.com/customers/polymath",
          path: "/customers/polymath",
          source: "link",
          depth: 1,
          priorityScore: 970,
        },
        {
          url: "https://example.com/customers",
          path: "/customers",
          source: "nav",
          depth: 0,
          priorityScore: 960,
        },
        {
          url: "https://example.com/use-cases",
          path: "/use-cases",
          source: "nav",
          depth: 0,
          priorityScore: 950,
        },
        {
          url: "https://example.com/contact-sales",
          path: "/contact-sales",
          source: "nav",
          depth: 0,
          priorityScore: 949,
        },
        {
          url: "https://blog.example.com/",
          path: "/",
          source: "nav",
          depth: 0,
          priorityScore: 948,
        },
        {
          url: "https://blog.example.com/post-one",
          path: "/post-one",
          source: "link",
          depth: 1,
          priorityScore: 947,
        },
        {
          url: "https://blog.example.com/post-two",
          path: "/post-two",
          source: "link",
          depth: 1,
          priorityScore: 946,
        },
        {
          url: "https://example.com/about",
          path: "/about",
          source: "link",
          depth: 1,
          priorityScore: 945,
        },
      ],
    });

    captureTaskMock.mockImplementation(async (task: any) => ({
      assets: [
        {
          kind: "fullPage",
          label: "full_page",
          filePath: path.join(outputDir, `${encodeURIComponent(task.url)}.jpg`),
          fileName: `${encodeURIComponent(task.url)}.jpg`,
          sourceUrl: task.url,
          quality: 92,
          dpr: 2,
          capturedAt: new Date().toISOString(),
        },
      ],
    }));

    const result = await executeCoreRoutesInstruction({
      instruction: "open https://example.com",
      options: { mode: "core-routes" },
      runId: "job-core-limits",
      outputDir,
      manifestPath,
      log: (_level, message) => {
        logs.push(message);
      },
    });

    expect(captureTaskMock).toHaveBeenCalledTimes(9);
    expect(result.routes.filter((route) => route.url === "https://example.com/")).toHaveLength(1);
    expect(result.routes.filter((route) => route.path === "/solutions")).toHaveLength(1);
    expect(result.routes.filter((route) => route.path === "/solutions/robotics")).toHaveLength(1);
    expect(result.routes.filter((route) => route.path === "/pricing")).toHaveLength(1);
    expect(result.routes.filter((route) => route.path === "/use-cases/robotics")).toHaveLength(1);
    expect(result.routes.filter((route) => route.path === "/customers/polymath")).toHaveLength(0);
    expect(result.routes.filter((route) => route.path === "/customers")).toHaveLength(1);
    expect(result.routes.filter((route) => route.path === "/contact-sales")).toHaveLength(1);
    expect(result.routes.filter((route) => route.url === "https://blog.example.com/")).toHaveLength(1);
    expect(result.routes.filter((route) => route.url === "https://blog.example.com/post-one")).toHaveLength(1);
    expect(result.routes.filter((route) => route.url === "https://blog.example.com/post-two")).toHaveLength(0);
    expect(result.routes.filter((route) => route.path === "/about")).toHaveLength(0);
    expect(logs).toContain("core_routes_discovered_raw count=14");
    expect(logs).toContain("core_routes_planned count=9");
    expect(logs).toContain("core_routes_pruned family=blog_detail kept=/post-one pruned=1");
    expect(logs).toContain("core_routes_pruned family=customer_detail kept=/use-cases/robotics pruned=1");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("prunes generic slug families before persisting planned routes", async () => {
    resolveJobOptionsMock.mockReturnValue({
      quality: 92,
      dpr: "auto",
      sectionScope: "classic",
      classicMaxSections: 10,
      mode: "core-routes",
      maxRoutes: 6,
      outputDir: "./output",
    });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-core-routes-generic-"));
    const outputDir = path.join(tmpDir, "run");
    const manifestPath = path.join(outputDir, "manifest.json");
    const discoveredSnapshots: Array<Array<{ path: string; url: string }>> = [];
    const logs: string[] = [];

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
          priorityScore: 990,
        },
        {
          url: "https://example.com/learn/alpha",
          path: "/learn/alpha",
          source: "link",
          depth: 1,
          priorityScore: 980,
        },
        {
          url: "https://example.com/learn/beta",
          path: "/learn/beta",
          source: "link",
          depth: 1,
          priorityScore: 970,
        },
        {
          url: "https://example.com/learn/gamma",
          path: "/learn/gamma",
          source: "link",
          depth: 1,
          priorityScore: 960,
        },
      ],
    });

    captureTaskMock.mockImplementation(async (task: any) => ({
      assets: [
        {
          kind: "fullPage",
          label: "full_page",
          filePath: path.join(outputDir, `${encodeURIComponent(task.url)}.jpg`),
          fileName: `${encodeURIComponent(task.url)}.jpg`,
          sourceUrl: task.url,
          quality: 92,
          dpr: 2,
          capturedAt: new Date().toISOString(),
        },
      ],
    }));

    const result = await executeCoreRoutesInstruction({
      instruction: "open https://example.com",
      options: { mode: "core-routes" },
      runId: "job-core-generic",
      outputDir,
      manifestPath,
      log: (_level, message) => {
        logs.push(message);
      },
      onRoutesDiscovered: (routes) => {
        discoveredSnapshots.push(routes.map((route) => ({ path: route.path, url: route.url })));
      },
    });

    expect(discoveredSnapshots).toHaveLength(1);
    expect(discoveredSnapshots[0]?.filter((route) => route.path.startsWith("/learn/"))).toHaveLength(1);
    expect(result.routes.filter((route) => route.path.startsWith("/learn/"))).toHaveLength(1);
    expect(logs).toContain("core_routes_pruned family=example.com/learn kept=/learn/alpha pruned=2");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("retries a route once after browser crash and keeps the route successful", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-core-routes-crash-"));
    const outputDir = path.join(tmpDir, "run");
    const manifestPath = path.join(outputDir, "manifest.json");
    const logs: string[] = [];

    captureTaskMock
      .mockRejectedValueOnce(
        new Error("browserContext.close: Target page, context or browser has been closed"),
      )
      .mockRejectedValueOnce(
        new Error("browserContext.close: Target page, context or browser has been closed"),
      )
      .mockResolvedValueOnce({
        assets: [
          {
            kind: "fullPage",
            label: "full_page",
            filePath: path.join(outputDir, "home.jpg"),
            fileName: "home.jpg",
            sourceUrl: "https://example.com/",
            quality: 92,
            dpr: 2,
            capturedAt: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({
        assets: [
          {
            kind: "fullPage",
            label: "full_page",
            filePath: path.join(outputDir, "pricing.jpg"),
            fileName: "pricing.jpg",
            sourceUrl: "https://example.com/pricing",
            quality: 92,
            dpr: 2,
            capturedAt: new Date().toISOString(),
          },
        ],
      });

    const result = await executeCoreRoutesInstruction({
      instruction: "open https://example.com",
      options: { mode: "core-routes" },
      runId: "job-core-crash-retry",
      outputDir,
      manifestPath,
      log: (_level, message) => {
        logs.push(message);
      },
    });

    expect(captureTaskMock).toHaveBeenCalledTimes(4);
    expect(result.routes.map((route) => route.status)).toEqual(["success", "success"]);
    expect(result.routes[0]?.attemptCount).toBe(3);
    expect(logs.some((message) => message.includes("route_retry_crash path=/"))).toBe(true);
    expect(logs.some((message) => message.includes("route_retry_success path=/"))).toBe(true);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("stops scheduling remaining routes after cancellation is requested", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoscreenshot-core-routes-cancel-"));
    const outputDir = path.join(tmpDir, "run");
    const manifestPath = path.join(outputDir, "manifest.json");
    const routeUpdates: Array<{ path: string; status: string; error?: string }> = [];
    let shouldCancel = false;

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
        {
          url: "https://example.com/contact",
          path: "/contact",
          source: "nav",
          depth: 0,
          priorityScore: 800,
        },
      ],
    });

    captureTaskMock.mockImplementation(async (task: any) => {
      shouldCancel = task.url === "https://example.com/";
      return {
        assets: [
          {
            kind: "fullPage",
            label: "full_page",
            filePath: path.join(outputDir, `${new URL(task.url).pathname.replace(/\W+/g, "_") || "home"}.jpg`),
            fileName: "captured.jpg",
            sourceUrl: task.url,
            quality: 92,
            dpr: 2,
            capturedAt: new Date().toISOString(),
          },
        ],
      };
    });

    const result = await executeCoreRoutesInstruction({
      instruction: "open https://example.com",
      options: { mode: "core-routes" },
      runId: "job-core-cancel",
      outputDir,
      manifestPath,
      shouldCancel: () => shouldCancel,
      onRouteStatus: async (update) => {
        routeUpdates.push({
          path: update.route.path,
          status: update.status,
          error: update.error,
        });
      },
    });

    expect(result.cancelled).toBe(true);
    expect(result.routes.map((route) => route.status)).toEqual(["success", "skipped", "skipped"]);
    expect(result.routes[1]?.error).toBe("Cancelled by user");
    expect(result.routes[2]?.error).toBe("Cancelled by user");
    expect(routeUpdates.some((update) => update.path === "/pricing" && update.status === "skipped")).toBe(true);
    expect(routeUpdates.some((update) => update.path === "/contact" && update.status === "skipped")).toBe(true);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
