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

  it("routes unknown sections to Section_Gerneral when present", () => {
    const rules = normalizeEagleFolderRules({});
    const folderIndex = buildFolderIndex([
      { id: "section-general-id", name: "Section_Gerneral", path: "Sections/Section_Gerneral" },
    ]);
    const result = resolveSectionFolder("unknown", rules, folderIndex);
    expect(result).toEqual({
      folderId: "section-general-id",
      resolvedBy: "generic_fallback",
      reason: "default_general",
    });
  });

  it("routes unmatched full pages to Page_Gerneral when present", () => {
    const rules = normalizeEagleFolderRules({});
    const folderIndex = buildFolderIndex([
      { id: "page-general-id", name: "Page_Gerneral", path: "Pages/Page_Gerneral" },
    ]);
    const result = resolveFullPageFolder("unmatched", rules, folderIndex);
    expect(result).toEqual({
      folderId: "page-general-id",
      resolvedBy: "generic_fallback",
      reason: "default_general",
    });
  });

  it("routes explicit project page types to their mapped Eagle folders", () => {
    const rules = normalizeEagleFolderRules({
      fullPage: {
        projects_list: {
          folderId: "project-list-id",
          pathRules: ["/projects"],
        },
        project_detail: {
          folderId: "project-detail-id",
          pathRules: ["/projects/:slug"],
        },
      },
    });
    const folderIndex = buildFolderIndex([
      { id: "project-list-id", name: "Page_Project list", path: "作品包装/网站/Page_Project list" },
      { id: "project-detail-id", name: "Page_Projiect Detail", path: "作品包装/网站/Page_Projiect Detail" },
    ]);

    expect(resolveFullPageFolder("projects_list", rules, folderIndex)).toEqual({
      folderId: "project-list-id",
      resolvedBy: "explicit",
      reason: "mapped",
    });
    expect(resolveFullPageFolder("project_detail", rules, folderIndex)).toEqual({
      folderId: "project-detail-id",
      resolvedBy: "explicit",
      reason: "mapped",
    });
  });

  it("does not send classified sections to general when explicit mapping is broken", () => {
    const rules = normalizeEagleFolderRules({
      sections: {
        hero: {
          folderId: "missing-hero-id",
        },
      },
    });
    const folderIndex = buildFolderIndex([
      { id: "section-general-id", name: "Section_Gerneral", path: "Sections/Section_Gerneral" },
    ]);
    const result = resolveSectionFolder("hero", rules, folderIndex);
    expect(result).toEqual({
      folderId: undefined,
      resolvedBy: "root",
      reason: "missing_id",
    });
  });
});
