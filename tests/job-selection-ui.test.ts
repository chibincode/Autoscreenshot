import { describe, expect, it } from "vitest";
import { getNextSelectedJobId } from "../web/src/job-selection.js";

describe("job selection ui helper", () => {
  it("auto-selects the first job on first load", () => {
    expect(
      getNextSelectedJobId(null, [{ id: "job-newest" }, { id: "job-older" }]),
    ).toBe("job-newest");
  });

  it("preserves manual selection when a newer job appears first", () => {
    expect(
      getNextSelectedJobId("job-older", [
        { id: "job-newest" },
        { id: "job-older" },
        { id: "job-oldest" },
      ]),
    ).toBe("job-older");
  });

  it("falls back to the first visible job when the current selection disappears", () => {
    expect(
      getNextSelectedJobId("job-missing", [{ id: "job-filtered-a" }, { id: "job-filtered-b" }]),
    ).toBe("job-filtered-a");
  });

  it("clears selection when the current page has no jobs", () => {
    expect(getNextSelectedJobId("job-any", [])).toBeNull();
  });
});
