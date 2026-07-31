import { describe, expect, it } from "vitest";
import { resolveAppSurface } from "../web/src/app-route.js";

describe("app surface routing", () => {
  it("routes the design system path without introducing a router dependency", () => {
    expect(resolveAppSurface("/design-system")).toBe("design-system");
    expect(resolveAppSurface("/design-system/")).toBe("design-system");
  });

  it("keeps all other paths on the production console", () => {
    expect(resolveAppSurface("/")).toBe("console");
    expect(resolveAppSurface("/jobs/123")).toBe("console");
    expect(resolveAppSurface("/design-system-preview")).toBe("console");
  });
});
