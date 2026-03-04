import { describe, expect, it } from "vitest";
import { parseInstruction } from "../src/ai/intent-parser.js";

describe("parseInstruction", () => {
  it("maps instruction to jpg quality and dpr", async () => {
    const task = await parseInstruction(
      "打开 https://example.com 抓整页和section，quality:95，retina",
      {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
      },
    );
    expect(task.url).toBe("https://example.com");
    expect(task.image.format).toBe("jpg");
    expect(task.image.quality).toBe(95);
    expect(task.image.dpr).toBe(2);
    expect(task.captures.some((item) => item.mode === "fullPage")).toBe(true);
    expect(task.captures.some((item) => item.mode === "section")).toBe(true);
  });

  it("supports manual section targets", async () => {
    const task = await parseInstruction(
      "截图 https://example.com 的 hero 和 testimonial",
      {
        quality: 92,
        dpr: "auto",
        sectionScope: "manual",
      },
    );
    const sectionTargets = task.captures
      .filter((item) => item.mode === "section")
      .map((item) => item.targetType);
    expect(sectionTargets).toContain("hero");
    expect(sectionTargets).toContain("testimonial");
  });

  it("supports new manual section targets team/cta/contact", async () => {
    const task = await parseInstruction(
      "截图 https://example.com 的 team、cta 和 contact",
      {
        quality: 92,
        dpr: "auto",
        sectionScope: "manual",
      },
    );
    const sectionTargets = task.captures
      .filter((item) => item.mode === "section")
      .map((item) => item.targetType);
    expect(sectionTargets).toContain("team");
    expect(sectionTargets).toContain("cta");
    expect(sectionTargets).toContain("contact");
  });

  it("uses 1920x1080 as default desktop viewport", async () => {
    const task = await parseInstruction(
      "open https://example.com full page",
      {
        quality: 92,
        dpr: "auto",
        sectionScope: "classic",
      },
    );
    expect(task.viewport).toEqual({ width: 1920, height: 1080 });
  });
});
