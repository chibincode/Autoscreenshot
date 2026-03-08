import { describe, expect, it } from "vitest";
import { canRetryRoute } from "../web/src/route-retry.js";

describe("route retry ui gating", () => {
  it("hides retry for failed routes while the job is still running", () => {
    expect(canRetryRoute("running", "failed")).toBe(false);
  });

  it("shows retry for failed routes after the job reaches a terminal state", () => {
    expect(canRetryRoute("partial_success", "failed")).toBe(true);
  });

  it("hides retry for non-failed routes even after the job is terminal", () => {
    expect(canRetryRoute("partial_success", "success")).toBe(false);
    expect(canRetryRoute("failed", "queued")).toBe(false);
    expect(canRetryRoute("success", "running")).toBe(false);
    expect(canRetryRoute("cancelled", "skipped")).toBe(false);
  });
});
