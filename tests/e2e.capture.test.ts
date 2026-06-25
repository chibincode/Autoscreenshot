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

function sectionStickyNavPageTemplate(): string {
  return `
    <html>
      <head>
        <title>Section Sticky Nav</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #020617;
            color: white;
          }
          header {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 20;
            height: 72px;
            display: flex;
            align-items: center;
            padding: 0 32px;
            box-sizing: border-box;
            background: rgb(241, 74, 96);
            color: white;
            font-weight: 700;
          }
          section {
            min-height: 1180px;
            box-sizing: border-box;
            padding: 180px 80px 80px;
          }
          .hero {
            background: #020617;
          }
          .feature {
            background: #172033;
          }
        </style>
      </head>
      <body>
        <header>Navigation should stay in the hero section screenshot</header>
        <main>
          <section class="hero">
            <h1>Hero with fixed navigation</h1>
            <button>Start</button>
          </section>
          <section class="feature">
            <h2>Feature content</h2>
            <p>This lower section forces lazy-load warmup to scroll away from the top.</p>
          </section>
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

function delayedHeroPageTemplate(): string {
  return `
    <html>
      <head>
        <title>Delayed Hero Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #e5e7eb;
            color: #0f172a;
          }
          .loading-shell,
          .hero {
            min-height: 1180px;
            padding: 96px;
            box-sizing: border-box;
          }
          .loading-shell {
            background: #e5e7eb;
          }
          .skeleton-line {
            width: 520px;
            height: 48px;
            margin-bottom: 24px;
            border-radius: 999px;
            background: #cbd5e1;
          }
          .hero {
            background: #064e3b;
            color: #ecfdf5;
          }
          .hero h1 {
            margin: 0;
            font-size: 88px;
            line-height: 1;
          }
        </style>
      </head>
      <body>
        <main id="root" class="loading-shell" aria-busy="true">
          <div class="skeleton-line"></div>
          <div class="skeleton-line"></div>
          <p>Loading customer data...</p>
        </main>
        <script>
          window.setTimeout(() => {
            const root = document.getElementById('root');
            root.className = 'hero';
            root.setAttribute('aria-busy', 'false');
            root.innerHTML = '<h1>Hero is ready</h1><p>Stable content should be captured.</p>';
          }, 3200);
        </script>
      </body>
    </html>
  `;
}

function viewportHeroImagePageTemplate(): string {
  return `
    <html>
      <head>
        <title>Viewport Hero Image Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            color: #111827;
            background: #ffffff;
          }
          .hero {
            min-height: 1080px;
            padding: 96px 240px;
            box-sizing: border-box;
            background: linear-gradient(180deg, #ffffff 0%, #eef2ff 100%);
          }
          .hero h1 {
            margin: 0 0 32px;
            font-size: 80px;
            line-height: 1;
          }
          .hero-visual {
            display: block;
            width: 640px;
            height: 520px;
            object-fit: cover;
            border-radius: 8px;
          }
        </style>
      </head>
      <body>
        <section class="hero">
          <h1>Slow hero visual</h1>
          <img class="hero-visual" src="/slow-feature-art/blue.svg" alt="">
        </section>
      </body>
    </html>
  `;
}

function lazyFeatureBackgroundPageTemplate(): string {
  return `
    <html>
      <head>
        <title>Lazy Feature Background Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #ffffff;
            color: #111827;
          }
          .hero {
            min-height: 1120px;
            padding: 160px 240px;
            box-sizing: border-box;
            background: #f8fafc;
          }
          .hero h1 {
            margin: 0;
            font-size: 80px;
            line-height: 1;
          }
          .features {
            min-height: 1500px;
            padding: 140px 240px;
            box-sizing: border-box;
            background: #ffffff;
          }
          .intro {
            width: 640px;
            margin: 0 auto 80px;
            text-align: center;
          }
          .intro h2 {
            margin: 0 0 16px;
            font-size: 52px;
          }
          .grid {
            width: 1320px;
            margin: 0 auto;
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 32px;
          }
          .feature-card {
            height: 520px;
            padding: 40px;
            box-sizing: border-box;
            border-radius: 8px;
            background-color: #05070a;
            background-position: center;
            background-size: cover;
            color: white;
          }
          footer {
            min-height: 520px;
            background: #020617;
          }
        </style>
      </head>
      <body>
        <section class="hero">
          <h1>Automation made visible</h1>
        </section>
        <section class="features">
          <div class="intro">
            <h2>Packed with features</h2>
            <p>Feature art is attached only after each card has entered the viewport.</p>
          </div>
          <div class="grid">
            <article class="feature-card" data-bg="/slow-feature-art/green.svg">
              <h3>Human Language to CAD</h3>
            </article>
            <article class="feature-card" data-bg="/slow-feature-art/blue.svg">
              <h3>Code Compliant Zone Maps</h3>
            </article>
            <article class="feature-card" data-bg="/slow-feature-art/pink.svg">
              <h3>Automatic Riser Diagrams</h3>
            </article>
            <article class="feature-card" data-bg="/slow-feature-art/orange.svg">
              <h3>Drag & Drop Them</h3>
            </article>
          </div>
        </section>
        <footer></footer>
        <script>
          const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) {
                continue;
              }
              const card = entry.target;
              card.style.backgroundImage = 'url("' + card.dataset.bg + '")';
              observer.unobserve(card);
            }
          }, { threshold: 0.2 });

          document.querySelectorAll('.feature-card').forEach((card) => observer.observe(card));
        </script>
      </body>
    </html>
  `;
}

function webglCanvasPageTemplate(): string {
  return `
    <html>
      <head>
        <title>WebGL Canvas Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #020617;
          }
          .hero {
            min-height: 420px;
            padding: 120px 240px;
            box-sizing: border-box;
            color: white;
          }
          .canvas-card {
            width: 960px;
            height: 560px;
            margin: 0 auto 180px;
            background: #05070a;
            border-radius: 8px;
            overflow: hidden;
          }
          canvas {
            width: 100%;
            height: 100%;
            display: block;
          }
          footer {
            min-height: 520px;
          }
        </style>
      </head>
      <body>
        <section class="hero">
          <h1>Canvas feature art</h1>
        </section>
        <section class="canvas-card">
          <canvas id="feature-canvas" width="960" height="560"></canvas>
        </section>
        <footer></footer>
        <script>
          const canvas = document.getElementById('feature-canvas');
          const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          if (gl) {
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.clearColor(0.13, 0.77, 0.37, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          }
        </script>
      </body>
    </html>
  `;
}

function scrollSceneOverlayPageTemplate(): string {
  return `
    <html>
      <head>
        <title>Scroll Scene Overlay Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #111827;
            color: white;
          }
          .intro,
          footer {
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
          .scene-consent-card {
            position: fixed;
            top: 180px;
            left: 50%;
            width: 520px;
            padding: 24px;
            border-radius: 18px;
            transform: translateX(-50%);
            background: #fffdfa;
            color: #161616;
            box-shadow: 0 28px 64px rgba(15, 23, 42, 0.32);
            z-index: 9999;
          }
          .scene-consent-card__options {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px 16px;
            margin-top: 16px;
            font-size: 15px;
          }
          .scene-consent-card button {
            margin-top: 18px;
            border: 0;
            border-radius: 12px;
            padding: 12px 18px;
            background: #111827;
            color: #fffdfa;
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
          let overlayShown = false;

          function renderScene() {
            const start = section.offsetTop;
            const end = start + section.offsetHeight - window.innerHeight;
            const progress = Math.max(0, Math.min(0.9999, (window.scrollY - start) / Math.max(1, end - start)));
            const index = Math.min(palette.length - 1, Math.floor(progress * palette.length));
            frame.textContent = palette[index][0];
            frame.style.background = palette[index][1];
          }

          function maybeShowConsentOverlay() {
            if (overlayShown || window.scrollY < section.offsetTop + 420) {
              return;
            }
            overlayShown = true;
            const overlay = document.createElement('div');
            overlay.className = 'scene-consent-card';
            overlay.innerHTML = [
              '<strong>What can we use data collected by cookies for?</strong>',
              '<div class="scene-consent-card__options">',
              '<label><input type="checkbox" checked> Essential</label>',
              '<label><input type="checkbox"> Functional</label>',
              '<label><input type="checkbox"> Analytics</label>',
              '<label><input type="checkbox"> Advertising</label>',
              '</div>',
              '<button type="button">Confirm</button>',
            ].join('');
            overlay.querySelector('button').addEventListener('click', () => overlay.remove());
            document.body.appendChild(overlay);
          }

          window.addEventListener('scroll', () => {
            renderScene();
            maybeShowConsentOverlay();
          }, { passive: true });
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

function inlineConsentCardPageTemplate(): string {
  return `
    <html>
      <head>
        <title>Inline Consent Card Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #fffdf7;
            color: #1f2937;
          }
          .hero,
          .footer {
            min-height: 1200px;
            padding: 48px;
            box-sizing: border-box;
          }
          .hero {
            background: linear-gradient(180deg, #fffdf7 0%, #f6efe4 100%);
          }
          .panel {
            position: relative;
            min-height: 920px;
            padding: 56px 48px;
            box-sizing: border-box;
            background: #ff8b2b;
          }
          .panel-card {
            position: absolute;
            left: 50%;
            top: 170px;
            transform: translateX(-50%);
            width: 420px;
            padding: 24px;
            border-radius: 18px;
            background: #fffefb;
            color: #2c241e;
            box-shadow: 0 24px 60px rgba(44, 36, 30, 0.2);
          }
          .panel-card__actions {
            display: flex;
            gap: 12px;
            margin-top: 18px;
          }
          .panel-card button {
            flex: 1;
            border: 0;
            border-radius: 12px;
            padding: 12px 16px;
            background: #102322;
            color: #fffefb;
          }
          .footer {
            background: linear-gradient(180deg, #102322 0%, #081312 100%);
            color: #fffefb;
          }
        </style>
      </head>
      <body>
        <section class="hero">
          <h1>Inline consent fixture</h1>
          <p>Used to verify consent cards rendered inside page content are removed before full-page capture.</p>
        </section>
        <section class="panel">
          <h2>Mid-page content</h2>
          <p>This section mimics a content card where a consent panel is rendered after the user scrolls.</p>
          <div class="panel-card">
            <strong>Cookie Settings</strong>
            <p>We use cookies to personalize content, run ads, and analyze traffic.</p>
            <div class="panel-card__actions">
              <button type="button" onclick="document.querySelector('.panel-card').remove()">Reject</button>
              <button type="button" onclick="document.querySelector('.panel-card').remove()">Accept</button>
            </div>
          </div>
        </section>
        <section class="footer">
          <h2>Footer</h2>
        </section>
      </body>
    </html>
  `;
}

function transcendHostConsentPageTemplate(): string {
  return `
    <html>
      <head>
        <title>Transcend Host Consent Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #2563eb;
            color: white;
          }
          main {
            min-height: 2400px;
            padding: 72px;
            box-sizing: border-box;
            background: linear-gradient(180deg, #2563eb 0%, #1d4ed8 100%);
          }
          h1 {
            margin: 0;
            font-size: 72px;
            line-height: 1.05;
          }
          p {
            max-width: 720px;
            font-size: 24px;
            line-height: 1.5;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Closed shadow consent host</h1>
          <p>This fixture mimics consent managers that only expose a fixed host element in the light DOM while rendering the visible card inside a closed shadow root.</p>
        </main>
        <div id="transcend-consent-manager" style="position: fixed; z-index: 2147483647;"></div>
        <script>
          const host = document.getElementById('transcend-consent-manager');
          const root = host.attachShadow({ mode: 'closed' });
          const style = document.createElement('style');
          style.textContent = [
            '.transcend-card {',
            '  position: fixed;',
            '  top: 240px;',
            '  left: 50%;',
            '  width: 520px;',
            '  padding: 24px;',
            '  border-radius: 18px;',
            '  transform: translateX(-50%);',
            '  background: #fffdfa;',
            '  color: #18181b;',
            '  box-shadow: 0 30px 60px rgba(15, 23, 42, 0.22);',
            '  z-index: 2147483647;',
            '}',
            '.transcend-card__options {',
            '  display: grid;',
            '  grid-template-columns: repeat(2, minmax(0, 1fr));',
            '  gap: 12px 16px;',
            '  margin-top: 16px;',
            '  font-size: 15px;',
            '}',
            '.transcend-card button {',
            '  margin-top: 18px;',
            '  border: 0;',
            '  border-radius: 12px;',
            '  padding: 12px 18px;',
            '  background: #111827;',
            '  color: #fffdfa;',
            '}',
          ].join('');
          const card = document.createElement('div');
          card.className = 'transcend-card';
          card.innerHTML = [
            '<strong>What can we use data collected by cookies for?</strong>',
            '<div class="transcend-card__options">',
            '<label><input type="checkbox" checked> Essential</label>',
            '<label><input type="checkbox"> Functional</label>',
            '<label><input type="checkbox"> Analytics</label>',
            '<label><input type="checkbox"> Advertising</label>',
            '</div>',
            '<button type="button">Confirm</button>',
          ].join('');
          root.append(style, card);
        </script>
      </body>
    </html>
  `;
}

function tiledLateConsentPageTemplate(): string {
  const palette = [
    { title: "SEGMENT 1", background: "#f3f4f6", color: "#111827" },
    { title: "SEGMENT 2", background: "#35b56e", color: "#f8fafc" },
    { title: "SEGMENT 3", background: "#3b82f6", color: "#f8fafc" },
    { title: "SEGMENT 4", background: "#f59e0b", color: "#111827" },
    { title: "SEGMENT 5", background: "#0f766e", color: "#f8fafc" },
    { title: "SEGMENT 6", background: "#7c3aed", color: "#f8fafc" },
    { title: "SEGMENT 7", background: "#be123c", color: "#f8fafc" },
    { title: "SEGMENT 8", background: "#0891b2", color: "#f8fafc" },
  ];

  const sections = palette
    .map(
      (segment, index) => `
        <section class="tile-band" style="background:${segment.background};color:${segment.color}">
          <div>
            <h2>${segment.title}</h2>
            <p>Tile band ${index + 1} keeps a stable color so repeated fixed overlays are easy to detect.</p>
          </div>
        </section>
      `,
    )
    .join("");

  return `
    <html>
      <head>
        <title>Tiled Late Consent Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #ffffff;
          }
          .tile-band {
            min-height: 4000px;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            box-sizing: border-box;
          }
          .tile-band h2 {
            margin: 0;
            font-size: 96px;
            letter-spacing: 0.08em;
          }
          .tile-band p {
            margin-top: 24px;
            font-size: 28px;
          }
          .late-consent-card {
            position: fixed;
            top: 220px;
            left: 50%;
            width: 520px;
            padding: 24px;
            border-radius: 18px;
            transform: translateX(-50%);
            background: #fffdfa;
            color: #18181b;
            box-shadow: 0 30px 60px rgba(15, 23, 42, 0.22);
            z-index: 9999;
          }
          .late-consent-card__options {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px 16px;
            margin-top: 16px;
            font-size: 15px;
          }
          .late-consent-card button {
            margin-top: 18px;
            border: 0;
            border-radius: 12px;
            padding: 12px 18px;
            background: #111827;
            color: #fffdfa;
          }
        </style>
      </head>
      <body>
        <main>${sections}</main>
        <script>
          let overlayShown = false;

          function maybeShowOverlay() {
            if (overlayShown || document.documentElement.dataset.autosnapCapturePhase !== 'tile_capture') {
              return;
            }
            overlayShown = true;
            const overlay = document.createElement('div');
            overlay.className = 'late-consent-card';
            overlay.innerHTML = [
              '<strong>What can we use data collected by cookies for?</strong>',
              '<div class="late-consent-card__options">',
              '<label><input type="checkbox" checked> Essential</label>',
              '<label><input type="checkbox"> Functional</label>',
              '<label><input type="checkbox"> Analytics</label>',
              '<label><input type="checkbox"> Advertising</label>',
              '</div>',
              '<button type="button">Confirm</button>',
            ].join('');
            overlay.querySelector('button').addEventListener('click', () => overlay.remove());
            document.body.appendChild(overlay);
          }

          new MutationObserver(() => maybeShowOverlay()).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-autosnap-capture-phase'],
          });
          maybeShowOverlay();
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

function scrollRevealFooterPageTemplate(): string {
  return `
    <html>
      <head>
        <title>Scroll Reveal Footer Fixture</title>
        <style>
          html,
          body {
            margin: 0;
            scroll-behavior: smooth;
            font-family: sans-serif;
            background: #fafafa;
          }
          main {
            min-height: 2600px;
            padding: 72px 96px;
            box-sizing: border-box;
            background: #fafafa;
          }
          .fixed-nav {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 20;
            height: 72px;
            display: flex;
            align-items: center;
            gap: 40px;
            padding: 0 80px;
            box-sizing: border-box;
            background: rgba(250, 250, 250, 0.86);
            color: #1b1c1c;
            backdrop-filter: blur(18px);
          }
          .fixed-nav.is-hidden {
            opacity: 0;
          }
          .nav-marker {
            width: 38px;
            height: 38px;
            border-radius: 999px;
            background: #ef4444;
          }
          .work-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 32px;
            max-width: 1280px;
            margin: 1300px auto 0;
          }
          .work-card {
            height: 420px;
            border-radius: 16px;
            background: linear-gradient(135deg, #143f3d, #f2f5f0);
          }
          .footer-window {
            height: 720px;
            overflow: hidden;
            background: #fafafa;
          }
          footer {
            position: relative;
            height: 720px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #1b1c1c;
            color: #fafafa;
            transform: translateY(-500px);
            transition: transform 80ms linear;
          }
          .footer-lockup {
            position: absolute;
            top: 260px;
            left: 0;
            right: 0;
            text-align: center;
          }
          .footer-lockup h2 {
            margin: 0;
            font-size: 48px;
            font-weight: 400;
          }
          .footer-marker {
            position: absolute;
            top: 360px;
            left: calc(50% - 48px);
            width: 96px;
            height: 96px;
            background: #22c55e;
          }
        </style>
      </head>
      <body>
        <nav class="fixed-nav">
          <div class="nav-marker"></div>
          <span>Work</span>
          <span>About</span>
          <span>Playground</span>
        </nav>
        <main>
          <h1>Portfolio</h1>
          <div class="work-grid">
            <div class="work-card"></div>
            <div class="work-card"></div>
          </div>
        </main>
        <div class="footer-window">
          <footer>
            <div class="footer-lockup">
              <h2>Have a project in mind?</h2>
            </div>
            <div class="footer-marker"></div>
          </footer>
        </div>
        <script>
          const nav = document.querySelector('.fixed-nav');
          const footer = document.querySelector('footer');
          let navWasScrolled = false;
          function renderFooter() {
            const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
            const progress = maxScroll <= 0 ? 1 : Math.max(0, Math.min(1, window.scrollY / maxScroll));
            footer.style.transform = 'translateY(' + Math.round(-500 + 500 * progress) + 'px)';
            if (window.scrollY > 0) {
              navWasScrolled = true;
            }
            nav.classList.toggle('is-hidden', navWasScrolled);
          }
          window.addEventListener('scroll', renderFooter, { passive: true });
          renderFooter();
        </script>
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

function splitScrollSceneUnfoldPageTemplate(): string {
  const states = [
    { label: "Retargeting", frame: "#b91c1c", glow: "rgba(248, 113, 113, 0.24)", block: "#ef4444" },
    { label: "Persona pages", frame: "#d97706", glow: "rgba(251, 191, 36, 0.24)", block: "#f59e0b" },
    { label: "Discovery", frame: "#15803d", glow: "rgba(74, 222, 128, 0.24)", block: "#22c55e" },
    { label: "Champion enablement", frame: "#0891b2", glow: "rgba(103, 232, 249, 0.24)", block: "#06b6d4" },
    { label: "Upsell launch", frame: "#7c3aed", glow: "rgba(196, 181, 253, 0.26)", block: "#6366f1" },
    { label: "Conference booth", frame: "#111827", glow: "rgba(148, 163, 184, 0.18)", block: "#0f172a" },
  ];
  const blocks = states
    .map(
      (state, index) => `
        <article class="split-unfold-content-block" style="background:${state.block}">
          <small>0${index + 1}</small>
          <h3>${state.label}</h3>
          <p>Right-column content should remain visible after the sticky scene is expanded.</p>
        </article>
      `,
    )
    .join("");

  return `
    <html>
      <head>
        <title>Split Scroll Scene Unfold Demo</title>
        <style>
          body {
            margin: 0;
            font-family: sans-serif;
            background: #f8fafc;
            color: #0f172a;
          }
          .intro,
          .outro {
            min-height: 680px;
            padding: 48px;
            box-sizing: border-box;
            background: linear-gradient(180deg, #eff6ff 0%, #e2e8f0 100%);
          }
          .split-unfold-scene {
            padding: 0 48px 96px;
            background: #ffffff;
          }
          .split-unfold-container {
            position: relative;
            display: flex;
            width: min(100%, 1360px);
            min-height: 1800px;
            margin: 0 auto;
            background: #ffffff;
            border: 1px solid #e2e8f0;
          }
          .split-unfold-sidebar {
            position: sticky;
            top: 72px;
            align-self: flex-start;
            width: 640px;
            height: 520px;
            border-right: 1px solid #e2e8f0;
            overflow: hidden;
            background: radial-gradient(circle at top left, #dbeafe 0%, #ffffff 58%);
          }
          .split-unfold-frame {
            position: relative;
            height: 100%;
            overflow: hidden;
            background: #1d4ed8;
            color: white;
          }
          .split-unfold-frame-overlay {
            position: absolute;
            inset: 0;
            background: radial-gradient(circle at 20% 20%, white, transparent 45%);
            opacity: 0.18;
          }
          .split-unfold-progress {
            position: absolute;
            top: 0;
            right: 0;
            width: 4px;
            height: 0;
            background: #38bdf8;
          }
          .split-unfold-device {
            position: absolute;
            inset: 56px 56px 56px 72px;
            border-radius: 28px;
            background: rgba(255, 255, 255, 0.92);
            box-shadow: 0 28px 60px rgba(15, 23, 42, 0.18);
            color: #0f172a;
          }
          .split-unfold-device small {
            display: block;
            padding: 24px 28px 0;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: #475569;
          }
          .split-unfold-device h2 {
            margin: 8px 28px 0;
            font-size: 42px;
            line-height: 1;
          }
          .split-unfold-device p {
            margin: 18px 28px 0;
            max-width: 280px;
            font-size: 17px;
            line-height: 1.5;
            color: #334155;
          }
          .split-unfold-content {
            flex: 1;
            background: #ffffff;
          }
          .split-unfold-content-block {
            height: 300px;
            padding: 42px 52px;
            box-sizing: border-box;
            color: white;
          }
          .split-unfold-content-block small {
            display: inline-block;
            margin-bottom: 12px;
            font-size: 15px;
            letter-spacing: 0.16em;
            opacity: 0.72;
          }
          .split-unfold-content-block h3 {
            margin: 0;
            font-size: 46px;
          }
          .split-unfold-content-block p {
            max-width: 380px;
            font-size: 20px;
            line-height: 1.5;
          }
        </style>
      </head>
      <body>
        <section class="intro">
          <h1>Interactive demo intro</h1>
          <p>Used to verify split scroll-scene unfolding with preserved right-column content.</p>
        </section>
        <section class="split-unfold-scene">
          <div class="split-unfold-container" id="split-unfold-scene">
            <aside class="split-unfold-sidebar">
              <div class="split-unfold-frame" id="split-unfold-frame">
                <div class="split-unfold-frame-overlay" id="split-unfold-overlay"></div>
                <div class="split-unfold-progress" id="split-unfold-progress"></div>
                <div class="split-unfold-device">
                  <small>Buyer Journey</small>
                  <h2 id="split-unfold-title">Retargeting</h2>
                  <p>Left-side sticky states should expand into multiple frames while the right column stays readable.</p>
                </div>
              </div>
            </aside>
            <div class="split-unfold-content">${blocks}</div>
          </div>
        </section>
        <section class="outro">
          <h2>Footer</h2>
          <p>Closing content after the split unfold scene.</p>
        </section>
        <script>
          const states = ${JSON.stringify(states)};
          const frame = document.getElementById('split-unfold-frame');
          const title = document.getElementById('split-unfold-title');
          const overlay = document.getElementById('split-unfold-overlay');
          const progress = document.getElementById('split-unfold-progress');
          const section = document.getElementById('split-unfold-scene');
          function renderScene() {
            const start = section.offsetTop;
            const end = start + section.offsetHeight - window.innerHeight;
            const progressValue = Math.max(0, Math.min(0.9999, (window.scrollY - start) / Math.max(1, end - start)));
            const index = Math.min(states.length - 1, Math.floor(progressValue * states.length));
            const state = states[index];
            frame.style.background = 'linear-gradient(160deg, ' + state.frame + ' 0%, #020617 100%)';
            title.textContent = state.label;
            overlay.style.background = 'radial-gradient(circle at 20% 20%, ' + state.glow + ', transparent 46%)';
            overlay.style.opacity = String(0.22 + index * 0.08);
            progress.style.height = String(12 + index * 15) + '%';
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
    if (pathname.startsWith("/slow-feature-art/")) {
      const color = pathname.includes("blue")
        ? "#38bdf8"
        : pathname.includes("pink")
          ? "#f472b6"
          : pathname.includes("orange")
            ? "#fb923c"
            : "#22c55e";
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 520">
          <rect width="640" height="520" fill="${color}"/>
          <circle cx="480" cy="130" r="96" fill="rgba(255,255,255,0.36)"/>
          <rect x="80" y="300" width="420" height="36" rx="18" fill="rgba(15,23,42,0.38)"/>
        </svg>
      `;
      setTimeout(() => {
        res.writeHead(200, {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(svg);
      }, 3200);
      return;
    }
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
    if (pathname.startsWith("/section-sticky-nav")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(sectionStickyNavPageTemplate());
      return;
    }
    if (pathname.startsWith("/scroll-scene-overlay")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(scrollSceneOverlayPageTemplate());
      return;
    }
    if (pathname.startsWith("/scroll-scene")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(scrollScenePageTemplate());
      return;
    }
    if (pathname.startsWith("/delayed-hero")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(delayedHeroPageTemplate());
      return;
    }
    if (pathname.startsWith("/viewport-hero-image")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(viewportHeroImagePageTemplate());
      return;
    }
    if (pathname.startsWith("/lazy-feature-backgrounds")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(lazyFeatureBackgroundPageTemplate());
      return;
    }
    if (pathname.startsWith("/webgl-canvas")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(webglCanvasPageTemplate());
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
    if (pathname.startsWith("/inline-consent-card")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(inlineConsentCardPageTemplate());
      return;
    }
    if (pathname.startsWith("/transcend-host-consent")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(transcendHostConsentPageTemplate());
      return;
    }
    if (pathname.startsWith("/tiled-late-consent")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(tiledLateConsentPageTemplate());
      return;
    }
    if (pathname.startsWith("/very-tall")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(veryTallPageTemplate());
      return;
    }
    if (pathname.startsWith("/scroll-reveal-footer")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(scrollRevealFooterPageTemplate());
      return;
    }
    if (pathname.startsWith("/split-scroll-scene-unfold")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(splitScrollSceneUnfoldPageTemplate());
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
  it("waits for delayed hero content before fullPage capture", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-delayed-hero-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/delayed-hero`,
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
    expect(logs.some((message) => message.includes("render_stable phase=initial_fullpage"))).toBe(true);
    expect(logs.some((message) => message.includes("render_stable_timeout"))).toBe(false);

    const sample = await sharp(fullPageAsset!.filePath)
      .extract({ left: 40, top: 40, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(sample[0] + sample[1] + sample[2]).toBeLessThan(260);
  }, 20_000);

  it("waits for scroll-triggered CSS feature illustrations before fullPage capture", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-lazy-feature-bg-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/lazy-feature-backgrounds`,
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
    expect(logs.some((message) => message.includes("background_image_ready_complete"))).toBe(true);

    const featureCardSample = await sharp(fullPageAsset!.filePath)
      .extract({ left: 620, top: 1690, width: 1, height: 1 })
      .raw()
      .toBuffer();

    expect(featureCardSample[0]).toBeLessThan(80);
    expect(featureCardSample[1]).toBeGreaterThan(130);
    expect(featureCardSample[2]).toBeLessThan(150);
  }, 30_000);

  it("captures viewport-sized hero sections from viewport pixels after visual images load", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-viewport-hero-section-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/viewport-hero-image`,
      waitUntil: "domcontentloaded",
      captures: [{ mode: "section", targetType: "hero" }],
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

    const heroAsset = result.assets.find((asset) => asset.kind === "section" && asset.sectionType === "hero");
    expect(heroAsset).toBeTruthy();
    expect(logs.some((message) => message.includes("section_capture_mode=viewport_crop label=hero"))).toBe(true);

    const visualSample = await sharp(heroAsset!.filePath)
      .extract({ left: 560, top: 260, width: 1, height: 1 })
      .raw()
      .toBuffer();

    expect(visualSample[0]).toBeLessThan(90);
    expect(visualSample[1]).toBeGreaterThan(150);
    expect(visualSample[2]).toBeGreaterThan(190);
  }, 30_000);

  it("captures WebGL canvas feature art instead of a blank fallback", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-webgl-canvas-"));
    const task: ParsedTask = {
      url: `${baseUrl}/webgl-canvas`,
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

    const canvasSample = await sharp(fullPageAsset!.filePath)
      .extract({ left: 960, top: 700, width: 1, height: 1 })
      .raw()
      .toBuffer();

    expect(canvasSample[1]).toBeGreaterThan(150);
    expect(canvasSample[1]).toBeGreaterThan(canvasSample[0] + 60);
    expect(canvasSample[1]).toBeGreaterThan(canvasSample[2] + 60);
  }, 20_000);

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

  it("removes consent overlays that appear after pre-capture cleanup while tiling", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-tiled-late-consent-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/tiled-late-consent`,
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
    expect(logs.some((message) => message.includes("overlay_action phase=tile_capture"))).toBe(true);

    const greenBandSample = await sharp(fullPageAsset!.filePath)
      .extract({ left: 960, top: 4370, width: 1, height: 1 })
      .raw()
      .toBuffer();
    const orangeBandSample = await sharp(fullPageAsset!.filePath)
      .extract({ left: 960, top: 12410, width: 1, height: 1 })
      .raw()
      .toBuffer();

    expect(greenBandSample[1]).toBeGreaterThan(greenBandSample[0] + 40);
    expect(greenBandSample[1]).toBeGreaterThan(greenBandSample[2] + 40);
    expect(orangeBandSample[0]).toBeGreaterThan(orangeBandSample[1] + 40);
    expect(orangeBandSample[1]).toBeGreaterThan(orangeBandSample[2] + 20);
  }, 30_000);
});

describe("footer scroll reveal preservation", () => {
  it("patches transformed footers from their bottom-scroll visual state", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-footer-reveal-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/scroll-reveal-footer`,
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
    expect(logs.some((message) => message.includes("top_overlay_replaced"))).toBe(true);
    expect(logs.some((message) => message.includes("footer_reveal_replaced"))).toBe(true);

    const metadata = await sharp(fullPageAsset!.filePath).metadata();
    expect(metadata.height).toBe(result.fullPageSize.height);

    const navSample = await sharp(fullPageAsset!.filePath)
      .extract({ left: 99, top: 36, width: 1, height: 1 })
      .raw()
      .toBuffer();
    const markerSample = await sharp(fullPageAsset!.filePath)
      .extract({ left: 960, top: metadata.height! - 312, width: 1, height: 1 })
      .raw()
      .toBuffer();
    const lowerFooterSample = await sharp(fullPageAsset!.filePath)
      .extract({ left: 960, top: metadata.height! - 80, width: 1, height: 1 })
      .raw()
      .toBuffer();

    expect(navSample[0]).toBeGreaterThan(navSample[1] + 80);
    expect(navSample[0]).toBeGreaterThan(navSample[2] + 80);
    expect(markerSample[1]).toBeGreaterThan(markerSample[0] + 50);
    expect(markerSample[1]).toBeGreaterThan(markerSample[2] + 20);
    expect(lowerFooterSample[0]).toBeLessThan(40);
    expect(lowerFooterSample[1]).toBeLessThan(45);
    expect(lowerFooterSample[2]).toBeLessThan(45);
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

describe("split scroll scene unfolding", () => {
  it("expands multi-frame sticky sidebars while preserving the right content column", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-split-scroll-scene-unfold-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/split-scroll-scene-unfold`,
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
    expect(firstScene?.layoutMode).toBe("split_content_unfold");
    expect(firstScene?.distinctFrameCount).toBeGreaterThanOrEqual(4);
    expect(firstScene?.replacementHeight).toBeGreaterThan(firstScene?.outerHeight ?? 0);
    expect(logs.some((message) => message.includes("layoutMode=split_content_unfold"))).toBe(true);

    const rightColumnSamples = await Promise.all(
      Array.from({ length: firstScene!.sampledFrameCount }, async (_value, index) =>
        sharp(fullPageAsset!.filePath)
          .extract({
            left: 1540,
            top: Math.round(firstScene!.outerTop + index * firstScene!.stickyHeight + 56),
            width: 1,
            height: 1,
          })
          .raw()
          .toBuffer(),
      ),
    );
    const leftColumnSamples = await Promise.all(
      Array.from({ length: firstScene!.distinctFrameCount }, async (_value, index) =>
        sharp(fullPageAsset!.filePath)
          .extract({
            left: 420,
            top: Math.round(firstScene!.outerTop + index * firstScene!.stickyHeight + firstScene!.stickyHeight / 2),
            width: 1,
            height: 1,
          })
          .raw()
          .toBuffer(),
      ),
    );

    expect(new Set(rightColumnSamples.map((sample) => `${sample[0]}-${sample[1]}-${sample[2]}`)).size).toBeGreaterThanOrEqual(
      Math.min(5, firstScene!.sampledFrameCount),
    );
    expect(new Set(leftColumnSamples.map((sample) => `${sample[0]}-${sample[1]}-${sample[2]}`)).size).toBeGreaterThanOrEqual(4);

    const lowerRightSample = await sharp(fullPageAsset!.filePath)
      .extract({
        left: 1540,
        top: Math.round(firstScene!.outerTop + (firstScene!.sampledFrameCount - 1) * firstScene!.stickyHeight + 56),
        width: 1,
        height: 1,
      })
      .raw()
      .toBuffer();
    expect(lowerRightSample[0] + lowerRightSample[1] + lowerRightSample[2]).toBeLessThan(700);
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

  it("removes overlays that appear during scroll-scene frame sampling", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-scroll-scene-overlay-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/scroll-scene-overlay`,
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
    expect(firstScene?.layoutMode).toBe("sticky_only_unfold");
    expect(logs.some((message) => message.includes("overlay_action phase=scroll_scene_sampling"))).toBe(true);

    const gap = 24;
    const sampleOffsets = Array.from({ length: firstScene!.distinctFrameCount }, (_value, index) =>
      Math.round(firstScene!.outerTop + index * (firstScene!.stickyHeight + gap) + 300),
    );
    const samples = await Promise.all(
      sampleOffsets.map(async (top) =>
        sharp(fullPageAsset!.filePath)
          .extract({ left: 720, top, width: 1, height: 1 })
          .raw()
          .toBuffer(),
      ),
    );

    for (const sample of samples) {
      expect(sample[0] + sample[1] + sample[2]).toBeLessThan(650);
    }
    expect(new Set(samples.map((sample) => `${sample[0]}-${sample[1]}-${sample[2]}`)).size).toBeGreaterThanOrEqual(3);
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
    expect(logs.some((message) => message.includes("overlay_detected phase=pre_capture type=consent vendor=osano"))).toBe(true);
    expect(logs.some((message) => message.includes("overlay_cleanup_summary phase=pre_capture handled="))).toBe(true);
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
    expect(logs.some((message) => message.includes("overlay_action phase=pre_capture action="))).toBe(true);
  }, 30_000);

  it("removes inline consent cards that become offscreen before the second cleanup pass", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-inline-consent-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/inline-consent-card`,
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
      .extract({ left: 960, top: 1480, width: 1, height: 1 })
      .raw()
      .toBuffer();

    expect(sample[0]).toBeGreaterThan(220);
    expect(sample[1]).toBeGreaterThan(100);
    expect(sample[2]).toBeLessThan(90);
    expect(logs.some((message) => message.includes("overlay_detected phase=pre_capture type=consent vendor=generic"))).toBe(true);
    expect(logs.some((message) => message.includes("overlay_action phase=pre_capture action="))).toBe(true);
  }, 30_000);

  it("removes consent managers that only expose a fixed host node in light DOM", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-transcend-host-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/transcend-host-consent`,
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
      .extract({ left: 960, top: 420, width: 1, height: 1 })
      .raw()
      .toBuffer();

    expect(sample[2]).toBeGreaterThan(sample[1] + 40);
    expect(sample[2]).toBeGreaterThan(sample[0] + 60);
    expect(logs.some((message) => message.includes("overlay_detected phase=pre_capture type=consent vendor=transcend"))).toBe(true);
    expect(logs.some((message) => message.includes("overlay_action phase=pre_capture action=hide_dom_offscreen"))).toBe(true);
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

  it("keeps fixed navigation in section-only hero captures after lazy-load warmup", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-e2e-section-sticky-nav-"));
    const logs: string[] = [];
    const task: ParsedTask = {
      url: `${baseUrl}/section-sticky-nav`,
      waitUntil: "networkidle",
      captures: [{ mode: "section", targetType: "hero" }],
      image: { format: "jpg", quality: 92, dpr: 1 },
      viewport: { width: 1920, height: 1080 },
      tags: ["e2e"],
      eagle: {},
    };

    const result = await captureTask(task, {
      outputDir,
      sectionScope: "manual",
      classicMaxSections: 10,
      log: (_level, message) => logs.push(message),
    });

    const heroAsset = result.assets.find((asset) => asset.kind === "section" && asset.sectionType === "hero");
    expect(heroAsset).toBeTruthy();
    const headerPixel = await sharp(heroAsset!.filePath)
      .extract({ left: 24, top: 24, width: 1, height: 1 })
      .raw()
      .toBuffer();

    expect(headerPixel[0]).toBeGreaterThan(180);
    expect(headerPixel[1]).toBeLessThan(130);
    expect(headerPixel[2]).toBeLessThan(150);
    expect(logs.some((message) => message.includes("fullpage_scroll_stabilized"))).toBe(true);
  }, 20_000);

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
