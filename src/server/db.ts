import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  AssetRecord,
  JobDetail,
  JobExecutionOptions,
  JobLogRecord,
  JobRecord,
  JobStatus,
  JobSummary,
  RunManifest,
} from "../types.js";

interface ListJobsParams {
  status?: JobStatus;
  q?: string;
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
  updated_at: string;
}

interface JobSummaryRow extends JobRow {
  asset_count: number;
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
  import_ok: number;
  import_error: string | null;
  eagle_id: string | null;
}

interface JobLogRow {
  id: number;
  job_id: string;
  level: "info" | "warn" | "error";
  message: string;
  ts: string;
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
    importOk: row.import_ok === 1,
    importError: row.import_error,
    eagleId: row.eagle_id,
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

export class JobsRepository {
  private readonly db: Database.Database;

  constructor(dbPath = path.resolve(process.cwd(), "data/autoscreenshot.db")) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.createSchema();
  }

  close(): void {
    this.db.close();
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
        import_ok INTEGER NOT NULL DEFAULT 0,
        import_error TEXT,
        eagle_id TEXT,
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

      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assets_job_id ON assets(job_id);
      CREATE INDEX IF NOT EXISTS idx_logs_job_id ON job_logs(job_id);
    `);
  }

  createJob(params: {
    id: string;
    instruction: string;
    options: JobExecutionOptions;
  }): JobRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO jobs (id, instruction, status, options_json, created_at, updated_at)
      VALUES (@id, @instruction, 'queued', @optionsJson, @createdAt, @updatedAt)
    `,
      )
      .run({
        id: params.id,
        instruction: params.instruction,
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
            WHEN @status IN ('success', 'partial_success', 'failed', 'cancelled') THEN @now
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

    return {
      id: Number(result.lastInsertRowid),
      jobId,
      level,
      message,
      ts,
    };
  }

  replaceAssets(jobId: string, manifest: RunManifest): void {
    const tx = this.db.transaction((id: string, currentManifest: RunManifest) => {
      this.db.prepare("DELETE FROM assets WHERE job_id = ?").run(id);
      const stmt = this.db.prepare(`
        INSERT INTO assets (
          job_id, kind, section_type, label, file_path, file_name, source_url, quality, dpr, captured_at, import_ok, import_error, eagle_id
        ) VALUES (
          @jobId, @kind, @sectionType, @label, @filePath, @fileName, @sourceUrl, @quality, @dpr, @capturedAt, @importOk, @importError, @eagleId
        )
      `);
      for (const asset of currentManifest.assets) {
        stmt.run({
          jobId: id,
          kind: asset.kind,
          sectionType: asset.sectionType ?? null,
          label: asset.label,
          filePath: asset.filePath,
          fileName: asset.fileName,
          sourceUrl: asset.sourceUrl,
          quality: asset.quality,
          dpr: asset.dpr,
          capturedAt: asset.capturedAt,
          importOk: asset.import.ok ? 1 : 0,
          importError: asset.import.error ?? null,
          eagleId: asset.import.eagleId ?? null,
        });
      }
    });
    tx(jobId, manifest);
  }

  getAssets(jobId: string): AssetRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM assets WHERE job_id = ? ORDER BY id ASC")
      .all(jobId) as AssetRow[];
    return rows.map(toAssetRecord);
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
        COUNT(a.id) AS asset_count,
        SUM(CASE WHEN a.import_ok = 1 THEN 1 ELSE 0 END) AS import_success_count,
        SUM(CASE WHEN a.import_ok = 0 THEN 1 ELSE 0 END) AS import_failed_count
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
      importSuccessCount: Number(row.import_success_count) || 0,
      importFailedCount: Number(row.import_failed_count) || 0,
      sourceUrl: extractSourceUrl(row.task_json),
    }));

    return {
      items,
      total: totalRow.total,
    };
  }

  getJobDetail(jobId: string): JobDetail | null {
    const job = this.getJob(jobId);
    if (!job) {
      return null;
    }
    const assets = this.getAssets(jobId);
    const logs = this.getLogs(jobId);
    return {
      job,
      assets,
      logs,
      manifest: null,
    };
  }

  getAssetById(assetId: number): AssetRecord | null {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(assetId) as AssetRow | undefined;
    return row ? toAssetRecord(row) : null;
  }
}
