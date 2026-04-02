import { describe, expect, it } from "vitest";
import {
  filterAndRankFolders,
  formatFolderPathForCard,
  type EagleFolderOption,
} from "../web/src/folder-picker.js";

const folders: EagleFolderOption[] = [
  { id: "pricing", name: "Page_Pricing", path: "Pages/Page_Pricing" },
  { id: "general", name: "Page_General", path: "Pages/Page_General" },
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
      "Pages/Page_Pricing",
      "Sections/Section_CTA",
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
      "Pages/Page_General/Section_C",
    ]);
  });

  it("compacts long folder paths for single-line card display", () => {
    expect(formatFolderPathForCard("Pages/Page_General/Section_C/Deep_Nested_Layer", 28)).toBe(
      "Pages/.../Deep_Nested_Layer",
    );
    expect(formatFolderPathForCard("Pages/Page_Pricing", 28)).toBe("Pages/Page_Pricing");
  });
});
