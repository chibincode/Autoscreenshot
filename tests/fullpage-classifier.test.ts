import { describe, expect, it } from "vitest";
import { classifyFullPageType } from "../src/core/fullpage-classifier.js";
import { normalizeEagleFolderRules } from "../src/core/eagle-folder-rules.js";

const rules = normalizeEagleFolderRules({
  fullPage: {
    home: { folderId: "home-id", pathRules: ["/"] },
    pricing: { folderId: "pricing-id", pathRules: ["/pricing"] },
    about: { folderId: "about-id", pathRules: ["/about"] },
    careers: { folderId: "careers-id", pathRules: ["/careers"] },
    blog_list: { folderId: "blog-list-id", pathRules: ["/blog", "/blog/page/*", "/blog/tag/*"] },
    blog_detail: { folderId: "blog-detail-id", pathRules: ["/blog/:slug"] },
  },
});

describe("classifyFullPageType", () => {
  it("classifies root path as home", () => {
    const result = classifyFullPageType("https://example.com/", rules);
    expect(result.type).toBe("home");
    expect(result.normalizedPathname).toBe("/");
  });

  it("ignores query and hash for matching", () => {
    const result = classifyFullPageType("https://example.com/pricing?ref=abc#top", rules);
    expect(result.type).toBe("pricing");
    expect(result.normalizedPathname).toBe("/pricing");
  });

  it("strips locale prefix before matching", () => {
    const result = classifyFullPageType("https://example.com/en/about", rules);
    expect(result.type).toBe("about");
    expect(result.normalizedPathname).toBe("/about");
  });

  it("strictly distinguishes blog list and detail", () => {
    expect(classifyFullPageType("https://example.com/blog", rules).type).toBe("blog_list");
    expect(classifyFullPageType("https://example.com/blog/page/2", rules).type).toBe("blog_list");
    expect(classifyFullPageType("https://example.com/blog/tag/design", rules).type).toBe("blog_list");
    expect(classifyFullPageType("https://example.com/blog/how-to-build", rules).type).toBe("blog_detail");
  });

  it("returns unmatched when no rule matches", () => {
    const result = classifyFullPageType("https://example.com/docs/getting-started", rules);
    expect(result.type).toBe("unmatched");
  });
});
