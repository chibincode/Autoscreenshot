export type WaitUntilState = "load" | "domcontentloaded" | "networkidle";

export type CaptureMode = "fullPage" | "section";

export type SectionType =
  | "hero"
  | "feature"
  | "testimonial"
  | "pricing"
  | "team"
  | "faq"
  | "blog"
  | "cta"
  | "contact"
  | "footer"
  | "unknown";

export type FullPageType =
  | "home"
  | "pricing"
  | "about"
  | "careers"
  | "blog_list"
  | "blog_detail"
  | "news"
  | "help"
  | "login"
  | "signup"
  | "products_list"
  | "product_detail"
  | "downloads_list"
  | "download_detail"
  | "integration"
  | "unmatched";

export type SectionScope = "classic" | "all-top-level" | "manual";

export type DprOption = "auto" | 1 | 2;

export type JobStatus =
  | "queued"
  | "running"
  | "success"
  | "partial_success"
  | "failed"
  | "cancelled";

export interface CaptureRequest {
  mode: CaptureMode;
  targetType?: SectionType;
  selector?: string;
}

export interface ImageOptions {
  format: "jpg";
  quality: number;
  dpr: DprOption;
}

export interface EagleOptions {
  folderName?: string;
  annotation?: string;
  star?: number;
}

export interface ParsedTask {
  url: string;
  waitUntil: WaitUntilState;
  captures: CaptureRequest[];
  image: ImageOptions;
  viewport: {
    width: number;
    height: number;
  };
  tags: string[];
  eagle: EagleOptions;
}

export interface SectionResult {
  sectionType: SectionType;
  selector: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidence: number;
}

export interface SectionScoreBreakdown {
  hero: number;
  feature: number;
  testimonial: number;
  pricing: number;
  team: number;
  faq: number;
  blog: number;
  cta: number;
  contact: number;
  footer: number;
  unknown: number;
}

export interface SectionSignalHit {
  label: SectionType;
  weight: number;
  rule: string;
}

export interface SectionDebugCandidate {
  selector: string;
  tagName: string;
  sectionType: SectionType;
  confidence: number;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  textPreview: string;
  scores: SectionScoreBreakdown;
  signals: SectionSignalHit[];
}

export interface SectionDetectionDebug {
  scope: SectionScope;
  viewportHeight: number;
  rawCandidates: SectionDebugCandidate[];
  mergedCandidates: SectionDebugCandidate[];
  selectedCandidates: SectionDebugCandidate[];
}

export interface CapturedAsset {
  kind: CaptureMode;
  sectionType?: SectionType;
  label: string;
  filePath: string;
  fileName: string;
  sourceUrl: string;
  quality: number;
  dpr: number;
  capturedAt: string;
}

export interface CaptureRunResult {
  assets: CapturedAsset[];
  usedDpr: number;
  fallbackToDpr1: boolean;
  viewport: {
    width: number;
    height: number;
  };
  fullPageSize: {
    width: number;
    height: number;
  };
  sectionDebug?: SectionDetectionDebug;
}

export interface EagleImportInput {
  asset: CapturedAsset;
  extraTags: string[];
  annotation?: string;
  folderId?: string;
  star?: number;
}

export interface EagleFolderNode {
  id: string;
  name: string;
  children?: EagleFolderNode[];
}

export interface EagleFlatFolder {
  id: string;
  name: string;
  path: string;
}

export type MissingFolderBehavior = "root";

export interface EagleImportPolicyRules {
  allowCreateFolder: boolean;
  missingFolderBehavior: MissingFolderBehavior;
}

export interface EagleSectionFolderRule {
  folderId?: string;
  nameHints?: string[];
}

export interface EagleFullPageFolderRule {
  folderId?: string;
  pathRules: string[];
}

export interface EagleUrlNormalizationRules {
  stripQuery: boolean;
  stripHash: boolean;
  stripLocalePrefix: boolean;
}

export interface EagleFolderRules {
  version: number;
  policy: EagleImportPolicyRules;
  fallbackByName: boolean;
  urlNormalization: EagleUrlNormalizationRules;
  sections: Partial<Record<Exclude<SectionType, "unknown">, EagleSectionFolderRule>>;
  fullPage: Partial<Record<Exclude<FullPageType, "unmatched">, EagleFullPageFolderRule>>;
}

export type FolderResolvedBy = "explicit" | "name_fallback" | "root";

export interface FolderResolveResult {
  folderId?: string;
  resolvedBy: FolderResolvedBy;
  reason: "mapped" | "missing_id" | "ambiguous_name" | "type_unmatched";
}

export interface EagleImportResult {
  ok: boolean;
  eagleId?: string;
  error?: string;
}

export interface RunManifest {
  runId: string;
  instruction: string;
  createdAt: string;
  task: ParsedTask;
  sectionScope: SectionScope;
  outputDir: string;
  sectionDebug?: SectionDetectionDebug;
  assets: Array<
    CapturedAsset & {
      import: EagleImportResult;
    }
  >;
}

export interface JobExecutionOptions {
  quality: number;
  dpr: DprOption;
  sectionScope: SectionScope;
  classicMaxSections: number;
  outputDir: string;
}

export interface CreateJobRequest {
  instruction: string;
  quality?: number;
  dpr?: DprOption;
  sectionScope?: SectionScope;
  classicMaxSections?: number;
  outputDir?: string;
}

export interface JobRecord {
  id: string;
  instruction: string;
  status: JobStatus;
  taskJson: string | null;
  optionsJson: string;
  error: string | null;
  manifestPath: string | null;
  outputDir: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface AssetRecord {
  id: number;
  jobId: string;
  kind: CaptureMode;
  sectionType: SectionType | null;
  label: string;
  filePath: string;
  fileName: string;
  sourceUrl: string;
  quality: number;
  dpr: number;
  capturedAt: string;
  importOk: boolean;
  importError: string | null;
  eagleId: string | null;
}

export interface JobLogRecord {
  id: number;
  jobId: string;
  level: "info" | "warn" | "error";
  message: string;
  ts: string;
}

export interface QueueStats {
  queued: number;
  runningJobId: string | null;
}

export interface JobSummary {
  id: string;
  status: JobStatus;
  instruction: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  outputDir: string | null;
  assetCount: number;
  importSuccessCount: number;
  importFailedCount: number;
  sourceUrl: string | null;
}

export interface JobDetail {
  job: JobRecord;
  assets: AssetRecord[];
  logs: JobLogRecord[];
  manifest: RunManifest | null;
}

export type JobEvent =
  | {
      type: "status";
      jobId: string;
      status: JobStatus;
      message?: string;
      at: string;
    }
  | {
      type: "log";
      jobId: string;
      level: "info" | "warn" | "error";
      message: string;
      at: string;
    }
  | {
      type: "assets_updated";
      jobId: string;
      at: string;
    };
