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

function consentBannerPageTemplate(): string {
  return `
    <html>
      <head>
        <title>Consent Banner Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #ffffff;
          }
          main {
            min-height: 2600px;
            padding: 48px;
            background: linear-gradient(180deg, #ffffff 0%, #f6f7fb 100%);
          }
          .osano-cm-dialog {
            position: fixed;
            left: 32px;
            bottom: 32px;
            width: 360px;
            padding: 18px;
            border-radius: 14px;
            background: #15171c;
            color: #ffffff;
            box-shadow: 0 24px 50px rgba(0, 0, 0, 0.28);
            z-index: 9999;
          }
          .osano-cm-dialog__actions {
            display: flex;
            gap: 8px;
            margin-top: 14px;
          }
          button {
            border: 0;
            padding: 8px 12px;
            border-radius: 999px;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Consent banner fixture</h1>
          <p>Used to verify cookie consent cleanup before capture.</p>
        </main>
        <div
          role="dialog"
          aria-label="Cookie Consent Banner"
          class="osano-cm-window__dialog osano-cm-dialog"
        >
          <div>This website uses cookies to improve your experience.</div>
          <div class="osano-cm-dialog__actions">
            <button type="button" onclick="document.querySelector('.osano-cm-dialog').remove()">Accept All</button>
            <button type="button" onclick="document.querySelector('.osano-cm-dialog').remove()">Reject All</button>
          </div>
        </div>
      </body>
    </html>
  `;
}

function promoModalPageTemplate(): string {
  return `
    <html>
      <head>
        <title>Promo Modal Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #eff6ff;
          }
          main {
            min-height: 2200px;
            padding: 48px;
          }
          .promo-backdrop {
            position: fixed;
            inset: 0;
            background: rgba(15, 23, 42, 0.32);
            z-index: 9998;
          }
          .newsletter-modal {
            position: fixed;
            top: 180px;
            left: 50%;
            transform: translateX(-50%);
            width: 420px;
            padding: 24px;
            border-radius: 20px;
            background: #111827;
            color: white;
            z-index: 9999;
          }
          .newsletter-modal button {
            margin-top: 14px;
            border: 0;
            padding: 10px 14px;
            border-radius: 999px;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Promo modal fixture</h1>
          <p>Used to verify newsletter popup cleanup before capture.</p>
        </main>
        <div class="promo-backdrop"></div>
        <div role="dialog" class="newsletter-modal popup">
          <h2>Subscribe to our newsletter</h2>
          <p>Get product updates and special offers.</p>
          <button type="button" onclick="document.querySelector('.promo-backdrop').remove(); document.querySelector('.newsletter-modal').remove();">
            No thanks
          </button>
        </div>
      </body>
    </html>
  `;
}

function lateOverlayPageTemplate(): string {
  return `
    <html>
      <head>
        <title>Late Overlay Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #ffffff;
          }
          main {
            min-height: 2600px;
            padding: 48px;
            background: linear-gradient(180deg, #ffffff 0%, #eef2ff 100%);
          }
          .late-modal {
            position: fixed;
            right: 32px;
            bottom: 32px;
            width: 340px;
            padding: 18px;
            border-radius: 18px;
            background: #101828;
            color: white;
            z-index: 9999;
          }
          .late-modal button {
            margin-top: 12px;
            border: 0;
            padding: 8px 12px;
            border-radius: 999px;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Late overlay fixture</h1>
          <p>Used to verify the second cleanup pass for delayed popups.</p>
        </main>
        <script>
          window.setTimeout(() => {
            const modal = document.createElement('div');
            modal.className = 'late-modal newsletter-modal';
            modal.setAttribute('role', 'dialog');
            modal.innerHTML = '<strong>Need help?</strong><p>Subscribe for updates.</p><button type="button">Dismiss</button>';
            modal.querySelector('button').addEventListener('click', () => modal.remove());
            document.body.appendChild(modal);
          }, 3200);
        </script>
      </body>
    </html>
  `;
}

