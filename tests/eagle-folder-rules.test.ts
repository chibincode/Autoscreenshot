import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getEagleFolderRulesPath,
  loadEagleFolderRules,
  normalizeEagleFolderRules,
} from "../src/core/eagle-folder-rules.js";

describe("eagle-folder-rules", () => {
  it("applies defaults for partial config", () => {
    const rules = normalizeEagleFolderRules({
      sections: {
        hero: {
          folderId: "hero-folder",
        },
      },
    });

    expect(rules.policy.allowCreateFolder).toBe(false);
    expect(rules.policy.missingFolderBehavior).toBe("root");
    expect(rules.urlNormalization.stripLocalePrefix).toBe(true);
    expect(rules.sections.hero?.folderId).toBe("hero-folder");
    expect(rules.fullPage.home).toBeUndefined();
  });

  it("falls back to root behavior when rules file is missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-rules-missing-"));
    const result = await loadEagleFolderRules(tmpDir);
    expect(result.loadedFromFile).toBe(false);
    expect(result.path).toBe(getEagleFolderRulesPath(tmpDir));
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.rules.sections.hero).toBeUndefined();
    expect(result.rules.fullPage.home).toBeUndefined();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("falls back to root behavior on invalid json", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autosnap-rules-invalid-"));
    const rulesPath = getEagleFolderRulesPath(tmpDir);
    await fs.mkdir(path.dirname(rulesPath), { recursive: true });
    await fs.writeFile(rulesPath, "{ invalid json", "utf8");

    const result = await loadEagleFolderRules(tmpDir);
    expect(result.loadedFromFile).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.rules.sections.hero).toBeUndefined();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
