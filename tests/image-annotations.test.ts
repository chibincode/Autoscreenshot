import { describe, expect, it } from "vitest";
import { annotationExcerpt, annotationFeedbackText, imagePoint, readAnnotationDraft, regionBetween } from "../web/src/image-annotations.js";

describe("image annotation coordinates", () => {
  it("maps a scrolled, scaled image to original pixels and clamps outside points", () => {
    const bounds = { x: 100, y: -500, width: 600, height: 3000 };
    expect(imagePoint({ x: 400, y: 100 }, bounds, 2400, 12000)).toEqual({ x: 1200, y: 2400 });
    expect(imagePoint({ x: 50, y: 3000 }, bounds, 2400, 12000)).toEqual({ x: 0, y: 12000 });
  });
  it("supports selection in every drag direction", () => {
    expect(regionBetween({ x: 500, y: 900 }, { x: 100, y: 300 })).toEqual({ x: 100, y: 300, width: 400, height: 600 });
  });
  it("keeps excerpts within the image at all edges", () => {
    expect(annotationExcerpt({ x: 0, y: 0, width: 100, height: 50 }, 1000, 2000)).toEqual({ x: 0, y: 0, width: 150, height: 100 });
    expect(annotationExcerpt({ x: 900, y: 1950, width: 100, height: 50 }, 1000, 2000)).toEqual({ x: 850, y: 1900, width: 150, height: 100 });
  });
});

describe("feedback drafts and export text", () => {
  const annotation = { id: "first", region: { x: 10, y: 20, width: 100, height: 200 }, comment: "Repeated navigation" };
  it("rejects invalid drafts and regions outside the current image", () => {
    expect(readAnnotationDraft("broken", 1000, 2000)).toEqual([]);
    expect(readAnnotationDraft(JSON.stringify([null, annotation, { ...annotation, region: { ...annotation.region, y: 1999 } }]), 1000, 2000)).toEqual([annotation]);
  });
  it("retains metadata, original coordinates, and multiline feedback", () => {
    const result = annotationFeedbackText("job_id=test\nUser feedback:", [{ ...annotation, comment: "重复了\nPlease remove it." }], 1000, 2000);
    expect(result).toContain("job_id=test");
    expect(result).toContain("original image pixels, 1000 x 2000");
    expect(result).toContain("1. Region x=10, y=20, width=100, height=200\n重复了\nPlease remove it.");
  });
});
