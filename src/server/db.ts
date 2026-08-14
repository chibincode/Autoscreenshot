import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  buildAssetFingerprint,
  buildManifestAssetFingerprint,
  LEGACY_PENDING_IMPORT_ERROR,
  normalizeImportResult,
} from "../core/import-state.js";
import { extractNormalizedHostname, normalizeUrlForComparison } from "../core/url-normalization.js";
import type {
  AssetRecord,
  AssetImportStatus,
  EagleFolderRules,
  JobDetail,
  JobExecutionOptions,
  JobLogRecord,
  JobMode,
  JobRecord,
  JobStatus,
  JobSummary,
  PluginContextHistoryJob,
  RouteDiscoveryTarget,
  RouteTargetRecord,
  RouteTargetStatus,
  RouteTargetSummary,
  RunManifest,
} from "../types.js";

interface ListJobsParams {
  status?: JobStatus;
  q?: string;
  archivedOnly?: boolean;
  page?: number;
  pageSize?: number;
}

interface JobRow {
  id: string;
  instruction: string;
  status: JobStatus;
  task_json: string | null;
  options_json: string;
  error: string | null;
  manifest_path: string | null;
  output_dir: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  import_completed_at: string | null;
  archived_at: string | null;
  cleaned_at: string | null;
  cleaned_asset_count: number;
  cleaned_pending_count: number;
  cleaned_imported_count: number;
  cleaned_failed_count: number;
  updated_at: string;
}

interface JobSummaryRow extends JobRow {
  asset_count: number;
  pending_confirmation_count: number;
  import_success_count: number;
  import_failed_count: number;
}

interface AssetRow {
  id: number;
  job_id: string;
  kind: "fullPage" | "section";
  section_type: string | null;
  label: string;
  file_path: string;
  file_name: string;
  source_url: string;
  quality: number;
  dpr: number;
  captured_at: string;
  selected_for_import: number;
  import_status: AssetImportStatus;
  import_ok: number;
  import_error: string | null;
  eagle_id: string | null;
  folder_override_id: string | null;
}

interface JobLogRow {
  id: number;
  job_id: string;
  level: "info" | "warn" | "error";
  message: string;
  ts: string;
}

interface RouteTargetRow {
  id: number;
  job_id: string;
  url: string;
  path: string;
  title: string | null;
  source: "nav" | "link";
  depth: number;
  priority_score: number;
  status: RouteTargetStatus;
  error: string | null;
  attempt_count: number;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface RouteTargetSummaryRow extends RouteTargetRow {
  asset_count: number;
  last_executed_at: string | null;
}

interface HistoryLookupRow {
  id: string;
  status: JobStatus;
  created_at: string;
  options_json: string;
  latest_captured_at: string;
  cleaned_at: string | null;
  cleaned_asset_count: number;
}

interface AssetByEagleIdRow {
  id: number;
  job_id: string;
  captured_at: string;
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    instruction: row.instruction,
    status: row.status,
    taskJson: row.task_json,
    optionsJson: row.options_json,
    error: row.error,
    manifestPath: row.manifest_path,
    outputDir: row.output_dir,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    importCompletedAt: row.import_completed_at,
    archivedAt: row.archived_at,
    cleanedAt: row.cleaned_at,
    updatedAt: row.updated_at,
  };
}

function toAssetRecord(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    sectionType: row.section_type as AssetRecord["sectionType"],
    label: row.label,
    filePath: row.file_path,
    fileName: row.file_name,
    sourceUrl: row.source_url,
    quality: row.quality,
    dpr: row.dpr,
    capturedAt: row.captured_at,
    selectedForImport: row.selected_for_import === 1,
    importStatus: row.import_status,
    importOk: row.import_status === "imported",
    importError: row.import_error,
    eagleId: row.eagle_id,
    folderOverrideId: row.folder_override_id,
  };
}

function toJobLogRecord(row: JobLogRow): JobLogRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    level: row.level,
    message: row.message,
    ts: row.ts,
  };
}

