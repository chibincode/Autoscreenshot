import { promises as fs } from "node:fs";
import path from "node:path";
import type { RuleCategory, RuleExportResult, RuleLayer, RulePriority, RuleRegistryRow } from "./types.js";

interface EagleRulesFile {
  urlNormalization: {
    stripQuery: boolean;
    stripHash: boolean;
    stripLocalePrefix: boolean;
  };
  sections: Record<string, { folderId?: string; nameHints?: string[] }>;
  fullPage: Record<string, { folderId?: string; pathRules?: string[] }>;
}

interface ExportOptions {
  projectRoot?: string;
  outputDir?: string;
  lastVerifiedDate?: string;
}

const SECTION_DETECTOR_PATH = "src/browser/section-detector.ts";
const FULLPAGE_CLASSIFIER_PATH = "src/core/fullpage-classifier.ts";
const EAGLE_RULES_PATH = "data/eagle-folder-rules.json";

function slugifyKey(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function inferPriority(category: RuleCategory, expression: string): RulePriority {
  if (category === "conflict" || category === "dedupe") {
    return "P0";
  }
  if (expression.includes("hard:")) {
    return "P0";
  }
  if (category === "path_rule" || category === "folder_map" || category === "phrase") {
    return "P1";
  }
  return "P2";
}

function createRow(params: {
  id: string;
  layer: RuleLayer;
  category: RuleCategory;
  target: string;
  expression: string;
  sourceFile: string;
  sourceAnchor?: string;
  score?: number | null;
  examples?: string;
  priority?: RulePriority;
  lastVerified: string;
}): RuleRegistryRow {
  return {
    id: params.id,
    layer: params.layer,
    category: params.category,
    target: params.target,
    expression: params.expression,
    sourceFile: params.sourceFile,
    sourceAnchor: params.sourceAnchor,
    score: params.score ?? null,
    priority: params.priority ?? inferPriority(params.category, params.expression),
    status: "active",
    examples: params.examples ?? "",
    lastVerified: params.lastVerified,
  };
}

function extractArrayBlock(content: string, variableName: string): string[] {
  const matcher = new RegExp(`const\\s+${variableName}\\s*=\\s*\\[([\\s\\S]*?)\\];`, "m");
  const match = content.match(matcher);
  if (!match?.[1]) {
    return [];
  }
  const values: string[] = [];
  const stringRegex = /"([^"]+)"/g;
  for (const captured of match[1].matchAll(stringRegex)) {
    values.push(captured[1]);
  }
  return values;
}

function extractObjectArrayMap(content: string, variableName: string): Record<string, string[]> {
  const matcher = new RegExp(`const\\s+${variableName}[\\s\\S]*?=\\s*\\{([\\s\\S]*?)\\n\\s*};`, "m");
  const match = content.match(matcher);
  if (!match?.[1]) {
    return {};
  }
  const block = match[1];
  const entryRegex = /(\w+)\s*:\s*\[([\s\S]*?)\],/g;
  const result: Record<string, string[]> = {};
  for (const entry of block.matchAll(entryRegex)) {
    const key = entry[1];
    const listPart = entry[2];
    const values = [...listPart.matchAll(/"([^"]+)"/g)].map((item) => item[1]);
    result[key] = values;
  }
  return result;
}

