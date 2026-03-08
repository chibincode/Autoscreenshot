import { describe, expect, it } from "vitest";
import { __testables, scoreCoreRoute, shouldExcludeRoute } from "../src/core/route-discovery.js";

describe("route-discovery", () => {
  it("scores core template routes above generic pages", () => {
    const home = scoreCoreRoute("/", "nav", 0);
    const pricing = scoreCoreRoute("/pricing", "nav", 0);
    const generic = scoreCoreRoute("/random-page", "link", 2);

    expect(home).toBeGreaterThan(pricing);
    expect(pricing).toBeGreaterThan(generic);
  });

  it("applies exclusion rules", () => {
    expect(shouldExcludeRoute("/privacy")).toBe(true);
    expect(shouldExcludeRoute("/search")).toBe(true);
    expect(shouldExcludeRoute("/page/2")).toBe(true);
    expect(shouldExcludeRoute("/assets/guide.pdf")).toBe(true);
    expect(shouldExcludeRoute("/pricing")).toBe(false);
    expect(shouldExcludeRoute("/")).toBe(false);
  });

  it("normalizes same-domain links and drops query/hash", () => {
    const entry = new URL("https://example.com/");
    const helpers = __testables();

    const normalized = helpers.normalizeSameDomainUrl("https://example.com/pricing/?plan=pro#hero", entry);
    expect(normalized).toEqual({
      url: "https://example.com/pricing",
      path: "/pricing",
      hostname: "example.com",
    });

    const external = helpers.normalizeSameDomainUrl("https://other.com/pricing", entry);
    expect(external).toBeNull();

    const brandBlog = helpers.normalizeSameDomainUrl("https://blog.example.com/", entry);
    expect(brandBlog).toEqual({
      url: "https://blog.example.com/",
      path: "/",
      hostname: "blog.example.com",
    });

    const deepSubdomain = helpers.normalizeSameDomainUrl("https://foo.bar.example.com/", entry);
    expect(deepSubdomain).toBeNull();
  });

  it("scores brand blog subdomain as blog instead of home", () => {
    const entry = new URL("https://example.com/");
    const helpers = __testables();

    const sameHostHome = helpers.scoreDiscoveredRoute("https://example.com/", "/", "nav", 0, entry);
    const blogRoot = helpers.scoreDiscoveredRoute("https://blog.example.com/", "/", "link", 1, entry);

    expect(blogRoot).toBeLessThan(sameHostHome);
    expect(blogRoot).toBeGreaterThan(helpers.scoreDiscoveredRoute("https://foo.example.com/", "/", "link", 1, entry));
  });
});
