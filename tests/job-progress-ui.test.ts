import { describe, expect, it } from "vitest";
import {
  deriveRouteProgress,
  describeCompletedCoreRoutesStatus,
  isActiveStatus,
} from "../web/src/job-progress.js";

describe("job progress ui helpers", () => {
  it("reports all queued routes", () => {
    const summary = deriveRouteProgress([
      { path: "/", url: "https://example.com/", status: "queued" },
      { path: "/pricing", url: "https://example.com/pricing", status: "queued" },
    ]);

    expect(summary).toMatchObject({
      total: 2,
      done: 0,
      queued: 2,
      running: 0,
      failed: 0,
      success: 0,
      skipped: 0,
      completionRatio: 0,
      currentRouteLabel: null,
    });
  });

  it("reports one running route with completed routes", () => {
    const summary = deriveRouteProgress([
      { path: "/", url: "https://example.com/", status: "success" },
      { path: "/docs", url: "https://example.com/docs", status: "running" },
      { path: "/pricing", url: "https://example.com/pricing", status: "queued" },
    ]);

    expect(summary).toMatchObject({
      total: 3,
      done: 1,
      queued: 1,
      running: 1,
      failed: 0,
      success: 1,
      skipped: 0,
      completionRatio: 1 / 3,
      currentRouteLabel: "/docs",
    });
  });

  it("reports all complete routes", () => {
    const summary = deriveRouteProgress([
      { path: "/", url: "https://example.com/", status: "success" },
      { path: "/about", url: "https://example.com/about", status: "success" },
      { path: "/blog", url: "https://example.com/blog", status: "skipped" },
    ]);

    expect(summary).toMatchObject({
      total: 3,
      done: 3,
      queued: 0,
      running: 0,
      failed: 0,
      success: 2,
      skipped: 1,
      completionRatio: 1,
      currentRouteLabel: null,
    });
  });

  it("reports failed mixed with success", () => {
    const summary = deriveRouteProgress([
      { path: "/", url: "https://example.com/", status: "failed" },
      { path: "/about", url: "https://example.com/about", status: "success" },
      { path: "/blog", url: "https://example.com/blog", status: "queued" },
    ]);

    expect(summary).toMatchObject({
      total: 3,
      done: 2,
      queued: 1,
      running: 0,
      failed: 1,
      success: 1,
      skipped: 0,
      completionRatio: 2 / 3,
      currentRouteLabel: null,
    });
  });

  it("treats only running as active", () => {
    expect(isActiveStatus("running")).toBe(true);
    expect(isActiveStatus("queued")).toBe(false);
    expect(isActiveStatus("success")).toBe(false);
    expect(isActiveStatus("failed")).toBe(false);
    expect(isActiveStatus("partial_success")).toBe(false);
  });

  it("explains partial_success for core-routes as route-level partial completion", () => {
    expect(
      describeCompletedCoreRoutesStatus({
        status: "partial_success",
        routeProgress: {
          total: 8,
          done: 8,
          success: 7,
          failed: 1,
        },
        selectedPending: 7,
        selectedPendingMissingFolderCount: 0,
      }),
    ).toBe("核心路由已完成 · 7 条成功 / 1 条失败 · 当前还没有导入到 Eagle");
  });

  it("explains awaiting_confirmation for core-routes as preselected pending imports", () => {
    expect(
      describeCompletedCoreRoutesStatus({
        status: "awaiting_confirmation",
        routeProgress: {
          total: 3,
          done: 3,
          success: 3,
          failed: 0,
        },
        selectedPending: 3,
        selectedPendingMissingFolderCount: 0,
      }),
    ).toBe("核心路由已完成 · 3 条成功 · 3 张已预选，待确认导入");
  });
});
