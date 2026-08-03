import { describe, expect, it } from "vitest";
import { DESIGN_SYSTEM_SECTIONS } from "../web/src/design-system/sectionRegistry.js";

describe("design system section registry", () => {
  it("keeps the async action handoff discoverable beside component states", () => {
    const sectionIds = DESIGN_SYSTEM_SECTIONS.map((section) => section.id);

    expect(sectionIds).toContain("buttons");
    expect(sectionIds).toContain("async-flow");
    expect(sectionIds.indexOf("async-flow")).toBe(sectionIds.indexOf("buttons") + 1);
  });
});
