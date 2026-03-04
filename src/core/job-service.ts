import { existsSync } from "node:fs";
import path from "node:path";
import { parseInstruction } from "../ai/intent-parser.js";
import { captureTask } from "../browser/capture.js";
import { DEFAULT_JOB_OPTIONS } from "./defaults.js";
import { EagleClient } from "../eagle/client.js";
import type {
  EagleImportResult,
  FullPageType,
  JobExecutionOptions,
  RunManifest,
} from "../types.js";
import { loadEagleFolderRules } from "./eagle-folder-rules.js";
import { classifyFullPageType } from "./fullpage-classifier.js";
import {
  buildFolderIndex,
  resolveFullPageFolder,
  resolveSectionFolder,
} from "./folder-resolver.js";
import { readManifest, slugify, timestampForFile, writeManifest, writeManifestToPath } from "../utils/manifest.js";

type LogLevel = "info" | "warn" | "error";
type LogHandler = (level: LogLevel, message: string) => void;

export interface ExecuteInstructionParams {
  instruction: string;
  options?: Partial<JobExecutionOptions>;
  cwd?: string;
  runId?: string;
  log?: LogHandler;
}

export interface ExecuteInstructionResult {
  runId: string;
  manifestPath: string;
  manifest: RunManifest;
  fallbackToDpr1: boolean;
}

function emit(log: LogHandler | undefined, level: LogLevel, message: string): void {
  if (log) {
    log(level, message);
  }
}

function clampQuality(value: number): number {
  return Math.max(1, Math.min(100, Math.round(value)));
}

function clampClassicMaxSections(value: number): number {
  return Math.max(1, Math.min(20, Math.round(value)));
}

export function resolveJobOptions(
  options?: Partial<JobExecutionOptions>,
): JobExecutionOptions {
  return {
    quality:
      typeof options?.quality === "number"
        ? clampQuality(options.quality)
        : DEFAULT_JOB_OPTIONS.quality,
    dpr: options?.dpr ?? DEFAULT_JOB_OPTIONS.dpr,
    sectionScope: options?.sectionScope ?? DEFAULT_JOB_OPTIONS.sectionScope,
    classicMaxSections:
      typeof options?.classicMaxSections === "number"
        ? clampClassicMaxSections(options.classicMaxSections)
        : DEFAULT_JOB_OPTIONS.classicMaxSections,
    outputDir: options?.outputDir ?? DEFAULT_JOB_OPTIONS.outputDir,
  };
}

function makeRunId(url: string): string {
  let host = "unknown";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    host = "unknown";
  }
  return `${slugify(host)}_${timestampForFile()}`;
}

function buildAssetTags(asset: RunManifest["assets"][number], userTags: string[]): string[] {
  const tags = new Set<string>();
  for (const userTag of userTags) {
    tags.add(userTag);
  }
  tags.add("format:jpg");
  tags.add(`quality:${asset.quality}`);
  tags.add(`dpr:${asset.dpr}`);
  tags.add(`capture:${asset.kind}`);
  tags.add(`captured_at:${asset.capturedAt.replace(/[:.]/g, "-")}`);
  if (asset.sectionType) {
    tags.add(`section:${asset.sectionType}`);
  }
  return [...tags];
}

function buildAnnotation(
  asset: RunManifest["assets"][number],
  userAnnotation?: string,
): string {
  const lines = [
    userAnnotation?.trim() ?? "",
    `source_url=${asset.sourceUrl}`,
    `section_type=${asset.sectionType ?? "fullPage"}`,
    `quality=${asset.quality}`,
    `dpr=${asset.dpr}`,
    `captured_at=${asset.capturedAt}`,
  ].filter(Boolean);
  return lines.join("\n");
}

function importedCounts(manifest: RunManifest): { imported: number; failed: number } {
  const imported = manifest.assets.filter((asset) => asset.import.ok).length;
  const failed = manifest.assets.length - imported;
  return { imported, failed };
}