function veryTallPageTemplate(): string {
  const sections = Array.from(
    { length: 18 },
    (_value, index) => `
      <section class="panel panel-${index % 3}">
        <h2>Panel ${index + 1}</h2>
        <p>Used to verify tiled full-page capture keeps the real bottom of a very tall page.</p>
      </section>
    `,
  ).join("");

  return `
    <html>
      <head>
        <title>Very Tall Capture Fixture</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #f8fafc;
            color: #0f172a;
          }
          .panel {
            min-height: 980px;
            padding: 48px;
            box-sizing: border-box;
            border-bottom: 1px solid rgba(15, 23, 42, 0.08);
          }
          .panel-0 {
            background: linear-gradient(180deg, #eff6ff 0%, #dbeafe 100%);
          }
          .panel-1 {
            background: linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%);
          }
          .panel-2 {
            background: linear-gradient(180deg, #ecfeff 0%, #cffafe 100%);
          }
          footer {
            min-height: 640px;
            padding: 48px;
            box-sizing: border-box;
            background: #0f172a;
            color: #f8fafc;
          }
        </style>
      </head>
      <body>
        <main>${sections}</main>
        <footer>
          <h2>Footer</h2>
          <p>This dark footer must still exist at the final pixels of the captured image.</p>
        </footer>
      </body>
    </html>
  `;
}

function splitScrollScenePageTemplate(): string {
  const blocks = [
    ["Overview", "#ef4444"],
    ["Operations", "#22c55e"],
    ["Finance", "#3b82f6"],
    ["Rollout", "#f97316"],
  ]
    .map(
      ([label, color]) => `
        <article class="split-scene-content-block" style="background:${color}">
          <h3>${label}</h3>
        </article>
      `,
    )
    .join("");

  return `
    <html>
      <head>
        <title>Split Scroll Scene Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #ffffff;
            color: #0f172a;
          }
          .intro,
          .outro {
            min-height: 680px;
            padding: 48px;
            box-sizing: border-box;
            background: linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%);
          }
          .split-scene {
            padding: 0 48px 96px;
            background: #ffffff;
          }
          .split-scene-container {
            position: relative;
            display: flex;
            width: min(100%, 1180px);
            margin: 0 auto;
            min-height: 3120px;
            background: #ffffff;
          }
          .split-scene-sidebar {
            position: sticky;
            top: 0;
            align-self: flex-start;
            width: 360px;
            height: 1080px;
            padding: 32px;
            box-sizing: border-box;
          }
          .split-scene-sidebar-card {
            height: 240px;
            border-radius: 24px;
            padding: 28px;
            box-sizing: border-box;
            background: #111827;
            color: #f8fafc;
            box-shadow: 0 24px 50px rgba(15, 23, 42, 0.18);
          }
          .split-scene-divider {
            width: 1px;
            min-height: 3120px;
            background: #d1d5db;
          }
          .split-scene-content {
            flex: 1;
            min-height: 3120px;
            background: #ffffff;
          }
          .split-scene-content-block {
            height: 780px;
            padding: 48px;
            box-sizing: border-box;
            color: white;
          }
          .split-scene-content-block h3 {
            margin: 0;
            font-size: 40px;
          }
        </style>
      </head>
      <body>
        <section class="intro">
          <h1>Customer story intro</h1>
          <p>Used to verify split scroll-scene preservation for sticky sidebars and long-form content.</p>
        </section>
        <section class="split-scene">
          <div class="split-scene-container">
            <aside class="split-scene-sidebar">
              <div class="split-scene-sidebar-card">
                <strong>Sticky Summary</strong>
                <p>Keep this once.</p>
              </div>
            </aside>
            <div class="split-scene-divider"></div>
            <div class="split-scene-content">${blocks}</div>
          </div>
        </section>
        <section class="outro">
          <h2>Footer</h2>
          <p>Closing content after the split scene.</p>
        </section>
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
    if (pathname.startsWith("/consent-banner")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(consentBannerPageTemplate());
      return;
    }
    if (pathname.startsWith("/promo-modal")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(promoModalPageTemplate());
      return;
    }
    if (pathname.startsWith("/late-overlay")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(lateOverlayPageTemplate());
      return;
    }
    if (pathname.startsWith("/very-tall")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(veryTallPageTemplate());
      return;
    }
    if (pathname.startsWith("/split-scroll-scene")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(splitScrollScenePageTemplate());
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
      await page.waitForFunction(() => window.scrollY > 0, undefined, {
        timeout: 1500,
      });

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
  }, 15_000);
});

describe("fullPage tiled capture", () => {
  it("stitches tall pages so the final footer remains in the output", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-tiled-fullpage-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/very-tall`,
      waitUntil: "domcontentloaded",
      captures: [{ mode: "fullPage" }],
      image: { format: "jpg", quality: 92, dpr: 1 },
      viewport: { width: 1920, height: 1080 },
      tags: [],
      eagle: {},
    };

    const result = await captureTask(task, {
      outputDir,
      sectionScope: "classic",
      classicMaxSections: 10,
      log: (_level, message) => logs.push(message),
    });

    const fullPageAsset = result.assets.find((asset) => asset.kind === "fullPage");
    expect(fullPageAsset).toBeTruthy();
    expect(result.fullPageSize.height).toBeGreaterThan(16_000);
    expect(logs.some((message) => message.includes("fullpage_capture_mode=tiled"))).toBe(true);

    const metadata = await sharp(fullPageAsset!.filePath).metadata();
    expect(metadata.width).toBe(1920);
    expect(metadata.height).toBe(result.fullPageSize.height);

    const sample = await sharp(fullPageAsset!.filePath)
      .extract({ left: 80, top: metadata.height! - 80, width: 1, height: 1 })
      .raw()
      .toBuffer();

    expect(sample[0]).toBeLessThan(30);
    expect(sample[1]).toBeLessThan(40);
    expect(sample[2]).toBeLessThan(60);
  }, 20_000);
});

