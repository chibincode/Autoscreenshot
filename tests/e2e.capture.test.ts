import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { chromium } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captureTask,
  isRetryableCaptureError,
  resolveDpr,
  stabilizeFullPageViewport,
} from "../src/browser/capture.js";
import type { ParsedTask } from "../src/types.js";

let server: http.Server | null = null;
let baseUrl = "";

async function readJpegDimensions(filePath: string): Promise<{ width: number; height: number }> {
  const buffer = await fs.readFile(filePath);
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error(`Not a valid JPEG file: ${filePath}`);
  }

  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;

    if (marker === 0xd8 || marker === 0x01) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }

    if (offset + 2 > buffer.length) {
      break;
    }
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      break;
    }

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return { width, height };
    }

    offset += segmentLength;
  }

  throw new Error(`Unable to parse JPEG dimensions: ${filePath}`);
}

function pageTemplate(kind: "marketing" | "blog" | "docs" | "landing"): string {
  if (kind === "marketing") {
    return `
      <html><head><title>Marketing Page</title></head><body>
      <main>
        <section class="hero"><h1>Build faster</h1><button>Start</button></section>
        <section class="features feature-group-1"><h2>Features</h2><p>Feature A</p><p>Feature B</p></section>
        <section class="features feature-group-2"><h2>More Features</h2><p>Feature C</p><p>Feature D</p></section>
        <section class="features feature-group-3"><h2>Advanced Features</h2><p>Feature E</p><p>Feature F</p></section>
        <section class="testimonials"><h2>Testimonials</h2><blockquote>"Great!"</blockquote></section>
        <section class="faq"><h2>F.A.Q</h2><p>Questions & answers</p><p>How does it work?</p><p>Can I cancel?</p></section>
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
      <html><head><title>Relace Blog</title></head><body>
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
      <html><head><title>Launch Faster</title></head><body>
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
    <html><head><title>Docs</title></head><body>
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

function smoothScrollPageTemplate(): string {
  return `
    <html>
      <head>
        <title>Smooth Scroll Page</title>
        <style>
          html, body {
            margin: 0;
            scroll-behavior: smooth;
            font-family: sans-serif;
          }
          header {
            position: sticky;
            top: 0;
            height: 88px;
            display: flex;
            align-items: center;
            padding: 0 32px;
            background: rgba(10, 20, 40, 0.95);
            color: white;
          }
          main {
            min-height: 4200px;
            padding: 32px;
            background: linear-gradient(#eef4ff, #dbe7ff);
          }
        </style>
      </head>
      <body>
        <header>Sticky navigation</header>
        <main>
          <h1>Smooth scroll demo</h1>
          <p>Used to verify fullPage viewport stabilization.</p>
        </main>
      </body>
    </html>
  `;
}

function scrollScenePageTemplate(): string {
  return `
    <html>
      <head>
        <title>Scroll Scene Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #111827;
            color: white;
          }
          header,
          footer,
          .intro {
            min-height: 720px;
            padding: 48px;
            box-sizing: border-box;
          }
          .intro {
            background: linear-gradient(180deg, #111827, #1f2937);
          }
          .scroll-scene {
            position: relative;
            height: 4200px;
            padding: 0 48px;
            box-sizing: border-box;
            background: #020617;
          }
          .scene-window {
            position: sticky;
            top: 80px;
            height: 520px;
            width: min(100%, 1180px);
            margin: 0 auto;
            border-radius: 24px;
            overflow: hidden;
            border: 2px solid rgba(255, 255, 255, 0.2);
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
          }
          .scene-frame {
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 72px;
            font-weight: 700;
            letter-spacing: 0.04em;
          }
          footer {
            background: #0f172a;
          }
        </style>
      </head>
      <body>
        <div class="intro"><h1>Intro</h1><p>Scroll down for the scene.</p></div>
        <section class="scroll-scene" id="scroll-scene">
          <div class="scene-window">
            <div class="scene-frame" id="scene-frame">FRAME 1</div>
          </div>
        </section>
        <footer><h2>Footer</h2></footer>
        <script>
          const frame = document.getElementById('scene-frame');
          const section = document.getElementById('scroll-scene');
          const palette = [
            ['FRAME 1', '#ef4444'],
            ['FRAME 2', '#f59e0b'],
            ['FRAME 3', '#10b981'],
            ['FRAME 4', '#3b82f6'],
          ];
          function renderScene() {
            const start = section.offsetTop;
            const end = start + section.offsetHeight - window.innerHeight;
            const progress = Math.max(0, Math.min(0.9999, (window.scrollY - start) / Math.max(1, end - start)));
            const index = Math.min(palette.length - 1, Math.floor(progress * palette.length));
            frame.textContent = palette[index][0];
            frame.style.background = palette[index][1];
          }
          window.addEventListener('scroll', renderScene, { passive: true });
          renderScene();
        </script>
      </body>
    </html>
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
    if (pathname.startsWith("/smooth")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(smoothScrollPageTemplate());
      return;
    }
    if (pathname.startsWith("/scroll-scene")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(scrollScenePageTemplate());
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
    expect(
      isRetryableCaptureError(
        new Error("browserContext.close: Target page, context or browser has been closed"),
      ),
    ).toBe(true);
    expect(isRetryableCaptureError(new Error("selector not found"))).toBe(false);
  });
});

