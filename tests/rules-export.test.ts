import { describe, expect, it } from "vitest";
import { collectRuleRegistryRows } from "../src/rules/exporter.js";

describe("rules exporter", () => {
  it("extracts rules from all three layers with stable unique ids", async () => {
    const rows = await collectRuleRegistryRows(process.cwd(), "2026-03-06");

    expect(rows.length).toBeGreaterThan(0);
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);

    const layers = new Set(rows.map((row) => row.layer));
    expect(layers.has("section_classifier")).toBe(true);
    expect(layers.has("fullpage_classifier")).toBe(true);
    expect(layers.has("eagle_mapping")).toBe(true);

    expect(
      rows.some((row) =>
        row.id.includes("section_classifier:phrase:testimonial_wall_of_love"),
      ),
    ).toBe(true);

    expect(
      rows.some(
        (row) =>
          row.layer === "eagle_mapping" &&
          row.category === "path_rule" &&
          row.expression.includes("/about-us"),
      ),
    ).toBe(true);
  });
});
