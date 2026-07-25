import { describe, expect, it } from "vitest";
import {
  filterAndRankFolders,
  formatFolderPathForCard,
  parseRecentFolderIds,
  rememberRecentFolderId,
  type EagleFolderOption,
} from "../web/src/folder-picker.js";

const folders: EagleFolderOption[] = [
  { id: "pricing", name: "Page_Pricing", path: "Pages/Page_Pricing" },
  { id: "general", name: "Page_General", path: "Pages/Page_General" },
  { id: "gerneral-legacy", name: "Page_Gerneral", path: "Pages/Page_Gerneral" },
  { id: "project-list", name: "Page_Project list", path: "Pages/Page_Project list" },
  { id: "project-detail-legacy", name: "Page_Projiect Detail", path: "Pages/Page_Projiect Detail" },
  { id: "section-c", name: "Section_C", path: "Pages/Page_General/Section_C" },
  { id: "cta", name: "Section_CTA", path: "Sections/Section_CTA" },
];

describe("folder picker helpers", () => {
  it("returns a stable default order with current and suggested folders pinned first", () => {
    const result = filterAndRankFolders(
      folders,
      "",
      "Pages/Page_General/Section_C",
      "Pages/Page_General",
    ).map((item) => item.folder.path);

    expect(result).toEqual([
      "Pages/Page_General/Section_C",
      "Pages/Page_General",
      "Pages/Page_Gerneral",
      "Pages/Page_Pricing",
      "Pages/Page_Project list",
      "Pages/Page_Projiect Detail",
      "Sections/Section_CTA",
    ]);
  });

  it("puts recently used folders after the current folder in recency order", () => {
    const result = filterAndRankFolders(
      folders,
      "",
      "Pages/Page_General/Section_C",
      "Pages/Page_General",
      ["cta", "pricing"],
    );

    expect(result.map((item) => item.folder.id)).toEqual([
      "section-c",
      "cta",
      "pricing",
      "general",
      "gerneral-legacy",
      "project-list",
      "project-detail-legacy",
    ]);
    expect(result.find((item) => item.folder.id === "cta")?.isRecent).toBe(true);
    expect(result.find((item) => item.folder.id === "section-c")?.isRecent).toBe(false);
  });

  it("uses recency only as a tie-breaker while searching", () => {
    const result = filterAndRankFolders(
      folders,
      "section",
      null,
      null,
      ["cta", "section-c"],
    ).map((item) => item.folder.id);

    expect(result).toEqual(["cta", "section-c"]);
  });

  it("parses and updates bounded recent folder history", () => {
    expect(parseRecentFolderIds('["pricing","cta","pricing","",42]')).toEqual([
      "pricing",
      "cta",
    ]);
    expect(parseRecentFolderIds("not-json")).toEqual([]);
    expect(rememberRecentFolderId(["pricing", "cta", "general"], "cta", 3)).toEqual([
      "cta",
      "pricing",
      "general",
    ]);
  });

  it("matches folders by both path and folder name", () => {
    const byPath = filterAndRankFolders(folders, "pages/page_general/section", null, null).map(
      (item) => item.folder.id,
    );
    const byName = filterAndRankFolders(folders, "section_c", null, null).map((item) => item.folder.id);

    expect(byPath).toEqual(["section-c"]);
    expect(byName).toEqual(["section-c", "cta"]);
  });

  it("ranks exact matches ahead of prefix and contains matches", () => {
    const result = filterAndRankFolders(folders, "page_general", null, null).map((item) => item.folder.path);

    expect(result).toEqual([
      "Pages/Page_General",
      "Pages/Page_Gerneral",
      "Pages/Page_General/Section_C",
    ]);
  });

  it("matches known historical typos when searching for project and general folders", () => {
    const projectResult = filterAndRankFolders(folders, "project", null, null).map((item) => item.folder.id);
    const generalResult = filterAndRankFolders(folders, "general", null, null).map((item) => item.folder.id);

    expect(projectResult).toEqual(["project-list", "project-detail-legacy"]);
    expect(generalResult).toEqual(["general", "section-c", "gerneral-legacy"]);
  });

  it("compacts long folder paths for single-line card display", () => {
    expect(formatFolderPathForCard("Pages/Page_General/Section_C/Deep_Nested_Layer", 28)).toBe(
      "Pages/.../Deep_Nested_Layer",
    );
    expect(formatFolderPathForCard("Pages/Page_Pricing", 28)).toBe("Pages/Page_Pricing");
  });
});
