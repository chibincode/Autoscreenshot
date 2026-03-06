import { describe, expect, it } from "vitest";
import {
  computeDeprecatedRuleIds,
  syncRulesToNotion,
  toNotionRuleProperties,
  type RemoteRulePage,
} from "../src/rules/notion-sync.js";
import type { RuleRegistryRow } from "../src/rules/types.js";

function makeRow(id: string): RuleRegistryRow {
  return {
    id,
    layer: "section_classifier",
    category: "keyword",
    target: "hero",
    expression: "keyword includes hero -> +2",
    sourceFile: "src/browser/section-detector.ts",
    sourceAnchor: "keywordSets",
    score: 2,
    priority: "P2",
    status: "active",
    examples: "hero",
    lastVerified: "2026-03-06",
  };
}

describe("notion sync helpers", () => {
  it("computes deprecated ids from remote not in local", () => {
    const remotePages: RemoteRulePage[] = [
      { pageId: "p1", ruleId: "a", status: "active" },
      { pageId: "p2", ruleId: "b", status: "active" },
      { pageId: "p3", ruleId: "c", status: "deprecated" },
    ];

    const result = computeDeprecatedRuleIds(["a"], remotePages);
    expect(result).toEqual(["b"]);
  });

  it("builds notion properties and keeps empty fields safe", () => {
    const row = {
      ...makeRow("section_classifier:keyword:hero"),
      score: null,
      examples: "",
      sourceAnchor: undefined,
    };
    const properties = toNotionRuleProperties(row, { includeRuleId: true });

    expect(properties["Rule ID"]).toBeDefined();
    expect(properties["Weight/Score"]).toEqual({ number: null });
    expect((properties.Examples as { rich_text: unknown[] }).rich_text).toEqual([]);
  });

  it("syncs create/update and marks missing as deprecated", async () => {
    const rows = [makeRow("rule_local")];

    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });

      if (url.endsWith("/databases/123456781234123412341234567890ab/query")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                properties: {
                  "Rule ID": { title: [{ plain_text: "rule_local" }] },
                  Status: { select: { name: "active" } },
                },
              },
              {
                id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                properties: {
                  "Rule ID": { title: [{ plain_text: "rule_stale" }] },
                  Status: { select: { name: "active" } },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200 },
        );
      }

      if (url.includes("/pages/") && method === "PATCH") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      if (url.endsWith("/pages") && method === "POST") {
        return new Response(JSON.stringify({ id: "new_page" }), { status: 200 });
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const summary = await syncRulesToNotion(
      rows,
      {
        apiKey: "token",
        databaseId: "123456781234123412341234567890ab",
      },
      fetchMock,
    );

    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(1);
    expect(summary.deprecated).toBe(1);

    const deprecatedCall = calls.find(
      (call) => call.url.includes("/pages/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") && call.method === "PATCH",
    );
    expect(deprecatedCall).toBeDefined();
  });
});