describe("split scroll scene preservation", () => {
  it("keeps the right content column while preserving the sticky sidebar once", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-split-scroll-scene-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/split-scroll-scene`,
      waitUntil: "domcontentloaded",
      captures: [{ mode: "fullPage" }],
      image: { format: "jpg", quality: 92, dpr: 1 },
      viewport: { width: 1920, height: 1080 },
      tags: [],
      eagle: {},
    };

    const result = await captureTask(task, {
      outputDir,
      sectionScope: "classic",
      classicMaxSections: 10,
      log: (_level, message) => logs.push(message),
    });

    const fullPageAsset = result.assets.find((asset) => asset.kind === "fullPage");
    const firstScene = result.scrollSceneDebug?.[0];
    expect(fullPageAsset).toBeTruthy();
    expect(firstScene).toBeTruthy();
    expect(firstScene?.layoutMode).toBe("split_content_preserve");
    expect(firstScene?.replacementHeight).toBe(firstScene?.outerHeight);
    expect(logs.some((message) => message.includes("layoutMode=split_content_preserve"))).toBe(true);

    const metadata = await sharp(fullPageAsset!.filePath).metadata();
    expect(metadata.height).toBe(result.fullPageSize.height);

    const contentSamples = await Promise.all([
      sharp(fullPageAsset!.filePath)
        .extract({ left: 1120, top: firstScene!.outerTop + 360, width: 1, height: 1 })
        .raw()
        .toBuffer(),
      sharp(fullPageAsset!.filePath)
        .extract({ left: 1120, top: firstScene!.outerTop + 1140, width: 1, height: 1 })
        .raw()
        .toBuffer(),
      sharp(fullPageAsset!.filePath)
        .extract({ left: 1120, top: firstScene!.outerTop + 1920, width: 1, height: 1 })
        .raw()
        .toBuffer(),
      sharp(fullPageAsset!.filePath)
        .extract({ left: 1120, top: firstScene!.outerTop + 2700, width: 1, height: 1 })
        .raw()
        .toBuffer(),
    ]);

    expect(contentSamples[0][0]).toBeGreaterThan(contentSamples[0][1]);
    expect(contentSamples[0][0]).toBeGreaterThan(contentSamples[0][2]);
    expect(contentSamples[1][1]).toBeGreaterThan(contentSamples[1][0]);
    expect(contentSamples[1][1]).toBeGreaterThan(contentSamples[1][2]);
    expect(contentSamples[2][2]).toBeGreaterThan(contentSamples[2][0]);
    expect(contentSamples[2][2]).toBeGreaterThan(contentSamples[2][1]);
    expect(contentSamples[3][0]).toBeGreaterThan(contentSamples[3][1]);
    expect(contentSamples[3][1]).toBeGreaterThan(contentSamples[3][2]);

    const stickyCardTop = await sharp(fullPageAsset!.filePath)
      .extract({ left: 500, top: firstScene!.outerTop + 120, width: 1, height: 1 })
      .raw()
      .toBuffer();
    const repeatedStickyCard = await sharp(fullPageAsset!.filePath)
      .extract({ left: 500, top: firstScene!.outerTop + firstScene!.stickyHeight + 24 + 120, width: 1, height: 1 })
      .raw()
      .toBuffer();

    expect(stickyCardTop[2]).toBeLessThan(80);
    expect(repeatedStickyCard[0]).toBeGreaterThan(200);
    expect(repeatedStickyCard[1]).toBeGreaterThan(200);
    expect(repeatedStickyCard[2]).toBeGreaterThan(200);
  }, 20_000);
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
    expect(result.scrollSceneDebug?.[0]?.layoutMode).toBe("sticky_only_unfold");
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

describe("overlay cleanup", () => {
  it("removes Osano-style consent banners before full-page capture", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-consent-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/consent-banner`,
      waitUntil: "domcontentloaded",
      captures: [{ mode: "fullPage" }],
      image: { format: "jpg", quality: 92, dpr: 1 },
      viewport: { width: 1920, height: 1080 },
      tags: [],
      eagle: {},
    };

    const result = await captureTask(task, {
      outputDir,
      sectionScope: "classic",
      classicMaxSections: 10,
      log: (_level, message) => logs.push(message),
    });

    const fullPageAsset = result.assets.find((asset) => asset.kind === "fullPage");
    expect(fullPageAsset).toBeTruthy();
    const sample = await sharp(fullPageAsset!.filePath)
      .extract({ left: 90, top: 920, width: 1, height: 1 })
      .raw()
      .toBuffer();

    expect(sample[0]).toBeGreaterThan(220);
    expect(logs.some((message) => message.includes("overlay_detected type=consent vendor=osano"))).toBe(true);
    expect(logs.some((message) => message.includes("overlay_cleanup_summary handled="))).toBe(true);
  }, 20_000);

  it("dismisses promo modals before full-page capture", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-promo-"));
    const task: ParsedTask = {
      url: `${baseUrl}/promo-modal`,
      waitUntil: "domcontentloaded",
      captures: [{ mode: "fullPage" }],
      image: { format: "jpg", quality: 92, dpr: 1 },
      viewport: { width: 1920, height: 1080 },
      tags: [],
      eagle: {},
    };

    const result = await captureTask(task, {
      outputDir,
      sectionScope: "classic",
      classicMaxSections: 10,
    });

    const fullPageAsset = result.assets.find((asset) => asset.kind === "fullPage");
    expect(fullPageAsset).toBeTruthy();
    const sample = await sharp(fullPageAsset!.filePath)
      .extract({ left: 960, top: 280, width: 1, height: 1 })
      .raw()
      .toBuffer();

    expect(sample[2]).toBeGreaterThan(sample[0]);
  }, 20_000);

  it("removes delayed overlays during the second cleanup pass", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-late-overlay-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/late-overlay`,
      waitUntil: "domcontentloaded",
      captures: [{ mode: "fullPage" }],
      image: { format: "jpg", quality: 92, dpr: 1 },
      viewport: { width: 1920, height: 1080 },
      tags: [],
      eagle: {},
    };

    const result = await captureTask(task, {
      outputDir,
      sectionScope: "classic",
      classicMaxSections: 10,
      log: (_level, message) => logs.push(message),
    });

    const fullPageAsset = result.assets.find((asset) => asset.kind === "fullPage");
    expect(fullPageAsset).toBeTruthy();
    const sample = await sharp(fullPageAsset!.filePath)
      .extract({ left: 1700, top: 940, width: 1, height: 1 })
      .raw()
      .toBuffer();

    expect(sample[0]).toBeGreaterThan(220);
    expect(logs.some((message) => message.includes("overlay_action action="))).toBe(true);
  }, 30_000);
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