function extractConstNumber(content: string, variableName: string): number | null {
  const matcher = new RegExp(`const\\s+${variableName}\\s*=\\s*([0-9.]+);`);
  const match = content.match(matcher);
  if (!match) {
    return null;
  }
  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

function extractClassicQuotas(content: string): Array<{ type: string; quota: number }> {
  const matcher = /const\s+CLASSIC_TYPE_QUOTAS[\s\S]*?=\s*\{([\s\S]*?)\};/m;
  const match = content.match(matcher);
  if (!match?.[1]) {
    return [];
  }
  const rows: Array<{ type: string; quota: number }> = [];
  const entryRegex = /(\w+)\s*:\s*(\d+)/g;
  for (const entry of match[1].matchAll(entryRegex)) {
    rows.push({ type: entry[1], quota: Number(entry[2]) });
  }
  return rows;
}

function extractAddScoreRules(content: string): Array<{ target: string; score: number; rule: string }> {
  const rules: Array<{ target: string; score: number; rule: string }> = [];
  const regex = /addScore\("([^"]+)",\s*(-?\d+(?:\.\d+)?),\s*"([^"]+)"\);/g;
  for (const match of content.matchAll(regex)) {
    rules.push({
      target: match[1],
      score: Number(match[2]),
      rule: match[3],
    });
  }
  return rules;
}

function extractSectionRows(content: string, lastVerified: string): RuleRegistryRow[] {
  const rows: RuleRegistryRow[] = [];

  const keywordSets = extractObjectArrayMap(content, "keywordSets");
  for (const [target, keywords] of Object.entries(keywordSets)) {
    for (const keyword of keywords) {
      rows.push(
        createRow({
          id: `section_classifier:keyword:${target}_${slugifyKey(keyword)}`,
          layer: "section_classifier",
          category: "keyword",
          target,
          expression: `keyword includes \"${keyword}\" -> +2`,
          sourceFile: SECTION_DETECTOR_PATH,
          sourceAnchor: "keywordSets",
          score: 2,
          examples: keyword,
          lastVerified,
        }),
      );
    }
  }

  for (const phrase of extractArrayBlock(content, "testimonialPhrases")) {
    rows.push(
      createRow({
        id: `section_classifier:phrase:testimonial_${slugifyKey(phrase)}`,
        layer: "section_classifier",
        category: "phrase",
        target: "testimonial",
        expression: `testimonial phrase \"${phrase}\" -> +5`,
        sourceFile: SECTION_DETECTOR_PATH,
        sourceAnchor: "testimonialPhrases",
        score: 5,
        examples: phrase,
        lastVerified,
      }),
    );
  }

  for (const phrase of extractArrayBlock(content, "faqStrongPhrases")) {
    rows.push(
      createRow({
        id: `section_classifier:phrase:faq_${slugifyKey(phrase)}`,
        layer: "section_classifier",
        category: "phrase",
        target: "faq",
        expression: `faq strong phrase \"${phrase}\" -> +6`,
        sourceFile: SECTION_DETECTOR_PATH,
        sourceAnchor: "faqStrongPhrases",
        score: 6,
        examples: phrase,
        lastVerified,
      }),
    );
  }

  for (const phrase of extractArrayBlock(content, "ctaPhrases")) {
    rows.push(
      createRow({
        id: `section_classifier:phrase:cta_${slugifyKey(phrase)}`,
        layer: "section_classifier",
        category: "phrase",
        target: "cta",
        expression: `cta phrase \"${phrase}\" -> +3`,
        sourceFile: SECTION_DETECTOR_PATH,
        sourceAnchor: "ctaPhrases",
        score: 3,
        examples: phrase,
        lastVerified,
      }),
    );
  }

  for (const addScoreRule of extractAddScoreRules(content)) {
    const category: RuleCategory = addScoreRule.rule.startsWith("conflict:")
      ? "conflict"
      : addScoreRule.rule.startsWith("hard:")
        ? "heuristic"
        : addScoreRule.rule.startsWith("dedupe:")
          ? "dedupe"
          : "heuristic";

    if (
      addScoreRule.rule.startsWith("hard:") ||
      addScoreRule.rule.startsWith("conflict:") ||
      addScoreRule.rule.startsWith("dedupe:")
    ) {
      rows.push(
        createRow({
          id: `section_classifier:${category}:${slugifyKey(addScoreRule.rule)}`,
          layer: "section_classifier",
          category,
          target: addScoreRule.target,
          expression: `${addScoreRule.rule} -> ${addScoreRule.score >= 0 ? "+" : ""}${addScoreRule.score}`,
          sourceFile: SECTION_DETECTOR_PATH,
          sourceAnchor: "classifySectionCandidate",
          score: addScoreRule.score,
          lastVerified,
        }),
      );
    }
  }

  for (const type of extractArrayBlock(content, "CLASSIC_ORDER")) {
    rows.push(
      createRow({
        id: `section_classifier:selection:classic_order_${slugifyKey(type)}`,
        layer: "section_classifier",
        category: "selection",
        target: type,
        expression: `classic selection order contains ${type}`,
        sourceFile: SECTION_DETECTOR_PATH,
        sourceAnchor: "CLASSIC_ORDER",
        lastVerified,
      }),
    );
  }

  for (const quota of extractClassicQuotas(content)) {
    rows.push(
      createRow({
        id: `section_classifier:selection:quota_${slugifyKey(quota.type)}`,
        layer: "section_classifier",
        category: "selection",
        target: quota.type,
        expression: `classic quota ${quota.type} <= ${quota.quota}`,
        sourceFile: SECTION_DETECTOR_PATH,
        sourceAnchor: "CLASSIC_TYPE_QUOTAS",
        score: quota.quota,
        lastVerified,
      }),
    );
  }

  const dedupeThreshold = extractConstNumber(content, "CLIP_DEDUPE_IOU_THRESHOLD");
  if (dedupeThreshold !== null) {
    rows.push(
      createRow({
        id: "section_classifier:dedupe:clip_iou_threshold",
        layer: "section_classifier",
        category: "dedupe",
        target: "classic_sections",
        expression: `clip IoU >= ${dedupeThreshold} considered duplicate`,
        sourceFile: SECTION_DETECTOR_PATH,
        sourceAnchor: "CLIP_DEDUPE_IOU_THRESHOLD",
        score: dedupeThreshold,
        lastVerified,
      }),
    );
  }

  return rows;
}

function extractFullPageRows(content: string, lastVerified: string): RuleRegistryRow[] {
  const rows: RuleRegistryRow[] = [];

  for (const type of extractArrayBlock(content, "FULL_PAGE_MATCH_ORDER")) {
    rows.push(
      createRow({
        id: `fullpage_classifier:selection:match_order_${slugifyKey(type)}`,
        layer: "fullpage_classifier",
        category: "selection",
        target: type,
        expression: `fullPage match order includes ${type}`,
        sourceFile: FULLPAGE_CLASSIFIER_PATH,
        sourceAnchor: "FULL_PAGE_MATCH_ORDER",
        lastVerified,
      }),
    );
  }

  rows.push(
    createRow({
      id: "fullpage_classifier:normalization:strip_query",
      layer: "fullpage_classifier",
      category: "normalization",
      target: "pathname",
      expression: "strip query from pathname when rules.urlNormalization.stripQuery=true",
      sourceFile: FULLPAGE_CLASSIFIER_PATH,
      sourceAnchor: "normalizePathnameForClassification",
      lastVerified,
    }),
    createRow({
      id: "fullpage_classifier:normalization:strip_hash",
      layer: "fullpage_classifier",
      category: "normalization",
      target: "pathname",
      expression: "strip hash from pathname when rules.urlNormalization.stripHash=true",
      sourceFile: FULLPAGE_CLASSIFIER_PATH,
      sourceAnchor: "normalizePathnameForClassification",
      lastVerified,
    }),
    createRow({
      id: "fullpage_classifier:normalization:strip_locale_prefix",
      layer: "fullpage_classifier",
      category: "normalization",
      target: "pathname",
      expression: "strip locale prefix (/en, /zh-cn) when rules.urlNormalization.stripLocalePrefix=true",
      sourceFile: FULLPAGE_CLASSIFIER_PATH,
      sourceAnchor: "normalizePathnameForClassification",
      lastVerified,
    }),
    createRow({
      id: "fullpage_classifier:path_rule:exact_match",
      layer: "fullpage_classifier",
      category: "path_rule",
      target: "pathRules",
      expression: "exact pathname match against rule",
      sourceFile: FULLPAGE_CLASSIFIER_PATH,
      sourceAnchor: "matchPathRule",
      lastVerified,
    }),
    createRow({
      id: "fullpage_classifier:path_rule:wildcard_suffix",
      layer: "fullpage_classifier",
      category: "path_rule",
      target: "pathRules",
      expression: "rule ending with /* matches subpath prefix",
      sourceFile: FULLPAGE_CLASSIFIER_PATH,
      sourceAnchor: "matchPathRule",
      lastVerified,
    }),
    createRow({
      id: "fullpage_classifier:path_rule:slug_token",
      layer: "fullpage_classifier",
      category: "path_rule",
      target: "pathRules",
      expression: ":slug token compiles to [^/]+",
      sourceFile: FULLPAGE_CLASSIFIER_PATH,
      sourceAnchor: "matchPathRule",
      lastVerified,
    }),
  );

  return rows;
}

function extractEagleRows(eagleRules: EagleRulesFile, lastVerified: string): RuleRegistryRow[] {
  const rows: RuleRegistryRow[] = [];

  rows.push(
    createRow({
      id: "eagle_mapping:normalization:strip_query",
      layer: "eagle_mapping",
      category: "normalization",
      target: "source_url",
      expression: `stripQuery=${String(eagleRules.urlNormalization.stripQuery)}`,
      sourceFile: EAGLE_RULES_PATH,
      sourceAnchor: "urlNormalization.stripQuery",
      lastVerified,
    }),
    createRow({
      id: "eagle_mapping:normalization:strip_hash",
      layer: "eagle_mapping",
      category: "normalization",
      target: "source_url",
      expression: `stripHash=${String(eagleRules.urlNormalization.stripHash)}`,
      sourceFile: EAGLE_RULES_PATH,
      sourceAnchor: "urlNormalization.stripHash",
      lastVerified,
    }),
    createRow({
      id: "eagle_mapping:normalization:strip_locale_prefix",
      layer: "eagle_mapping",
      category: "normalization",
      target: "source_url",
      expression: `stripLocalePrefix=${String(eagleRules.urlNormalization.stripLocalePrefix)}`,
      sourceFile: EAGLE_RULES_PATH,
      sourceAnchor: "urlNormalization.stripLocalePrefix",
      lastVerified,
    }),
  );

  for (const [sectionType, mapping] of Object.entries(eagleRules.sections)) {
    rows.push(
      createRow({
        id: `eagle_mapping:folder_map:section_${slugifyKey(sectionType)}_folder`,
        layer: "eagle_mapping",
        category: "folder_map",
        target: sectionType,
        expression: `section folderId=${mapping.folderId ?? "<none>"}`,
        sourceFile: EAGLE_RULES_PATH,
        sourceAnchor: `sections.${sectionType}.folderId`,
        lastVerified,
      }),
    );

    for (const hint of mapping.nameHints ?? []) {
      rows.push(
        createRow({
          id: `eagle_mapping:folder_map:section_${slugifyKey(sectionType)}_hint_${slugifyKey(hint)}`,
          layer: "eagle_mapping",
          category: "folder_map",
          target: sectionType,
          expression: `name hint \"${hint}\"`,
          sourceFile: EAGLE_RULES_PATH,
          sourceAnchor: `sections.${sectionType}.nameHints`,
          examples: hint,
          lastVerified,
        }),
      );
    }
  }

  for (const [fullPageType, mapping] of Object.entries(eagleRules.fullPage)) {
    rows.push(
      createRow({
        id: `eagle_mapping:folder_map:fullpage_${slugifyKey(fullPageType)}_folder`,
        layer: "eagle_mapping",
        category: "folder_map",
        target: fullPageType,
        expression: `fullPage folderId=${mapping.folderId ?? "<none>"}`,
        sourceFile: EAGLE_RULES_PATH,
        sourceAnchor: `fullPage.${fullPageType}.folderId`,
        lastVerified,
      }),
    );

    for (const pathRule of mapping.pathRules ?? []) {
      rows.push(
        createRow({
          id: `eagle_mapping:path_rule:fullpage_${slugifyKey(fullPageType)}_${slugifyKey(pathRule)}`,
          layer: "eagle_mapping",
          category: "path_rule",
          target: fullPageType,
          expression: `path rule ${pathRule}`,
          sourceFile: EAGLE_RULES_PATH,
          sourceAnchor: `fullPage.${fullPageType}.pathRules`,
          examples: pathRule,
          lastVerified,
        }),
      );
    }
  }

  return rows;
}

function dedupeRows(rows: RuleRegistryRow[]): RuleRegistryRow[] {
  const seen = new Set<string>();
  const deduped: RuleRegistryRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    deduped.push(row);
  }
  return deduped;
}

