import { describe, expect, it } from "vitest";
import { minimapDrag, minimapGeometry, minimapJump, type MinimapMetrics } from "../web/src/image-minimap.js";

const metrics: MinimapMetrics = { scrollTop: 0, scrollHeight: 4040, viewportHeight: 600, imageTop: 20, imageHeight: 4000 };

describe("screenshot minimap", () => {
  it("preserves screenshot proportions and caps the overview to the viewport", () => {
    const map = minimapGeometry(metrics, 1000, 4000)!;
    expect(map.height).toBe(360);
    expect(map.width).toBe(90);
    expect(map.indicatorTop).toBe(0);
    expect(map.indicatorHeight).toBeCloseTo(52.2);
  });
  it("tracks the visible image after scrolling, including outer padding", () => {
    const middle = minimapGeometry({ ...metrics, scrollTop: 1020 }, 1000, 4000)!;
    expect(middle.indicatorTop).toBe(90);
    expect(middle.indicatorHeight).toBe(54);
    const end = minimapGeometry({ ...metrics, scrollTop: 3440 }, 1000, 4000)!;
    expect(end.indicatorTop + end.indicatorHeight).toBeCloseTo(end.height);
  });
  it("centers click navigation and clamps both ends", () => {
    expect(minimapJump(180, 360, metrics)).toBe(1720);
    expect(minimapJump(-50, 360, metrics)).toBe(0);
    expect(minimapJump(500, 360, metrics)).toBe(3440);
  });
  it("preserves the grab offset during dragging and supports dragging beyond the map", () => {
    expect(minimapDrag(90, 1020, 360, metrics)).toBe(2020);
    expect(minimapDrag(-500, 1020, 360, metrics)).toBe(0);
    expect(minimapDrag(500, 1020, 360, metrics)).toBe(3440);
  });
  it("hides for short images or unmeasured content", () => {
    expect(minimapGeometry({ ...metrics, scrollHeight: 500 }, 1000, 400)).toBeNull();
    expect(minimapGeometry({ ...metrics, imageHeight: 0 }, 1000, 4000)).toBeNull();
    expect(minimapGeometry(metrics, 0, 4000)).toBeNull();
  });
  it("keeps the indicator within the map for extremely long screenshots and after resizing", () => {
    const map = minimapGeometry({ ...metrics, imageHeight: 100000, scrollHeight: 100040,
      scrollTop: 99440, viewportHeight: 600 }, 1000, 100000)!;
    expect(map.indicatorHeight).toBe(8);
    expect(map.indicatorTop + map.indicatorHeight).toBe(map.height);
    expect(map.width).toBe(44);
    expect(minimapGeometry({ ...metrics, viewportHeight: 300 }, 1000, 4000)?.height).toBe(180);
  });
});
