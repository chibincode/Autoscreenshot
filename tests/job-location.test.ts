import { describe, expect, it } from "vitest";
import {
  readSelectedAssetIdFromSearch,
  readSelectedJobIdFromSearch,
  syncSelectionToUrl,
} from "../web/src/job-location.js";

describe("job location helpers", () => {
  it("reads the selected job id from the query string", () => {
    expect(readSelectedJobIdFromSearch("?job=job_123")).toBe("job_123");
    expect(readSelectedJobIdFromSearch("?foo=1&job=job_456")).toBe("job_456");
  });

  it("returns null for a missing or blank job id", () => {
    expect(readSelectedJobIdFromSearch("?job=")).toBeNull();
    expect(readSelectedJobIdFromSearch("?foo=1")).toBeNull();
  });

  it("reads the selected asset id from the query string", () => {
    expect(readSelectedAssetIdFromSearch("?job=job_123&asset=42")).toBe(42);
    expect(readSelectedAssetIdFromSearch("?asset=0")).toBeNull();
    expect(readSelectedAssetIdFromSearch("?asset=abc")).toBeNull();
  });

  it("syncs the selected job id into the current URL", () => {
    expect(syncSelectionToUrl("http://127.0.0.1:8787/", { jobId: "job_789", assetId: null })).toBe(
      "http://127.0.0.1:8787/?job=job_789",
    );
    expect(syncSelectionToUrl("http://127.0.0.1:8787/?page=2", { jobId: "job_789", assetId: 42 })).toBe(
      "http://127.0.0.1:8787/?page=2&job=job_789&asset=42",
    );
    expect(syncSelectionToUrl("http://127.0.0.1:8787/?page=2", { jobId: "job_789", assetId: null })).toBe(
      "http://127.0.0.1:8787/?page=2&job=job_789",
    );
  });

  it("removes the selected job id from the current URL", () => {
    expect(syncSelectionToUrl("http://127.0.0.1:8787/?page=2&job=job_789&asset=42", { jobId: null, assetId: null })).toBe(
      "http://127.0.0.1:8787/?page=2",
    );
  });
});
