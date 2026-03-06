export type RuleLayer = "section_classifier" | "fullpage_classifier" | "eagle_mapping";

export type RuleCategory =
  | "keyword"
  | "phrase"
  | "conflict"
  | "heuristic"
  | "path_rule"
  | "folder_map"
  | "normalization"
  | "selection"
  | "dedupe";

export type RulePriority = "P0" | "P1" | "P2";

export type RuleStatus = "active" | "deprecated" | "draft";

export interface RuleRegistryRow {
  id: string;
  layer: RuleLayer;
  category: RuleCategory;
  target: string;
  expression: string;
  sourceFile: string;
  sourceAnchor?: string;
  score: number | null;
  priority: RulePriority;
  status: RuleStatus;
  examples: string;
  lastVerified: string;
}

export interface RuleExportResult {
  rows: RuleRegistryRow[];
  outputJsonPath: string;
  outputCsvPath: string;
}
