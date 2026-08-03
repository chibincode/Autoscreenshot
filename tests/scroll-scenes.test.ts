import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  filterDistinctSceneFrames,
  isValidScrollSceneCandidate,
  replaceImageRegions,
  resolveScrollSceneCaptureBounds,
  sampleSceneScrollPositions,
  stackSceneFrames,
} from "../src/browser/scroll-scenes.js";

async function solidPng(width: number, height: number, color: { r: number; g: number; b: number }) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { ...color, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

describe("scroll scene helpers", () => {
  it("accepts tall sections with a large sticky viewport and rejects sticky headers", () => {
    expect(
      isValidScrollSceneCandidate({
        outerHeight: 3000,
        outerWidth: 1200,
        stickyHeight: 580,
        stickyWidth: 1000,
        viewportHeight: 1080,
      }),
    ).toBe(true);

    expect(
      isValidScrollSceneCandidate({
        outerHeight: 1200,
        outerWidth: 1200,
        stickyHeight: 80,
        stickyWidth: 1200,
        viewportHeight: 1080,
      }),
    ).toBe(false);
  });

  it("rejects a compact sticky sidebar inside long page content", () => {
    const compactSidebar = {
      outerHeight: 6684,
      outerWidth: 1192,
      stickyHeight: 380,
      stickyWidth: 384,
      viewportHeight: 1080,
    };

    expect(isValidScrollSceneCandidate(compactSidebar)).toBe(false);
    expect(isValidScrollSceneCandidate({ ...compactSidebar, splitLayout: true })).toBe(true);
  });

  it("samples deterministic scene scroll positions", () => {
    expect(
      sampleSceneScrollPositions({
        outerTop: 3000,
        outerHeight: 3600,
        stickyHeight: 600,
        viewportHeight: 1080,
        documentHeight: 12000,
      }),
    ).toEqual([3000, 4000, 5000, 6000]);
  });

  it("preserves large intro content before a delayed sticky scene", () => {
    expect(
      resolveScrollSceneCaptureBounds({
        outerTop: 0,
        outerHeight: 8144,
        stickyTop: 2654,
        stickyHeight: 1080,
        splitLayout: false,
        viewportHeight: 1080,
      }),
    ).toEqual({
      outerTop: 2654,
      outerHeight: 5490,
      preservedIntroHeight: 2654,
    });

    expect(
      resolveScrollSceneCaptureBounds({
        outerTop: 720,
        outerHeight: 4200,
        stickyTop: 800,
        stickyHeight: 520,
        splitLayout: false,
        viewportHeight: 1080,
      }),
    ).toEqual({
      outerTop: 720,
      outerHeight: 4200,
      preservedIntroHeight: 0,
    });
  });

  it("drops adjacent frames that are visually identical", async () => {
    const sameA = await solidPng(120, 80, { r: 255, g: 0, b: 0 });
    const sameB = await solidPng(120, 80, { r: 255, g: 0, b: 0 });
    const different = await solidPng(120, 80, { r: 0, g: 0, b: 255 });

    const distinct = await filterDistinctSceneFrames([
      { buffer: sameA, scrollY: 0 },
      { buffer: sameB, scrollY: 1 },
      { buffer: different, scrollY: 2 },
    ]);

    expect(distinct).toHaveLength(2);
    expect(distinct[0].scrollY).toBe(0);
    expect(distinct[1].scrollY).toBe(2);
  });

  it("keeps frames distinct when hue changes but brightness stays close", async () => {
    const red = await solidPng(120, 80, { r: 255, g: 0, b: 0 });
    const greenWithSimilarLuma = await solidPng(120, 80, { r: 0, g: 130, b: 0 });

    const distinct = await filterDistinctSceneFrames([
      { buffer: red, scrollY: 0 },
      { buffer: greenWithSimilarLuma, scrollY: 1 },
    ]);

    expect(distinct).toHaveLength(2);
    expect(distinct[0].scrollY).toBe(0);
    expect(distinct[1].scrollY).toBe(1);
  });

  it("replaces a tall region with a shorter stacked composite", async () => {
    const top = await solidPng(100, 20, { r: 255, g: 0, b: 0 });
    const middle = await solidPng(100, 50, { r: 0, g: 255, b: 0 });
    const bottom = await solidPng(100, 30, { r: 0, g: 0, b: 255 });
    const base = await stackSceneFrames({
      width: 100,
      frames: [top, middle, bottom],
      gap: 0,
    });

    const replacement = await stackSceneFrames({
      width: 100,
      frames: [
        await solidPng(100, 15, { r: 255, g: 255, b: 0 }),
        await solidPng(100, 15, { r: 255, g: 0, b: 255 }),
      ],
      gap: 0,
    });

    const output = await replaceImageRegions(base, [
      {
        top: 20,
        height: 50,
        replacement,
      },
    ]);

    const metadata = await sharp(output).metadata();
    expect(metadata.height).toBe(80);

    const sample = await sharp(output)
      .extract({ left: 50, top: 30, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(sample[0]).toBeGreaterThan(200);
    expect(sample[1]).toBeGreaterThan(200);
  });
});