function toCsv(rows: RuleRegistryRow[]): string {
  const headers = [
    "id",
    "layer",
    "category",
    "target",
    "expression",
    "sourceFile",
    "sourceAnchor",
    "score",
    "priority",
    "status",
    "examples",
    "lastVerified",
  ] as const;

  const escapeCell = (value: string): string => {
    const escaped = value.replace(/"/g, '""');
    if (/[",\n]/.test(escaped)) {
      return `"${escaped}"`;
    }
    return escaped;
  };

  const lines = [headers.join(",")];
  for (const row of rows) {
    const values = [
      row.id,
      row.layer,
      row.category,
      row.target,
      row.expression,
      row.sourceFile,
      row.sourceAnchor ?? "",
      row.score === null ? "" : String(row.score),
      row.priority,
      row.status,
      row.examples,
      row.lastVerified,
    ];
    lines.push(values.map((value) => escapeCell(value)).join(","));
  }

  return `${lines.join("\n")}\n`;
}

export async function collectRuleRegistryRows(
  projectRoot = process.cwd(),
  lastVerifiedDate?: string,
): Promise<RuleRegistryRow[]> {
  const lastVerified = lastVerifiedDate ?? new Date().toISOString().slice(0, 10);
  const sectionContent = await fs.readFile(path.join(projectRoot, SECTION_DETECTOR_PATH), "utf8");
  const fullPageContent = await fs.readFile(path.join(projectRoot, FULLPAGE_CLASSIFIER_PATH), "utf8");
  const eagleRulesContent = await fs.readFile(path.join(projectRoot, EAGLE_RULES_PATH), "utf8");
  const eagleRules = JSON.parse(eagleRulesContent) as EagleRulesFile;

  const rows = dedupeRows([
    ...extractSectionRows(sectionContent, lastVerified),
    ...extractFullPageRows(fullPageContent, lastVerified),
    ...extractEagleRows(eagleRules, lastVerified),
  ]).sort((a, b) => a.id.localeCompare(b.id));

  return rows;
}

export async function exportRulesRegistry(options: ExportOptions = {}): Promise<RuleExportResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const outputDir = options.outputDir ?? path.join(projectRoot, "output", "rules");

  const rows = await collectRuleRegistryRows(projectRoot, options.lastVerifiedDate);
  await fs.mkdir(outputDir, { recursive: true });

  const outputJsonPath = path.join(outputDir, "rules-registry.json");
  const outputCsvPath = path.join(outputDir, "rules-registry.csv");

  await fs.writeFile(outputJsonPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await fs.writeFile(outputCsvPath, toCsv(rows), "utf8");

  return {
    rows,
    outputJsonPath,
    outputCsvPath,
  };
}