describe("fullPage stabilization", () => {
  it("forces scroll-smooth pages back to top before fullPage capture", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const logs: string[] = [];

    try {
      await page.goto(`${baseUrl}/smooth`, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => window.scrollTo(0, 1400));
      await page.waitForTimeout(120);

      const before = await page.evaluate(() => window.scrollY);
      expect(before).toBeGreaterThan(0);

      const result = await stabilizeFullPageViewport(page, `${baseUrl}/smooth`, (_level, message) => {
        logs.push(message);
      });

      const after = await page.evaluate(() => ({
        scrollY: window.scrollY,
        scrollTop: (document.scrollingElement ?? document.documentElement ?? document.body)?.scrollTop ?? 0,
      }));

      expect(result.stable).toBe(true);
      expect(after.scrollY).toBe(0);
      expect(after.scrollTop).toBe(0);
      expect(logs).toContain(`fullpage_scroll_stabilized url=${baseUrl}/smooth scrollY=0`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
});

describe("scroll scene unfolding", () => {
  it("shrinks tall sticky scenes into a stitched multi-frame full-page section", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-scroll-scene-"));
    const task: ParsedTask = {
      url: `${baseUrl}/scroll-scene`,
      waitUntil: "domcontentloaded",
      captures: [{ mode: "fullPage" }],
      image: { format: "jpg", quality: 92, dpr: 1 },
      viewport: { width: 1920, height: 1080 },
      tags: ["e2e"],
      eagle: {},
    };

    const result = await captureTask(task, {
      outputDir,
      sectionScope: "classic",
      classicMaxSections: 10,
    });

    const fullPageAsset = result.assets.find((asset) => asset.kind === "fullPage");
    expect(fullPageAsset).toBeTruthy();
    expect(result.scrollSceneDebug).toBeTruthy();
    expect(result.scrollSceneDebug?.[0]?.distinctFrameCount).toBeGreaterThanOrEqual(2);

    const metadata = await sharp(fullPageAsset!.filePath).metadata();
    expect(metadata.height).toBeLessThan(result.fullPageSize.height - 1200);

    const firstScene = result.scrollSceneDebug![0];
    const gap = 24;
    const sampleOffsets = Array.from({ length: firstScene.distinctFrameCount }, (_value, index) =>
      Math.round(firstScene.outerTop + index * (firstScene.stickyHeight + gap) + firstScene.stickyHeight / 2),
    );

    const samples = await Promise.all(
      sampleOffsets.map(async (top) =>
        sharp(fullPageAsset!.filePath)
          .extract({ left: 960, top, width: 1, height: 1 })
          .raw()
          .toBuffer(),
      ),
    );

    const uniqueColors = new Set(samples.map((sample) => `${sample[0]}-${sample[1]}-${sample[2]}`));
    expect(uniqueColors.size).toBeGreaterThanOrEqual(Math.min(3, firstScene.distinctFrameCount));
  }, 20_000);
});

describe.runIf(process.env.RUN_E2E_CAPTURE === "1")("capture e2e", () => {
  async function runCase(pathname: string) {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-"));
    const task: ParsedTask = {
      url: `${baseUrl}${pathname}`,
      waitUntil: "networkidle",
      captures: [{ mode: "fullPage" }, { mode: "section" }],
      image: { format: "jpg", quality: 92, dpr: "auto" },
      viewport: { width: 1920, height: 1080 },
      tags: ["e2e"],
      eagle: {},
    };

    const result = await captureTask(task, {
      outputDir,
      sectionScope: "classic",
      classicMaxSections: 10,
    });

    const fullPageCount = result.assets.filter((asset) => asset.kind === "fullPage").length;
    const fullPageAsset = result.assets.find((asset) => asset.kind === "fullPage");
    const sectionAssets = result.assets.filter((asset) => asset.kind === "section");
    expect(fullPageCount).toBe(1);
    expect(fullPageAsset?.pageTitle).toBeTruthy();
    expect(sectionAssets.length).toBeGreaterThanOrEqual(3);
    expect(sectionAssets.every((asset) => Boolean(asset.pageTitle?.trim()))).toBe(true);
    for (const sectionAsset of sectionAssets) {
      const dim = await readJpegDimensions(sectionAsset.filePath);
      if (sectionAsset.dpr === 2) {
        expect(dim).toEqual({ width: 3840, height: 2160 });
      } else {
        expect(dim).toEqual({ width: 1920, height: 1080 });
      }
    }
  }

  it("captures marketing page", async () => {
    await runCase("/marketing");
  });

  it("captures multiple features and faq in classic mode", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-marketing-"));
    const task: ParsedTask = {
      url: `${baseUrl}/marketing`,
      waitUntil: "networkidle",
      captures: [{ mode: "fullPage" }, { mode: "section" }],
      image: { format: "jpg", quality: 92, dpr: "auto" },
      viewport: { width: 1920, height: 1080 },
      tags: ["e2e"],
      eagle: {},
    };

    const result = await captureTask(task, {
      outputDir,
      sectionScope: "classic",
      classicMaxSections: 10,
    });

    const sectionAssets = result.assets.filter((asset) => asset.kind === "section");
    const featureAssets = sectionAssets.filter((asset) => asset.sectionType === "feature");
    const featureCount = featureAssets.length;
    expect(featureCount).toBeGreaterThanOrEqual(2);
    expect(new Set(featureAssets.map((asset) => asset.fileName)).size).toBe(featureCount);
    expect(sectionAssets.some((asset) => asset.sectionType === "faq")).toBe(true);
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
      viewport: { width: 1920, height: 1080 },
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
