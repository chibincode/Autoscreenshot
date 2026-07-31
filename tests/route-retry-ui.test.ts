import { describe, expect, it } from "vitest";
import { canRerunRoute } from "../web/src/route-retry.js";

describe("route rerun ui gating", () => {
  it("hides route actions while the job is still running", () => {
    expect(canRerunRoute("running", "failed")).toBe(false);
    expect(canRerunRoute("running", "success")).toBe(false);
  });

  it("shows retry and rescan actions after the job reaches a terminal state", () => {
    expect(canRerunRoute("partial_success", "failed")).toBe(true);
    expect(canRerunRoute("partial_success", "success")).toBe(true);
    expect(canRerunRoute("awaiting_confirmation", "success")).toBe(true);
  });

  it("hides route actions for routes that are not complete", () => {
    expect(canRerunRoute("failed", "queued")).toBe(false);
    expect(canRerunRoute("success", "running")).toBe(false);
    expect(canRerunRoute("cancelled", "skipped")).toBe(false);
  });
});
