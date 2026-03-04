import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureTask, isRetryableCaptureError, resolveDpr } from "../src/browser/capture.js";
import type { ParsedTask } from "../src/types.js";

let server: http.Server | null = null;
let baseUrl = "";

function pageTemplate(kind: "marketing" | "blog" | "docs" | "landing"): string {
  if (kind === "marketing") {
    return `
      <html><body>
      <main>
        <section class="hero"><h1>Build faster</h1><button>Start</button></section>
        <section class="features"><h2>Features</h2><p>Feature A</p><p>Feature B</p></section>
        <section class="testimonials"><h2>Testimonials</h2><blockquote>"Great!"</blockquote></section>
        <section class="pricing"><h2>Pricing</h2><p>$29 / month</p></section>
      </main>
      <footer>Privacy Terms Copyright</footer>
      <style>
      body { margin:0; font-family: sans-serif; }
      section, footer { min-height: 560px; padding: 48px; border-bottom: 1px solid #ddd; }
      .hero { background: #f5f7ff; }
      </style>
      </body></html>
    `;
  }
  if (kind === "blog") {
    return `
      <html><body>
      <main>
        <section class="hero"><h1>Blog Home</h1></section>
        <section class="blog-posts"><h2>Latest Posts</h2><a href="#">Post 1</a><a href="#">Post 2</a><a href="#">Post 3</a></section>
        <section class="faq"><h2>FAQ</h2><p>Question?</p><p>Answer.</p></section>
      </main>
      <footer>footer area</footer>
      <style>section, footer { min-height: 520px; padding: 40px; border-bottom: 1px solid #ddd; }</style>
      </body></html>
    `;
  }
  if (kind === "landing") {
    return `
      <html><body>
      <main>
        <section class="hero"><h1>Grow faster</h1><button>Get started</button></section>
        <section class="team"><h2>Our Team</h2><img alt="m1"/><img alt="m2"/><img alt="m3"/><p>Founder · CEO</p></section>
        <section class="cta"><h2>Ready to launch?</h2><button>Book demo</button><button>Try free</button></section>
        <section class="contact"><h2>Contact us</h2><form><input /><input /><textarea></textarea></form><a href="mailto:hi@example.com">Email</a></section>
      </main>
      <footer>Privacy · Terms · Copyright</footer>
      <style>
      body { margin: 0; font-family: sans-serif; }
      section, footer { min-height: 520px; padding: 40px; border-bottom: 1px solid #ddd; }
      </style>
      </body></html>
    `;
  }
  return `
    <html><body>
    <main>
      <section class="hero"><h1>Docs</h1></section>
      <article class="feature"><h2>Feature Overview</h2></article>
      <section class="faq"><h2>FAQ</h2><p>Question?</p><p>Another question?</p></section>
    </main>
    <footer>documentation footer</footer>
    <style>section, article, footer { min-height: 520px; padding: 40px; border-bottom: 1px solid #ddd; }</style>
    </body></html>
  `;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = req.url ?? "/";
    if (pathname.startsWith("/marketing")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageTemplate("marketing"));
      return;
    }
    if (pathname.startsWith("/blog")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageTemplate("blog"));
      return;
    }
    if (pathname.startsWith("/landing")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageTemplate("landing"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pageTemplate("docs"));
  });

  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server!.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

describe("capture utils", () => {
  it("falls back dpr when page pixels exceed threshold", () => {
    expect(resolveDpr("auto", 10000, 4000)).toBe(1);
    expect(resolveDpr("auto", 1600, 2200)).toBe(2);
    expect(resolveDpr(2, 10000, 4000)).toBe(2);
  });

  it("marks crash and timeout as retryable", () => {
    expect(isRetryableCaptureError(new Error("Target crashed unexpectedly"))).toBe(true);
    expect(isRetryableCaptureError(new Error("navigation timeout"))).toBe(true);
    expect(isRetryableCaptureError(new Error("selector not found"))).toBe(false);
  });
});

describe.runIf(process.env.RUN_E2E_CAPTURE === "1")("capture e2e", () => {
  async function runCase(pathname: string) {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-"));
    const task: ParsedTask = {
      url: `${baseUrl}${pathname}`,
      waitUntil: "networkidle",
      captures: [{ mode: "fullPage" }, { mode: "section" }],
      image: { format: "jpg", quality: 92, dpr: "auto" },
      viewport: { width: 1440, height: 900 },
      tags: ["e2e"],
      eagle: {},
    };

    const result = await captureTask(task, {
      outputDir,
      sectionScope: "classic",
      classicMaxSections: 10,
    });

    const fullPageCount = result.assets.filter((asset) => asset.kind === "fullPage").length;
    const sectionCount = result.assets.filter((asset) => asset.kind === "section").length;
    expect(fullPageCount).toBe(1);
    expect(sectionCount).toBeGreaterThanOrEqual(3);
  }

  it("captures marketing page", async () => {
    await runCase("/marketing");
  });

  it("captures blog page", async () => {
    await runCase("/blog");
  });

  it("captures docs page", async () => {
    await runCase("/docs");
  });

  it("captures landing page with at least one new section type", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-landing-"));
    const task: ParsedTask = {
      url: `${baseUrl}/landing`,
      waitUntil: "networkidle",
      captures: [{ mode: "fullPage" }, { mode: "section" }],
      image: { format: "jpg", quality: 92, dpr: "auto" },
      viewport: { width: 1440, height: 900 },
      tags: ["e2e"],
      eagle: {},
    };

    const result = await captureTask(task, {
      outputDir,
      sectionScope: "classic",
      classicMaxSections: 10,
    });

    const sectionTypes = new Set(
      result.assets
        .filter((asset) => asset.kind === "section")
        .map((asset) => asset.sectionType),
    );
    const hasNewType =
      sectionTypes.has("team") || sectionTypes.has("cta") || sectionTypes.has("contact");
    expect(hasNewType).toBe(true);
  });
});
