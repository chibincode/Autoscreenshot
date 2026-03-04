import { describe, expect, it } from "vitest";
import { normalizeEagleFolderRules } from "../src/core/eagle-folder-rules.js";
import {
  buildFolderIndex,
  resolveFullPageFolder,
  resolveSectionFolder,
} from "../src/core/folder-resolver.js";

describe("folder resolver", () => {
  it("uses explicit section mapping when folder id exists", () => {
    const rules = normalizeEagleFolderRules({
      sections: {
        hero: {
          folderId: "hero-id",
        },
      },
    });
    const folderIndex = buildFolderIndex([
      { id: "hero-id", name: "Section_Hero", path: "Section_Hero" },
    ]);
    const result = resolveSectionFolder("hero", rules, folderIndex);
    expect(result).toEqual({
      folderId: "hero-id",
      resolvedBy: "explicit",
      reason: "mapped",
    });
  });

  it("falls back to unique name match when explicit id is missing", () => {
    const rules = normalizeEagleFolderRules({
      fallbackByName: true,
      sections: {
        hero: {
          folderId: "missing-id",
          nameHints: ["section_hero"],
        },
      },
    });
    const folderIndex = buildFolderIndex([
      { id: "hero-real", name: "Section_Hero", path: "Section_Hero" },
    ]);
    const result = resolveSectionFolder("hero", rules, folderIndex);
    expect(result).toEqual({
      folderId: "hero-real",
      resolvedBy: "name_fallback",
      reason: "mapped",
    });
  });

  it("falls back to root when name fallback is ambiguous", () => {
    const rules = normalizeEagleFolderRules({
      fallbackByName: true,
      sections: {
        blog: {
          nameHints: ["blog"],
        },
      },
    });
    const folderIndex = buildFolderIndex([
      { id: "blog-list", name: "Page_Blog list", path: "Page_Blog list" },
      { id: "blog-detail", name: "Page_Blog Detail", path: "Page_Blog Detail" },
    ]);
    const result = resolveSectionFolder("blog", rules, folderIndex);
    expect(result).toEqual({
      folderId: undefined,
      resolvedBy: "root",
      reason: "ambiguous_name",
    });
  });

  it("falls back to root when full page type is unmatched", () => {
    const rules = normalizeEagleFolderRules({});
    const folderIndex = buildFolderIndex([
      { id: "home-id", name: "Page_Home", path: "Page_Home" },
    ]);
    const result = resolveFullPageFolder("unmatched", rules, folderIndex);
    expect(result).toEqual({
      folderId: undefined,
      resolvedBy: "root",
      reason: "type_unmatched",
    });
  });
});
