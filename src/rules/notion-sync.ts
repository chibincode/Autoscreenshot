import { promises as fs } from "node:fs";
import path from "node:path";
import type { RuleRegistryRow } from "./types.js";

const NOTION_VERSION = "2022-06-28";

export interface NotionSyncConfig {
  apiKey: string;
  databaseId?: string;
  parentPageId?: string;
  databaseTitle?: string;
  ownerUserId?: string;
  rulesJsonPath?: string;
}

export interface NotionSyncSummary {
  databaseId: string;
  created: number;
  updated: number;
  deprecated: number;
  totalLocal: number;
  totalRemote: number;
}

export interface RemoteRulePage {
  pageId: string;
  ruleId: string;
  status: string;
}

interface NotionQueryResponse {
  results: Array<Record<string, unknown>>;
  has_more: boolean;
  next_cursor: string | null;
}

interface FetchLike {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function normalizeNotionId(raw: string): string {
  const stripped = raw.replace(/-/g, "").trim();
  if (/^[0-9a-fA-F]{32}$/.test(stripped)) {
    return stripped;
  }
  const uuidMatch = raw.match(/[0-9a-fA-F]{32}/);
  if (uuidMatch) {
    return uuidMatch[0];
  }
  throw new Error(`Invalid Notion ID: ${raw}`);
}

async function notionRequest<T>(params: {
  apiKey: string;
  method: "GET" | "POST" | "PATCH";
  endpoint: string;
  body?: Record<string, unknown>;
  fetchImpl: FetchLike;
}): Promise<T> {
  const response = await params.fetchImpl(`https://api.notion.com/v1${params.endpoint}`, {
    method: params.method,
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: params.body ? JSON.stringify(params.body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Notion API ${params.method} ${params.endpoint} failed: ${response.status} ${errorText}`);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

function select(name: string): { select: { name: string } } {
  return { select: { name } };
}

function richText(content: string): { rich_text: Array<{ type: "text"; text: { content: string } }> } {
  if (!content.trim()) {
    return { rich_text: [] };
  }
  return {
    rich_text: [{ type: "text", text: { content } }],
  };
}

function title(content: string): { title: Array<{ type: "text"; text: { content: string } }> } {
  return {
    title: [{ type: "text", text: { content } }],
  };
}

export function toNotionRuleProperties(
  row: RuleRegistryRow,
  options: { includeRuleId: boolean; ownerUserId?: string },
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    Layer: select(row.layer),
    Category: select(row.category),
    Target: richText(row.target),
    "Rule Expression": richText(row.expression),
    "Source File": richText(row.sourceAnchor ? `${row.sourceFile}#${row.sourceAnchor}` : row.sourceFile),
    "Weight/Score": { number: row.score },
    Priority: select(row.priority),
    Status: select(row.status),
    Examples: richText(row.examples),
    "Last Verified": { date: row.lastVerified ? { start: row.lastVerified } : null },
  };

  if (options.includeRuleId) {
    props["Rule ID"] = title(row.id);
  }

  if (options.ownerUserId) {
    props.Owner = {
      people: [
        {
          id: options.ownerUserId,
        },
      ],
    };
  }

  return props;
}

function parseRemoteRulePage(raw: Record<string, unknown>): RemoteRulePage | null {
  const pageId = typeof raw.id === "string" ? raw.id : null;
  const properties = raw.properties as Record<string, unknown> | undefined;
  if (!pageId || !properties) {
    return null;
  }

  const ruleIdProperty = properties["Rule ID"] as
    | { title?: Array<{ plain_text?: string }> }
    | undefined;
  const statusProperty = properties.Status as
    | { select?: { name?: string | null } | null }
    | undefined;

  const ruleId = ruleIdProperty?.title?.[0]?.plain_text;
  if (!ruleId) {
    return null;
  }

  return {
    pageId,
    ruleId,
    status: statusProperty?.select?.name ?? "",
  };
}

export function computeDeprecatedRuleIds(localRuleIds: string[], remotePages: RemoteRulePage[]): string[] {
  const localSet = new Set(localRuleIds);
  return remotePages
    .filter((page) => !localSet.has(page.ruleId) && page.status !== "deprecated")
    .map((page) => page.ruleId);
}

async function createRulesDatabase(config: {
  apiKey: string;
  parentPageId: string;
  title: string;
  fetchImpl: FetchLike;
}): Promise<string> {
  const payload = {
    parent: { type: "page_id", page_id: normalizeNotionId(config.parentPageId) },
    title: [{ type: "text", text: { content: config.title } }],
    properties: {
      "Rule ID": { title: {} },
      Layer: {
        select: {
          options: [
            { name: "section_classifier" },
            { name: "fullpage_classifier" },
            { name: "eagle_mapping" },
          ],
        },
      },
      Category: {
        select: {
          options: [
            { name: "keyword" },
            { name: "phrase" },
            { name: "conflict" },
            { name: "heuristic" },
            { name: "path_rule" },
            { name: "folder_map" },
            { name: "normalization" },
            { name: "selection" },
            { name: "dedupe" },
          ],
        },
      },
      Target: { rich_text: {} },
      "Rule Expression": { rich_text: {} },
      "Source File": { rich_text: {} },
      "Weight/Score": { number: {} },
      Priority: {
        select: {
          options: [{ name: "P0" }, { name: "P1" }, { name: "P2" }],
        },
      },
      Status: {
        select: {
          options: [{ name: "active" }, { name: "deprecated" }, { name: "draft" }],
        },
      },
      Examples: { rich_text: {} },
      "Last Verified": { date: {} },
      Owner: { people: {} },
    },
  };

  const created = await notionRequest<{ id: string }>({
    apiKey: config.apiKey,
    method: "POST",
    endpoint: "/databases",
    body: payload,
    fetchImpl: config.fetchImpl,
  });

  return created.id;
}

async function queryAllRulePages(params: {
  apiKey: string;
  databaseId: string;
  fetchImpl: FetchLike;
}): Promise<RemoteRulePage[]> {
  const pages: RemoteRulePage[] = [];
  let nextCursor: string | null = null;

  do {
    const response: NotionQueryResponse = await notionRequest<NotionQueryResponse>({
      apiKey: params.apiKey,
      method: "POST",
      endpoint: `/databases/${normalizeNotionId(params.databaseId)}/query`,
      body: nextCursor ? { start_cursor: nextCursor } : {},
      fetchImpl: params.fetchImpl,
    });

    for (const item of response.results) {
      const parsed = parseRemoteRulePage(item);
      if (parsed) {
        pages.push(parsed);
      }
    }

    nextCursor = response.has_more ? response.next_cursor : null;
  } while (nextCursor);

  return pages;
}

async function createRulePage(params: {
  apiKey: string;
  databaseId: string;
  row: RuleRegistryRow;
  ownerUserId?: string;
  fetchImpl: FetchLike;
}): Promise<void> {
  await notionRequest({
    apiKey: params.apiKey,
    method: "POST",
    endpoint: "/pages",
    body: {
      parent: { database_id: normalizeNotionId(params.databaseId) },
      properties: toNotionRuleProperties(params.row, {
        includeRuleId: true,
        ownerUserId: params.ownerUserId,
      }),
    },
    fetchImpl: params.fetchImpl,
  });
}

async function updateRulePage(params: {
  apiKey: string;
  pageId: string;
  row: RuleRegistryRow;
  ownerUserId?: string;
  fetchImpl: FetchLike;
}): Promise<void> {
  await notionRequest({
    apiKey: params.apiKey,
    method: "PATCH",
    endpoint: `/pages/${normalizeNotionId(params.pageId)}`,
    body: {
      properties: toNotionRuleProperties(params.row, {
        includeRuleId: false,
        ownerUserId: params.ownerUserId,
      }),
    },
    fetchImpl: params.fetchImpl,
  });
}

async function markDeprecated(params: {
  apiKey: string;
  pageId: string;
  fetchImpl: FetchLike;
}): Promise<void> {
  await notionRequest({
    apiKey: params.apiKey,
    method: "PATCH",
    endpoint: `/pages/${normalizeNotionId(params.pageId)}`,
    body: {
      properties: {
        Status: select("deprecated"),
      },
    },
    fetchImpl: params.fetchImpl,
  });
}

export async function loadRulesRegistryFile(rulesJsonPath: string): Promise<RuleRegistryRow[]> {
  const content = await fs.readFile(rulesJsonPath, "utf8");
  const parsed = JSON.parse(content) as RuleRegistryRow[];
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid rules JSON: ${rulesJsonPath}`);
  }
  return parsed;
}

export async function syncRulesToNotion(
  rows: RuleRegistryRow[],
  config: NotionSyncConfig,
  fetchImpl: FetchLike = fetch,
): Promise<NotionSyncSummary> {
  if (!config.apiKey?.trim()) {
    throw new Error("NOTION_API_KEY is required");
  }

  let databaseId = config.databaseId?.trim();
  if (!databaseId) {
    if (!config.parentPageId?.trim()) {
      throw new Error("Provide NOTION_RULES_DATABASE_ID or NOTION_RULES_PARENT_PAGE_ID");
    }
    databaseId = await createRulesDatabase({
      apiKey: config.apiKey,
      parentPageId: config.parentPageId,
      title: config.databaseTitle ?? "Autoscreenshot Rules Registry",
      fetchImpl,
    });
  }

  const remotePages = await queryAllRulePages({
    apiKey: config.apiKey,
    databaseId,
    fetchImpl,
  });
  const remoteByRuleId = new Map(remotePages.map((page) => [page.ruleId, page]));

  let created = 0;
  let updated = 0;

  for (const row of rows) {
    const remote = remoteByRuleId.get(row.id);
    if (remote) {
      await updateRulePage({
        apiKey: config.apiKey,
        pageId: remote.pageId,
        row,
        ownerUserId: config.ownerUserId,
        fetchImpl,
      });
      updated += 1;
    } else {
      await createRulePage({
        apiKey: config.apiKey,
        databaseId,
        row,
        ownerUserId: config.ownerUserId,
        fetchImpl,
      });
      created += 1;
    }
  }

  const deprecatedRuleIds = computeDeprecatedRuleIds(
    rows.map((row) => row.id),
    remotePages,
  );

  let deprecated = 0;
  for (const ruleId of deprecatedRuleIds) {
    const remote = remoteByRuleId.get(ruleId);
    if (!remote) {
      continue;
    }
    await markDeprecated({
      apiKey: config.apiKey,
      pageId: remote.pageId,
      fetchImpl,
    });
    deprecated += 1;
  }

  return {
    databaseId,
    created,
    updated,
    deprecated,
    totalLocal: rows.length,
    totalRemote: remotePages.length,
  };
}

export function resolveRulesSyncConfigFromEnv(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): NotionSyncConfig {
  return {
    apiKey: env.NOTION_API_KEY ?? "",
    databaseId: env.NOTION_RULES_DATABASE_ID,
    parentPageId: env.NOTION_RULES_PARENT_PAGE_ID,
    databaseTitle: env.NOTION_RULES_DATABASE_TITLE,
    ownerUserId: env.NOTION_RULES_OWNER_USER_ID,
    rulesJsonPath:
      env.NOTION_RULES_JSON_PATH ?? path.join(cwd, "output", "rules", "rules-registry.json"),
  };
}