export async function importManifestAssets(
  manifest: RunManifest,
  manifestPath: string,
  log?: LogHandler,
): Promise<RunManifest> {
  emit(log, "info", "Checking Eagle API health");
  const eagle = new EagleClient(
    process.env.EAGLE_API_BASE_URL ?? "http://localhost:41595",
    process.env.EAGLE_API_TOKEN,
  );
  const healthy = await eagle.healthCheck();
  if (!healthy) {
    emit(log, "warn", "Eagle API unavailable; keeping assets on disk for retry");
    const failed: EagleImportResult = {
      ok: false,
      error: "Eagle API unavailable on localhost:41595",
    };
    manifest.assets = manifest.assets.map((asset) => ({
      ...asset,
      import: asset.import.ok ? asset.import : failed,
    }));
    await writeManifestToPath(manifestPath, manifest);
    return manifest;
  }

  const rulesState = await loadEagleFolderRules(process.cwd());
  for (const warning of rulesState.warnings) {
    emit(log, "warn", warning);
  }

  let folderIndex = buildFolderIndex([]);
  try {
    const folders = await eagle.listFolders();
    folderIndex = buildFolderIndex(eagle.flattenFolders(folders));
  } catch (error) {
    emit(
      log,
      "warn",
      `Unable to read Eagle folders, falling back to root import: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  for (let index = 0; index < manifest.assets.length; index += 1) {
    const asset = manifest.assets[index];
    if (asset.import.ok) {
      continue;
    }

    let fullPageType: FullPageType | undefined;
    const resolveResult =
      asset.kind === "section"
        ? resolveSectionFolder(asset.sectionType, rulesState.rules, folderIndex)
        : (() => {
            const classification = classifyFullPageType(asset.sourceUrl, rulesState.rules);
            fullPageType = classification.type;
            return resolveFullPageFolder(classification.type, rulesState.rules, folderIndex);
          })();

    emit(
      log,
      "info",
      [
        "Import routing",
        `asset=${asset.fileName}`,
        `asset_kind=${asset.kind}`,
        `section_type=${asset.sectionType ?? "none"}`,
        `fullpage_type=${fullPageType ?? "none"}`,
        `resolved_by=${resolveResult.resolvedBy}`,
        `folder_id=${resolveResult.folderId ?? "root"}`,
        `reason=${resolveResult.reason}`,
      ].join(" "),
    );

    emit(log, "info", `Importing ${asset.fileName} into Eagle`);
    const importResult = await eagle.addImageFromPath({
      asset,
      extraTags: buildAssetTags(asset, manifest.task.tags),
      annotation: buildAnnotation(asset, manifest.task.eagle.annotation),
      folderId: resolveResult.folderId,
      star: manifest.task.eagle.star,
    });
    manifest.assets[index] = {
      ...asset,
      import: importResult,
    };
    if (!importResult.ok) {
      emit(log, "warn", `Failed importing ${asset.fileName}: ${importResult.error ?? "unknown error"}`);
    }
  }

  await writeManifestToPath(manifestPath, manifest);
  const counts = importedCounts(manifest);
  emit(log, "info", `Import finished: ${counts.imported}/${manifest.assets.length} imported`);
  return manifest;
}

export async function executeInstruction(
  params: ExecuteInstructionParams,
): Promise<ExecuteInstructionResult> {
  const options = resolveJobOptions(params.options);
  const cwd = params.cwd ?? process.cwd();
  const log = params.log;

  emit(log, "info", "Parsing instruction");
  const task = await parseInstruction(params.instruction, {
    quality: options.quality,
    dpr: options.dpr,
    sectionScope: options.sectionScope,
  });

  const runId = params.runId ?? makeRunId(task.url);
  const outputDir = path.join(path.resolve(cwd, options.outputDir), runId);

  emit(log, "info", `Capturing screenshots for ${task.url}`);
  const captureResult = await captureTask(task, {
    outputDir,
    sectionScope: options.sectionScope,
    classicMaxSections: options.classicMaxSections,
  });

  const manifest: RunManifest = {
    runId,
    instruction: params.instruction,
    createdAt: new Date().toISOString(),
    task: {
      ...task,
      image: {
        ...task.image,
        dpr:
          task.image.dpr === "auto"
            ? captureResult.usedDpr === 1
              ? 1
              : 2
            : task.image.dpr,
      },
    },
    sectionScope: options.sectionScope,
    outputDir,
    sectionDebug: captureResult.sectionDebug,
    assets: captureResult.assets.map((asset) => ({
      ...asset,
      import: {
        ok: false,
        error: "Pending import",
      },
    })),
  };

  const manifestPath = await writeManifest(outputDir, manifest);
  emit(log, "info", `Manifest written: ${manifestPath}`);
  const updatedManifest = await importManifestAssets(manifest, manifestPath, log);

  if (captureResult.fallbackToDpr1) {
    emit(log, "warn", "Retina fallback applied: switched to dpr=1 after retryable error");
  }

  return {
    runId,
    manifestPath,
    manifest: updatedManifest,
    fallbackToDpr1: captureResult.fallbackToDpr1,
  };
}

export async function retryImportByManifestPath(
  manifestPathArg: string,
  log?: LogHandler,
): Promise<RunManifest> {
  const manifestPath = path.resolve(process.cwd(), manifestPathArg);
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  emit(log, "info", `Retrying import for ${manifestPath}`);
  const manifest = await readManifest(manifestPath);
  return importManifestAssets(manifest, manifestPath, log);
}

export function summarizeManifest(manifest: RunManifest): {
  total: number;
  imported: number;
  failed: number;
} {
  const imported = manifest.assets.filter((asset) => asset.import.ok).length;
  return {
    total: manifest.assets.length,
    imported,
    failed: manifest.assets.length - imported,
  };
}
