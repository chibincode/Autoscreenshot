import { describe, expect, it } from "vitest";
import { buildConsoleAssetUrl, buildConsoleJobUrl } from "../extension/src/links.js";

describe("plugin console links", () => {
  it("builds a history link for a job", () => {
    expect(buildConsoleJobUrl("http://127.0.0.1:8787", "job_123")).toBe(
      "http://127.0.0.1:8787/?job=job_123",
    );
  });

  it("builds an eagle-correlated asset link", () => {
    expect(buildConsoleAssetUrl("http://127.0.0.1:8787", { jobId: "job_123", assetId: 42 })).toBe(
      "http://127.0.0.1:8787/?job=job_123&asset=42",
    );
  });
});
