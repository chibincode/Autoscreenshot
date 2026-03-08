import { describe, expect, it } from "vitest";
import { classifyFullPageType } from "../src/core/fullpage-classifier.js";
import { normalizeEagleFolderRules } from "../src/core/eagle-folder-rules.js";

const rules = normalizeEagleFolderRules({
  fullPage: {
    home: { folderId: "home-id", pathRules: ["/"] },
    pricing: { folderId: "pricing-id", pathRules: ["/pricing"] },
    about: { folderId: "about-id", pathRules: ["/about", "/about-us", "/company", "/team"] },
    careers: { folderId: "careers-id", pathRules: ["/careers"] },
    contact: { folderId: "contact-id", pathRules: ["/contact", "/contact-sales", "/demo", "/book-demo"] },
    customers_list: { folderId: "customers-list-id", pathRules: ["/customers", "/use-cases"] },
    customer_detail: {
      folderId: "customer-detail-id",
      pathRules: ["/customers/:slug", "/use-cases/:slug"],
    },
    products_list: {
      folderId: "products-list-id",
      pathRules: ["/product", "/products", "/feature", "/features", "/solutions"],
    },
    product_detail: {
      folderId: "product-detail-id",
      pathRules: [
        "/products/:slug",
        "/product/:slug",
        "/features/:slug",
        "/feature/:slug",
        "/solutions/:slug",
      ],
    },
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

  it("matches about-us/company/team variants to about", () => {
    expect(classifyFullPageType("https://example.com/about-us", rules).type).toBe("about");
    expect(classifyFullPageType("https://example.com/company", rules).type).toBe("about");
    expect(classifyFullPageType("https://example.com/team", rules).type).toBe("about");
  });

  it("strictly distinguishes blog list and detail", () => {
    expect(classifyFullPageType("https://example.com/blog", rules).type).toBe("blog_list");
    expect(classifyFullPageType("https://example.com/blog/page/2", rules).type).toBe("blog_list");
    expect(classifyFullPageType("https://example.com/blog/tag/design", rules).type).toBe("blog_list");
    expect(classifyFullPageType("https://example.com/blog/how-to-build", rules).type).toBe("blog_detail");
    expect(classifyFullPageType("https://blog.example.com/", rules).type).toBe("blog_list");
    expect(classifyFullPageType("https://blog.example.com/how-to-build", rules).type).toBe(
      "blog_detail",
    );
  });

  it("classifies customers overview and detail pages", () => {
    expect(classifyFullPageType("https://example.com/customers", rules).type).toBe("customers_list");
    expect(classifyFullPageType("https://example.com/use-cases", rules).type).toBe("customers_list");
    expect(classifyFullPageType("https://example.com/customers/polymath", rules).type).toBe(
      "customer_detail",
    );
    expect(classifyFullPageType("https://example.com/use-cases/robotics", rules).type).toBe(
      "customer_detail",
    );
  });

  it("classifies contact and product/solutions pages", () => {
    expect(classifyFullPageType("https://example.com/contact-sales", rules).type).toBe("contact");
    expect(classifyFullPageType("https://example.com/solutions", rules).type).toBe("products_list");
    expect(classifyFullPageType("https://example.com/solutions/robotics", rules).type).toBe(
      "product_detail",
    );
  });

  it("returns unmatched when no rule matches", () => {
    const result = classifyFullPageType("https://example.com/docs/getting-started", rules);
    expect(result.type).toBe("unmatched");
  });
});
