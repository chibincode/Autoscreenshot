import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importManifestAssets } from "../src/core/job-service.js";
import type { RunManifest } from "../src/types.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("import routing", () => {
  it("uses existing folders without calling folder/create", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-routing-"));
    const originalCwd = process.cwd();
    process.chdir(tmpDir);

    try {
      await fs.mkdir(path.join(tmpDir, "data"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, "data", "eagle-folder-rules.json"),
        JSON.stringify(
          {
            version: 1,
            policy: { allowCreateFolder: false, missingFolderBehavior: "root" },
            fallbackByName: true,
            urlNormalization: {
              stripQuery: true,
              stripHash: true,
              stripLocalePrefix: true,
            },
            sections: {
              hero: {
                folderId: "hero-folder-id",
                nameHints: ["section_hero"],
              },
            },
            fullPage: {
              pricing: {
                folderId: "page-pricing-id",
                pathRules: ["/pricing"],
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const outputDir = path.join(tmpDir, "output", "job-1");
      await fs.mkdir(outputDir, { recursive: true });
      const heroPath = path.join(outputDir, "hero.jpg");
      const fullPath = path.join(outputDir, "full.jpg");
      const faqPath = path.join(outputDir, "faq.jpg");
      await fs.writeFile(heroPath, "hero");
      await fs.writeFile(fullPath, "full");
      await fs.writeFile(faqPath, "faq");

      const manifest: RunManifest = {
        runId: "job-1",
        instruction: "open https://example.com/pricing and capture",
        createdAt: new Date().toISOString(),
        sectionScope: "classic",
        outputDir,
        task: {
          url: "https://example.com/pricing",
          waitUntil: "networkidle",
          captures: [{ mode: "fullPage" }, { mode: "section" }],
          image: {
            format: "jpg",
            quality: 92,
            dpr: 2,
          },
          viewport: {
            width: 1920,
            height: 1080,
          },
          tags: [],
          eagle: {},
        },
        assets: [
          {
            kind: "section",
            sectionType: "hero",
            label: "hero",
            filePath: heroPath,
            fileName: "hero.jpg",
            sourceUrl: "https://example.com/pricing",
            quality: 92,
            dpr: 2,
            capturedAt: new Date().toISOString(),
            import: { ok: false, error: "Pending import" },
          },
          {
            kind: "fullPage",
            label: "full_page",
            filePath: fullPath,
            fileName: "full.jpg",
            sourceUrl: "https://example.com/pricing?campaign=abc#top",
            quality: 92,
            dpr: 2,
            capturedAt: new Date().toISOString(),
            import: { ok: false, error: "Pending import" },
          },
          {
            kind: "section",
            sectionType: "faq",
            label: "faq",
            filePath: faqPath,
            fileName: "faq.jpg",
            sourceUrl: "https://example.com/pricing",
            quality: 92,
            dpr: 2,
            capturedAt: new Date().toISOString(),
            import: { ok: false, error: "Pending import" },
          },
        ],
      };

      const manifestPath = path.join(outputDir, "manifest.json");
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

      const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
      global.fetch = (async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        let body: Record<string, unknown> | undefined;
        if (typeof init?.body === "string") {
          body = JSON.parse(init.body);
        }
        requests.push({ url, method, body });

        if (url.endsWith("/api/library/info")) {
          return new Response(JSON.stringify({ status: "success", data: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/api/folder/list")) {
          return new Response(
            JSON.stringify({
              status: "success",
              data: [
                { id: "hero-folder-id", name: "Section_Hero", children: [] },
                { id: "page-pricing-id", name: "Page_Pricing", children: [] },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.endsWith("/api/item/addFromPath")) {
          return new Response(JSON.stringify({ status: "success", data: { id: "item-1" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ status: "error", message: "unexpected endpoint" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const result = await importManifestAssets(manifest, manifestPath);

      const createFolderCalls = requests.filter((request) => request.url.endsWith("/api/folder/create"));
      expect(createFolderCalls.length).toBe(0);

      const addCalls = requests.filter((request) => request.url.endsWith("/api/item/addFromPath"));
      expect(addCalls.length).toBe(3);
      expect(addCalls[0].body?.folderId).toBe("hero-folder-id");
      expect(addCalls[1].body?.folderId).toBe("page-pricing-id");
      expect(addCalls[2].body?.folderId).toBeUndefined();

      expect(result.assets.every((asset) => asset.import.ok)).toBe(true);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