function toRouteTargetRecord(row: RouteTargetRow): RouteTargetRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    url: row.url,
    path: row.path,
    title: row.title,
    source: row.source,
    depth: row.depth,
    priorityScore: row.priority_score,
    status: row.status,
    error: row.error,
    attemptCount: row.attempt_count,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

function toRouteTargetSummary(row: RouteTargetSummaryRow): RouteTargetSummary {
  return {
    ...toRouteTargetRecord(row),
    assetCount: Number(row.asset_count) || 0,
    lastExecutedAt: row.last_executed_at,
  };
}

function extractSourceUrl(taskJson: string | null): string | null {
  if (!taskJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(taskJson) as { url?: string };
    return typeof parsed.url === "string" ? parsed.url : null;
  } catch {
    return null;
  }
}

function extractSourceUrlFromInstruction(instruction: string): string | null {
  const match = instruction.match(/https?:\/\/[^\s"'，,]+/i);
  return match?.[0] ?? null;
}

function resolveJobSourceUrl(row: Pick<JobRow, "task_json" | "instruction">): string | null {
  return extractSourceUrl(row.task_json) ?? extractSourceUrlFromInstruction(row.instruction);
}

function parseJobMode(optionsJson: string): JobMode {
  try {
    const parsed = JSON.parse(optionsJson) as { mode?: unknown };
    return parsed.mode === "core-routes" ? "core-routes" : "single";
  } catch {
    return "single";
  }
}

export class JobsRepository {
  private readonly db: Database.Database;

  constructor(dbPath = path.resolve(process.cwd(), "data/autoscreenshot.db")) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.createSchema();
    this.migrateAssetImportState();
  }

  close(): void {
    this.db.close();
  }

  private touchJob(jobId: string, now = new Date().toISOString()): void {
    this.db.prepare("UPDATE jobs SET updated_at = @now WHERE id = @jobId").run({ jobId, now });
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL,
        task_json TEXT,
        options_json TEXT NOT NULL,
        error TEXT,
        manifest_path TEXT,
        output_dir TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        import_completed_at TEXT,
        archived_at TEXT,
        cleaned_at TEXT,
        cleaned_asset_count INTEGER NOT NULL DEFAULT 0,
        cleaned_pending_count INTEGER NOT NULL DEFAULT 0,
        cleaned_imported_count INTEGER NOT NULL DEFAULT 0,
        cleaned_failed_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        section_type TEXT,
        label TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        source_url TEXT NOT NULL,
        quality INTEGER NOT NULL,
        dpr INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        selected_for_import INTEGER NOT NULL DEFAULT 1,
        import_status TEXT NOT NULL DEFAULT 'pending_confirmation',
        import_ok INTEGER NOT NULL DEFAULT 0,
        import_error TEXT,
        eagle_id TEXT,
        folder_override_id TEXT,
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS job_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        ts TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS route_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        url TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT,
        source TEXT NOT NULL,
        depth INTEGER NOT NULL,
        priority_score INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE,
        UNIQUE(job_id, url)
      );

      CREATE TABLE IF NOT EXISTS job_history_urls (
        job_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        PRIMARY KEY(job_id, source_url),
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assets_job_id ON assets(job_id);
      CREATE INDEX IF NOT EXISTS idx_logs_job_id ON job_logs(job_id);
      CREATE INDEX IF NOT EXISTS idx_route_targets_job_id ON route_targets(job_id);
      CREATE INDEX IF NOT EXISTS idx_route_targets_status ON route_targets(status);
      CREATE INDEX IF NOT EXISTS idx_job_history_urls_source_url ON job_history_urls(source_url);
    `);

    const columns = this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "archived_at")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN archived_at TEXT;");
    }
    if (!columns.some((column) => column.name === "import_completed_at")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN import_completed_at TEXT;");
    }
    if (!columns.some((column) => column.name === "cleaned_at")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN cleaned_at TEXT;");
    }
    if (!columns.some((column) => column.name === "cleaned_asset_count")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN cleaned_asset_count INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columns.some((column) => column.name === "cleaned_pending_count")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN cleaned_pending_count INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columns.some((column) => column.name === "cleaned_imported_count")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN cleaned_imported_count INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columns.some((column) => column.name === "cleaned_failed_count")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN cleaned_failed_count INTEGER NOT NULL DEFAULT 0;");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_archived_created_at ON jobs(archived_at, created_at DESC);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_import_completed_at ON jobs(import_completed_at);");
    this.db.exec(`
      INSERT INTO job_history_urls (job_id, source_url, captured_at)
      SELECT job_id, source_url, MAX(captured_at)
      FROM assets
      GROUP BY job_id, source_url
      ON CONFLICT(job_id, source_url) DO UPDATE SET
        captured_at = MAX(job_history_urls.captured_at, excluded.captured_at);
    `);
  }

  private migrateAssetImportState(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(assets)")
      .all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("selected_for_import")) {
      this.db.exec("ALTER TABLE assets ADD COLUMN selected_for_import INTEGER NOT NULL DEFAULT 1");
    }
    if (!columnNames.has("import_status")) {
      this.db.exec(
        "ALTER TABLE assets ADD COLUMN import_status TEXT NOT NULL DEFAULT 'pending_confirmation'",
      );
    }
    if (!columnNames.has("folder_override_id")) {
      this.db.exec("ALTER TABLE assets ADD COLUMN folder_override_id TEXT");
    }

    this.db.exec(`
      UPDATE assets
      SET selected_for_import = 1
      WHERE selected_for_import IS NULL;

      UPDATE assets
      SET import_status = CASE
        WHEN import_ok = 1 THEN 'imported'
        WHEN import_ok = 0
          AND import_error IS NOT NULL
          AND TRIM(import_error) != ''
          AND import_error != '${LEGACY_PENDING_IMPORT_ERROR}'
        THEN 'failed'
        ELSE 'pending_confirmation'
      END;

      UPDATE jobs
      SET import_completed_at = COALESCE(import_completed_at, updated_at)
      WHERE cleaned_at IS NULL
        AND EXISTS (
          SELECT 1 FROM assets
          WHERE assets.job_id = jobs.id
            AND assets.selected_for_import = 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM assets
          WHERE assets.job_id = jobs.id
            AND assets.selected_for_import = 1
            AND assets.import_status != 'imported'
        );
    `);
  }

  createJob(params: {
    id: string;
    instruction: string;
    options: JobExecutionOptions;
    taskJson?: string | null;
  }): JobRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO jobs (id, instruction, status, task_json, options_json, created_at, updated_at)
      VALUES (@id, @instruction, 'queued', @taskJson, @optionsJson, @createdAt, @updatedAt)
    `,
      )
      .run({
        id: params.id,
        instruction: params.instruction,
        taskJson: params.taskJson ?? null,
        optionsJson: JSON.stringify(params.options),
        createdAt: now,
        updatedAt: now,
      });
    return this.getJob(params.id)!;
  }

  getJob(jobId: string): JobRecord | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    return row ? toJobRecord(row) : null;
  }

  setJobRunning(jobId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE jobs
      SET status = 'running', started_at = COALESCE(started_at, @now), updated_at = @now, error = NULL
      WHERE id = @jobId
    `,
      )
      .run({ jobId, now });
  }

  setJobResult(params: {
    jobId: string;
    status: JobStatus;
    taskJson?: string | null;
    manifestPath?: string | null;
    outputDir?: string | null;
    error?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE jobs
      SET status = @status,
          task_json = COALESCE(@taskJson, task_json),
          manifest_path = COALESCE(@manifestPath, manifest_path),
          output_dir = COALESCE(@outputDir, output_dir),
          error = @error,
          finished_at = CASE
            WHEN @status IN ('awaiting_confirmation', 'success', 'partial_success', 'failed', 'cancelled') THEN @now
            ELSE finished_at
          END,
          updated_at = @now
      WHERE id = @jobId
    `,
      )
      .run({
        jobId: params.jobId,
        status: params.status,
        taskJson: params.taskJson ?? null,
        manifestPath: params.manifestPath ?? null,
        outputDir: params.outputDir ?? null,
        error: params.error ?? null,
        now,
      });
  }

  setJobArchived(jobId: string, archived: boolean): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE jobs
      SET archived_at = @archivedAt,
          updated_at = @now
      WHERE id = @jobId
    `,
      )
      .run({
        jobId,
        archivedAt: archived ? now : null,
        now,
      });
  }

  listImportedJobsReadyForHistory(cutoffIso: string): JobRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM jobs
        WHERE cleaned_at IS NULL
          AND import_completed_at IS NOT NULL
          AND import_completed_at <= ?
          AND status NOT IN ('queued', 'running')
        ORDER BY import_completed_at ASC
      `,
      )
      .all(cutoffIso) as JobRow[];
    return rows.map(toJobRecord);
  }

  addLog(jobId: string, level: "info" | "warn" | "error", message: string): JobLogRecord {
    const ts = new Date().toISOString();
    const result = this.db
      .prepare(
        `
      INSERT INTO job_logs (job_id, level, message, ts)
      VALUES (@jobId, @level, @message, @ts)
    `,
      )
      .run({ jobId, level, message, ts });
    this.touchJob(jobId, ts);

    return {
      id: Number(result.lastInsertRowid),
      jobId,
      level,
      message,
      ts,
    };
  }

  replaceRouteTargets(jobId: string, routes: RouteDiscoveryTarget[]): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction((id: string, discoveredRoutes: RouteDiscoveryTarget[]) => {
      this.db.prepare("DELETE FROM route_targets WHERE job_id = ?").run(id);
      const insert = this.db.prepare(`
        INSERT INTO route_targets (
          job_id, url, path, title, source, depth, priority_score, status, error, attempt_count, updated_at
        ) VALUES (
          @jobId, @url, @path, @title, @source, @depth, @priorityScore, 'queued', NULL, 0, @updatedAt
        )
      `);
      for (const route of discoveredRoutes) {
        insert.run({
          jobId: id,
          url: route.url,
          path: route.path,
          title: route.title ?? null,
          source: route.source,
          depth: route.depth,
          priorityScore: route.priorityScore,
          updatedAt: now,
        });
      }
    });
    tx(jobId, routes);
    this.touchJob(jobId, now);
  }

  updateRouteTargetStatus(params: {
    jobId: string;
    url: string;
    status: RouteTargetStatus;
    error?: string | null;
    attemptCount?: number;
    startedAt?: string | null;
    finishedAt?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE route_targets
      SET status = @status,
          error = @error,
          attempt_count = COALESCE(@attemptCount, attempt_count),
          started_at = COALESCE(@startedAt, started_at),
          finished_at = CASE
            WHEN @finishedAt IS NOT NULL THEN @finishedAt
            WHEN @status IN ('success', 'failed', 'skipped') THEN @now
            ELSE finished_at
          END,
          updated_at = @now
      WHERE job_id = @jobId AND url = @url
    `,
      )
      .run({
        jobId: params.jobId,
        url: params.url,
        status: params.status,
        error: params.error ?? null,
        attemptCount: params.attemptCount ?? null,
        startedAt: params.startedAt ?? null,
        finishedAt: params.finishedAt ?? null,
        now,
      });
    this.touchJob(params.jobId, now);
  }

  updateRouteTargetById(params: {
    id: number;
    status: RouteTargetStatus;
    error?: string | null;
    attemptCount?: number;
    startedAt?: string | null;
    finishedAt?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE route_targets
      SET status = @status,
          error = @error,
          attempt_count = COALESCE(@attemptCount, attempt_count),
          started_at = COALESCE(@startedAt, started_at),
          finished_at = CASE
            WHEN @finishedAt IS NOT NULL THEN @finishedAt
            WHEN @status IN ('success', 'failed', 'skipped') THEN @now
            ELSE finished_at
          END,
          updated_at = @now
      WHERE id = @id
    `,
      )
      .run({
        id: params.id,
        status: params.status,
        error: params.error ?? null,
        attemptCount: params.attemptCount ?? null,
        startedAt: params.startedAt ?? null,
        finishedAt: params.finishedAt ?? null,
        now,
      });
    const route = this.getRouteTargetById(params.id);
    if (route) {
      this.touchJob(route.jobId, now);
    }
  }

  replaceAssets(jobId: string, manifest: RunManifest): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction((id: string, currentManifest: RunManifest) => {
      const existingRows = this.db
        .prepare("SELECT * FROM assets WHERE job_id = ? ORDER BY id ASC")
        .all(id) as AssetRow[];
      const existingByFingerprint = new Map<string, AssetRow[]>();
      for (const row of existingRows) {
        const fingerprint = buildAssetFingerprint(toAssetRecord(row));
        const rows = existingByFingerprint.get(fingerprint) ?? [];
        rows.push(row);
        existingByFingerprint.set(fingerprint, rows);
      }

      const update = this.db.prepare(`
        UPDATE assets
        SET kind = @kind,
            section_type = @sectionType,
            label = @label,
            file_path = @filePath,
            file_name = @fileName,
            source_url = @sourceUrl,
            quality = @quality,
            dpr = @dpr,
            captured_at = @capturedAt,
            selected_for_import = @selectedForImport,
            import_status = @importStatus,
            import_ok = @importOk,
            import_error = @importError,
            eagle_id = @eagleId,
            folder_override_id = @folderOverrideId
        WHERE id = @id
      `);
      const insert = this.db.prepare(`
        INSERT INTO assets (
          job_id,
          kind,
          section_type,
          label,
          file_path,
          file_name,
          source_url,
          quality,
          dpr,
          captured_at,
          selected_for_import,
          import_status,
          import_ok,
          import_error,
          eagle_id,
          folder_override_id
        ) VALUES (
          @jobId,
          @kind,
          @sectionType,
          @label,
          @filePath,
          @fileName,
          @sourceUrl,
          @quality,
          @dpr,
          @capturedAt,
          @selectedForImport,
          @importStatus,
          @importOk,
          @importError,
          @eagleId,
          @folderOverrideId
        )
      `);
      const upsertHistoryUrl = this.db.prepare(`
        INSERT INTO job_history_urls (job_id, source_url, captured_at)
        VALUES (@jobId, @sourceUrl, @capturedAt)
        ON CONFLICT(job_id, source_url) DO UPDATE SET
          captured_at = MAX(job_history_urls.captured_at, excluded.captured_at)
      `);
      const seenIds = new Set<number>();

      for (const asset of currentManifest.assets) {
        const importState = normalizeImportResult(asset.import);
        const record = {
          kind: asset.kind,
          sectionType: asset.sectionType ?? null,
          label: asset.label,
          filePath: asset.filePath,
          fileName: asset.fileName,
          sourceUrl: asset.sourceUrl,
          quality: asset.quality,
          dpr: asset.dpr,
          capturedAt: asset.capturedAt,
          selectedForImport: importState.selected ? 1 : 0,
          importStatus: importState.status,
          importOk: importState.status === "imported" ? 1 : 0,
          importError: importState.error ?? null,
          eagleId: importState.eagleId ?? null,
          folderOverrideId: asset.folderOverrideId ?? null,
        };
        upsertHistoryUrl.run({
          jobId: id,
          sourceUrl: asset.sourceUrl,
          capturedAt: asset.capturedAt,
        });
        const fingerprint = buildManifestAssetFingerprint(asset);
        const matched = existingByFingerprint.get(fingerprint)?.shift();
        if (matched) {
          seenIds.add(matched.id);
          update.run({
            id: matched.id,
            ...record,
          });
          continue;
        }

        insert.run({
          jobId: id,
          ...record,
        });
      }

      for (const row of existingRows) {
        if (!seenIds.has(row.id)) {
          this.db.prepare("DELETE FROM assets WHERE id = ?").run(row.id);
        }
      }

      const importState = this.db
        .prepare(
          `
          SELECT
            SUM(CASE WHEN selected_for_import = 1 THEN 1 ELSE 0 END) AS selected_count,
            SUM(CASE WHEN selected_for_import = 1 AND import_status != 'imported' THEN 1 ELSE 0 END) AS incomplete_count
          FROM assets
          WHERE job_id = ?
        `,
        )
        .get(id) as { selected_count: number | null; incomplete_count: number | null };
      const importIsComplete =
        Number(importState.selected_count) > 0 && Number(importState.incomplete_count) === 0;
      this.db
        .prepare(
          `
          UPDATE jobs
          SET import_completed_at = CASE
            WHEN @importIsComplete = 1 THEN COALESCE(import_completed_at, @now)
            ELSE NULL
          END
          WHERE id = @jobId
        `,
        )
        .run({
          jobId: id,
          importIsComplete: importIsComplete ? 1 : 0,
          now,
        });
    });
    tx(jobId, manifest);
    this.touchJob(jobId, now);
  }

  cleanJobFiles(jobId: string): JobRecord | null {
    const job = this.getJob(jobId);
    if (!job) {
      return null;
    }

    const now = new Date().toISOString();
    const tx = this.db.transaction((id: string, cleanedAt: string) => {
      const current = this.db
        .prepare("SELECT cleaned_at FROM jobs WHERE id = ?")
        .get(id) as { cleaned_at: string | null } | undefined;
      if (!current || current.cleaned_at) {
        return;
      }

      this.db
        .prepare(
          `
          INSERT INTO job_history_urls (job_id, source_url, captured_at)
          SELECT job_id, source_url, MAX(captured_at)
          FROM assets
          WHERE job_id = ?
          GROUP BY job_id, source_url
          ON CONFLICT(job_id, source_url) DO UPDATE SET
            captured_at = MAX(job_history_urls.captured_at, excluded.captured_at)
        `,
        )
        .run(id);

      const counts = this.db
        .prepare(
          `
          SELECT
            COUNT(*) AS asset_count,
            SUM(CASE WHEN import_status = 'pending_confirmation' AND selected_for_import = 1 THEN 1 ELSE 0 END) AS pending_count,
            SUM(CASE WHEN import_status = 'imported' THEN 1 ELSE 0 END) AS imported_count,
            SUM(CASE WHEN import_status = 'failed' THEN 1 ELSE 0 END) AS failed_count
          FROM assets
          WHERE job_id = ?
        `,
        )
        .get(id) as {
        asset_count: number;
        pending_count: number | null;
        imported_count: number | null;
        failed_count: number | null;
      };

      this.db.prepare("DELETE FROM assets WHERE job_id = ?").run(id);
      this.db
        .prepare(
          `
          UPDATE jobs
          SET manifest_path = NULL,
              output_dir = NULL,
              cleaned_at = @cleanedAt,
              archived_at = COALESCE(archived_at, @cleanedAt),
              cleaned_asset_count = @assetCount,
              cleaned_pending_count = @pendingCount,
              cleaned_imported_count = @importedCount,
              cleaned_failed_count = @failedCount,
              updated_at = @cleanedAt
          WHERE id = @jobId
        `,
        )
        .run({
          jobId: id,
          cleanedAt,
          assetCount: Number(counts.asset_count) || 0,
          pendingCount: Number(counts.pending_count) || 0,
          importedCount: Number(counts.imported_count) || 0,
          failedCount: Number(counts.failed_count) || 0,
        });
    });

    tx(jobId, now);
    return this.getJob(jobId);
  }

  listArchivedJobsWithFiles(): JobRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM jobs
        WHERE archived_at IS NOT NULL
          AND cleaned_at IS NULL
          AND status NOT IN ('queued', 'running')
          AND EXISTS (
            SELECT 1 FROM assets
            WHERE assets.job_id = jobs.id
              AND assets.selected_for_import = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM assets
            WHERE assets.job_id = jobs.id
              AND assets.selected_for_import = 1
              AND assets.import_status != 'imported'
          )
        ORDER BY created_at DESC
      `,
      )
      .all() as JobRow[];
    return rows.map(toJobRecord);
  }

  getArchivedCleanupSummary(): { jobCount: number; assetCount: number } {
    const row = this.db
      .prepare(
        `
        SELECT
          COUNT(DISTINCT j.id) AS job_count,
          COUNT(a.id) AS asset_count
        FROM jobs j
        LEFT JOIN assets a ON a.job_id = j.id
        WHERE j.archived_at IS NOT NULL
          AND j.cleaned_at IS NULL
          AND j.status NOT IN ('queued', 'running')
          AND EXISTS (
            SELECT 1 FROM assets eligible_assets
            WHERE eligible_assets.job_id = j.id
              AND eligible_assets.selected_for_import = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM assets blocked_assets
            WHERE blocked_assets.job_id = j.id
              AND blocked_assets.selected_for_import = 1
              AND blocked_assets.import_status != 'imported'
          )
      `,
      )
      .get() as { job_count: number; asset_count: number };
    return {
      jobCount: Number(row.job_count) || 0,
      assetCount: Number(row.asset_count) || 0,
    };
  }

  getAssets(jobId: string): AssetRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM assets WHERE job_id = ? ORDER BY id ASC")
      .all(jobId) as AssetRow[];
    return rows.map(toAssetRecord);
  }

  listRouteTargets(jobId: string): RouteTargetSummary[] {
    const rows = this.db
      .prepare(
        `
      SELECT
        rt.*,
        COUNT(a.id) AS asset_count,
        MAX(a.captured_at) AS last_executed_at
      FROM route_targets rt
      LEFT JOIN assets a ON a.job_id = rt.job_id AND a.source_url = rt.url
      WHERE rt.job_id = ?
      GROUP BY rt.id
      ORDER BY rt.priority_score DESC, rt.id ASC
    `,
      )
      .all(jobId) as RouteTargetSummaryRow[];
    return rows.map(toRouteTargetSummary);
  }

  getRouteTargetById(routeId: number): RouteTargetRecord | null {
    const row = this.db
      .prepare("SELECT * FROM route_targets WHERE id = ?")
      .get(routeId) as RouteTargetRow | undefined;
    return row ? toRouteTargetRecord(row) : null;
  }

  getLogs(jobId: string, limit = 500): JobLogRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT ?")
      .all(jobId, limit) as JobLogRow[];
    return rows.reverse().map(toJobLogRecord);
  }

  listJobs(params: ListJobsParams): { items: JobSummary[]; total: number } {
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const page = Math.max(1, params.page ?? 1);
    const offset = (page - 1) * pageSize;

    const whereParts: string[] = [];
    const whereValues: Array<string> = [];

    if (params.archivedOnly) {
      whereParts.push("j.archived_at IS NOT NULL");
    } else {
      whereParts.push("j.archived_at IS NULL");
    }
    if (params.status) {
      whereParts.push("j.status = ?");
      whereValues.push(params.status);
    }
    if (params.q?.trim()) {
      whereParts.push("j.instruction LIKE ?");
      whereValues.push(`%${params.q.trim()}%`);
    }
    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `
      SELECT
        j.*,
        CASE WHEN j.cleaned_at IS NOT NULL THEN j.cleaned_asset_count ELSE COUNT(a.id) END AS asset_count,
        CASE
          WHEN j.cleaned_at IS NOT NULL THEN j.cleaned_pending_count
          ELSE SUM(CASE WHEN a.import_status = 'pending_confirmation' AND a.selected_for_import = 1 THEN 1 ELSE 0 END)
        END AS pending_confirmation_count,
        CASE
          WHEN j.cleaned_at IS NOT NULL THEN j.cleaned_imported_count
          ELSE SUM(CASE WHEN a.import_status = 'imported' THEN 1 ELSE 0 END)
        END AS import_success_count,
        CASE
          WHEN j.cleaned_at IS NOT NULL THEN j.cleaned_failed_count
          ELSE SUM(CASE WHEN a.import_status = 'failed' THEN 1 ELSE 0 END)
        END AS import_failed_count
      FROM jobs j
      LEFT JOIN assets a ON a.job_id = j.id
      ${whereSql}
      GROUP BY j.id
      ORDER BY j.created_at DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(...whereValues, pageSize, offset) as JobSummaryRow[];

    const totalRow = this.db
      .prepare(
        `
      SELECT COUNT(*) as total
      FROM jobs j
      ${whereSql}
    `,
      )
      .get(...whereValues) as { total: number };

    const items: JobSummary[] = rows.map((row) => ({
      id: row.id,
      status: row.status,
      instruction: row.instruction,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      error: row.error,
      outputDir: row.output_dir,
      assetCount: Number(row.asset_count) || 0,
      pendingConfirmationCount: Number(row.pending_confirmation_count) || 0,
      importSuccessCount: Number(row.import_success_count) || 0,
      importFailedCount: Number(row.import_failed_count) || 0,
      sourceUrl: resolveJobSourceUrl(row),
      importCompletedAt: row.import_completed_at,
      archivedAt: row.archived_at,
      cleanedAt: row.cleaned_at,
    }));

    return {
      items,
      total: totalRow.total,
    };
  }

  findRecentJobsBySourceUrl(params: {
    normalizedUrl: string;
    urlNormalization: EagleFolderRules["urlNormalization"];
    limit?: number;
  }): PluginContextHistoryJob[] {
    const limit = Math.max(1, params.limit ?? 3);
    const hostname = extractNormalizedHostname(params.normalizedUrl);
    if (!hostname) {
      return [];
    }

    const candidates = this.db
      .prepare(
        `
      SELECT
        j.id,
        j.status,
        j.created_at,
        j.options_json,
        j.cleaned_at,
        j.cleaned_asset_count,
        MAX(h.captured_at) AS latest_captured_at
      FROM jobs j
      INNER JOIN job_history_urls h ON h.job_id = j.id
      WHERE (
        h.source_url LIKE @httpsHost
        OR h.source_url LIKE @httpHost
        OR h.source_url LIKE @httpsWwwHost
        OR h.source_url LIKE @httpWwwHost
      )
      GROUP BY j.id
      ORDER BY latest_captured_at DESC
      LIMIT 50
    `,
      )
      .all({
        httpsHost: `https://${hostname}%`,
        httpHost: `http://${hostname}%`,
        httpsWwwHost: `https://www.${hostname}%`,
        httpWwwHost: `http://www.${hostname}%`,
      }) as HistoryLookupRow[];

    const matchedJobs: PluginContextHistoryJob[] = [];
    for (const candidate of candidates) {
      const historyUrls = this.db
        .prepare("SELECT source_url FROM job_history_urls WHERE job_id = ?")
        .all(candidate.id) as Array<{ source_url: string }>;
      const hasMatch = historyUrls.some((row) => {
        const normalizedSourceUrl = normalizeUrlForComparison(
          row.source_url,
          params.urlNormalization,
        );
        return normalizedSourceUrl === params.normalizedUrl;
      });
      if (!hasMatch) {
        continue;
      }

      matchedJobs.push({
        id: candidate.id,
        status: candidate.status,
        createdAt: candidate.created_at,
        mode: parseJobMode(candidate.options_json),
        assetCount:
          candidate.cleaned_at !== null
            ? Number(candidate.cleaned_asset_count) || 0
            : this.getAssets(candidate.id).length,
      });
      if (matchedJobs.length >= limit) {
        break;
      }
    }

    return matchedJobs;
  }

  getJobDetail(jobId: string): JobDetail | null {
    const job = this.getJob(jobId);
    if (!job) {
      return null;
    }
    const assets = this.getAssets(jobId);
    const logs = this.getLogs(jobId);
    const routes = this.listRouteTargets(jobId);
    return {
      job,
      assets,
      logs,
      routes,
      manifest: null,
    };
  }

  getAssetById(assetId: number): AssetRecord | null {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(assetId) as AssetRow | undefined;
    return row ? toAssetRecord(row) : null;
  }

  findMostRecentAssetByEagleId(eagleId: string): { jobId: string; assetId: number } | null {
    const row = this.db
      .prepare(
        `
      SELECT id, job_id, captured_at
      FROM assets
      WHERE eagle_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `,
      )
      .get(eagleId) as AssetByEagleIdRow | undefined;

    if (!row) {
      return null;
    }

    return {
      jobId: row.job_id,
      assetId: row.id,
    };
  }
}
