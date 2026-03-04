import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureRunResult, ParsedTask } from "../src/types.js";

const parseInstructionMock = vi.fn();
const captureTaskMock = vi.fn();

vi.mock("../src/ai/intent-parser.js", () => ({
  parseInstruction: parseInstructionMock,
}));

vi.mock("../src/browser/capture.js", () => ({
  captureTask: captureTaskMock,
}));

vi.mock("../src/eagle/client.js", () => ({
  EagleClient: class {
    async healthCheck(): Promise<boolean> {
      return false;
    }

    async listFolders(): Promise<[]> {
      return [];
    }

    flattenFolders(): [] {
      return [];
    }
  },
}));

describe("section debug manifest wiring", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("persists sectionDebug in manifest after executeInstruction", async () => {
    vi.resetModules();
    const { executeInstruction } = await import("../src/core/job-service.js");

    const task: ParsedTask = {
      url: "https://example.com",
      waitUntil: "networkidle",
      captures: [{ mode: "fullPage" }, { mode: "section" }],
      image: { format: "jpg", quality: 92, dpr: "auto" },
      viewport: { width: 1920, height: 1080 },
      tags: ["debug"],
      eagle: {},
    };

    const runResult: CaptureRunResult = {
      assets: [
        {
          kind: "section",
          sectionType: "testimonial",
          label: "testimonial",
          filePath: "/tmp/testimonial.jpg",
          fileName: "testimonial.jpg",
          sourceUrl: "https://example.com",
          quality: 92,
          dpr: 2,
          capturedAt: new Date().toISOString(),
        },
      ],
      usedDpr: 2,
      fallbackToDpr1: false,
      viewport: { width: 1920, height: 1080 },
      fullPageSize: { width: 1920, height: 3600 },
      sectionDebug: {
        scope: "classic",
        viewportHeight: 1080,
        rawCandidates: [
          {
            selector: "#testimonials",
            tagName: "section",
            sectionType: "testimonial",
            confidence: 0.91,
            bbox: { x: 0, y: 1280, width: 1920, height: 420 },
            textPreview: "Hear from our customers.",
            scores: {
              hero: 0,
              feature: 1,
              testimonial: 6,
              pricing: 0,
              team: 0,
              faq: 2,
              blog: 0,
              cta: 0,
              contact: 0,
              footer: 0,
              unknown: 0,
            },
            signals: [
              { label: "testimonial", weight: 3, rule: "phrase:hear_from_our_customers" },
              { label: "faq", weight: -1, rule: "conflict:testimonial_strong" },
            ],
          },
        ],
        mergedCandidates: [],
        selectedCandidates: [],
      },
    };

    parseInstructionMock.mockResolvedValue(task);
    captureTaskMock.mockResolvedValue(runResult);

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-section-debug-"));
    try {
      const result = await executeInstruction({
        instruction: "open https://example.com and capture",
        cwd,
        runId: "job-debug-manifest",
      });

      expect(result.manifest.sectionDebug).toBeDefined();
      expect(result.manifest.sectionDebug?.rawCandidates.length).toBe(1);
      expect(Array.isArray(result.manifest.sectionDebug?.mergedCandidates)).toBe(true);
      expect(Array.isArray(result.manifest.sectionDebug?.selectedCandidates)).toBe(true);
      expect(result.manifest.sectionDebug?.rawCandidates[0]?.sectionType).toBe(
        "testimonial",
      );

      const raw = await fs.readFile(result.manifestPath, "utf8");
      const saved = JSON.parse(raw) as {
        sectionDebug?: {
          rawCandidates?: unknown[];
          mergedCandidates?: unknown[];
          selectedCandidates?: unknown[];
        };
      };
      expect(saved.sectionDebug?.rawCandidates?.length).toBe(1);
      expect(Array.isArray(saved.sectionDebug?.mergedCandidates)).toBe(true);
      expect(Array.isArray(saved.sectionDebug?.selectedCandidates)).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
