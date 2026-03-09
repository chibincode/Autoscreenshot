import { describe, expect, it } from "vitest";
import {
  buildFixedSectionClip,
  FIXED_SECTION_CLIP_HEIGHT,
  FIXED_SECTION_CLIP_WIDTH,
} from "../src/browser/section-clip.js";
import type { SectionResult } from "../src/types.js";

function makeSection(
  x: number,
  y: number,
  width: number,
  height: number,
  sectionType: SectionResult["sectionType"] = "feature",
): SectionResult {
  return {
    sectionType,
    selector: "#feature",
    confidence: 1,
    bbox: { x, y, width, height },
  };
}

describe("buildFixedSectionClip", () => {
  it("returns a fixed 1920x1080 clip centered around the candidate", () => {
    const clip = buildFixedSectionClip(makeSection(640, 2400, 640, 320), {
      width: 1920,
      height: 6400,
    });

    expect(clip.width).toBe(FIXED_SECTION_CLIP_WIDTH);
    expect(clip.height).toBe(FIXED_SECTION_CLIP_HEIGHT);
    expect(clip.x).toBe(0);
    expect(clip.y).toBe(2020);
  });

  it("clamps to top edge when candidate center is near top", () => {
    const clip = buildFixedSectionClip(makeSection(400, 20, 320, 120), {
      width: 1920,
      height: 4000,
    });

    expect(clip.width).toBe(FIXED_SECTION_CLIP_WIDTH);
    expect(clip.height).toBe(FIXED_SECTION_CLIP_HEIGHT);
    expect(clip.x).toBe(0);
    expect(clip.y).toBe(0);
  });

  it("anchors hero clips to the first viewport to preserve top navigation", () => {
    const clip = buildFixedSectionClip(makeSection(0, 52, 1920, 1104, "hero"), {
      width: 1920,
      height: 6000,
    });

    expect(clip.width).toBe(FIXED_SECTION_CLIP_WIDTH);
    expect(clip.height).toBe(FIXED_SECTION_CLIP_HEIGHT);
    expect(clip.x).toBe(0);
    expect(clip.y).toBe(0);
  });

  it("keeps below-fold hero clips center-aligned to avoid breaking misclassified sections", () => {
    const clip = buildFixedSectionClip(makeSection(0, 1402, 1920, 1093, "hero"), {
      width: 1920,
      height: 6000,
    });

    expect(clip.width).toBe(FIXED_SECTION_CLIP_WIDTH);
    expect(clip.height).toBe(FIXED_SECTION_CLIP_HEIGHT);
    expect(clip.x).toBe(0);
    expect(clip.y).toBe(1409);
  });

  it("keeps non-hero clips center-aligned even near the top of the page", () => {
    const clip = buildFixedSectionClip(makeSection(0, 52, 1920, 1104, "feature"), {
      width: 1920,
      height: 6000,
    });

    expect(clip.width).toBe(FIXED_SECTION_CLIP_WIDTH);
    expect(clip.height).toBe(FIXED_SECTION_CLIP_HEIGHT);
    expect(clip.x).toBe(0);
    expect(clip.y).toBe(64);
  });

  it("clamps to bottom edge when candidate center is near bottom", () => {
    const clip = buildFixedSectionClip(makeSection(500, 5900, 420, 220), {
      width: 1920,
      height: 6500,
    });

    expect(clip.width).toBe(FIXED_SECTION_CLIP_WIDTH);
    expect(clip.height).toBe(FIXED_SECTION_CLIP_HEIGHT);
    expect(clip.x).toBe(0);
    expect(clip.y).toBe(6500 - FIXED_SECTION_CLIP_HEIGHT);
  });

  it("clamps to horizontal edges when page width is wider than 1920", () => {
    const leftClip = buildFixedSectionClip(makeSection(0, 2400, 120, 120), {
      width: 2400,
      height: 6400,
    });
    const rightClip = buildFixedSectionClip(makeSection(2280, 2400, 120, 120), {
      width: 2400,
      height: 6400,
    });

    expect(leftClip.width).toBe(FIXED_SECTION_CLIP_WIDTH);
    expect(leftClip.x).toBe(0);
    expect(rightClip.width).toBe(FIXED_SECTION_CLIP_WIDTH);
    expect(rightClip.x).toBe(2400 - FIXED_SECTION_CLIP_WIDTH);
  });
});
