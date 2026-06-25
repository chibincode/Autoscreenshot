export type WaitUntilState = "load" | "domcontentloaded" | "networkidle";

export type CaptureMode = "fullPage" | "section";

export type SectionType =
  | "hero"
  | "feature"
  | "security"
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
  | "contact"
  | "customers_list"
  | "customer_detail"
  | "projects_list"
  | "project_detail"
  | "blog_list"
  | "blog_detail"
  | "changelog_list"
  | "changelog_detail"
  | "news"
  | "help"
  | "login"
  | "signup"
  | "products_list"
  | "product_detail"
  | "downloads_list"
  | "download_detail"
  | "integration"
  | "brandkit"
  | "security"
  | "unmatched";

export type SectionScope = "classic" | "all-top-level" | "manual";

export type DprOption = "auto" | 1 | 2;
export type JobMode = "single" | "core-routes";

export type JobStatus =
  | "queued"
  | "running"
  | "awaiting_confirmation"
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
  security: number;
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
  pageTitle?: string;
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
  scrollSceneDebug?: ScrollSceneReplacementDebug[];
}

export type ScrollSceneLayoutMode =
  | "sticky_only_unfold"
  | "split_content_preserve"
  | "split_content_unfold";

export interface ScrollSceneReplacementDebug {
  sceneId: string;
  layoutMode: ScrollSceneLayoutMode;
  outerTop: number;
  outerHeight: number;
  stickyHeight: number;
  sampledFrameCount: number;
  distinctFrameCount: number;
  replacementHeight: number;
  sourceUrl?: string;
  routePath?: string;
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

export type FolderResolvedBy = "explicit" | "name_fallback" | "generic_fallback" | "root";

export interface FolderResolveResult {
  folderId?: string;
  resolvedBy: FolderResolvedBy;
  reason: "mapped" | "missing_id" | "ambiguous_name" | "type_unmatched" | "default_general";
}

export interface EagleImportResult {
  ok: boolean;
  selected: boolean;
  status: AssetImportStatus;
  eagleId?: string;
  error?: string;
}

export type AssetImportStatus = "pending_confirmation" | "imported" | "failed";
export type FolderSelectionSource = "auto" | "manual" | "missing";

export interface ManifestAsset extends CapturedAsset {
  import: EagleImportResult;
  folderOverrideId?: string | null;
}

export interface RunManifest {
  runId: string;
  instruction: string;
  createdAt: string;
  task: ParsedTask;
  sectionScope: SectionScope;
  outputDir: string;
  sectionDebug?: SectionDetectionDebug;
  scrollSceneDebug?: ScrollSceneReplacementDebug[];
  routes?: RouteTargetSummary[];
  assets: ManifestAsset[];
}

export interface JobExecutionOptions {
  quality: number;
  dpr: DprOption;
  sectionScope: SectionScope;
  classicMaxSections: number;
  mode: JobMode;
  maxRoutes: number;
  outputDir: string;
}

export interface CreateJobRequest {
  instruction: string;
  quality?: number;
  dpr?: DprOption;
  sectionScope?: SectionScope;
  classicMaxSections?: number;
  mode?: JobMode;
  maxRoutes?: number;
  outputDir?: string;
}

export type RouteTargetSource = "nav" | "link";

export type RouteTargetStatus = "queued" | "running" | "success" | "failed" | "skipped";

export interface RouteTargetRecord {
  id: number;
  jobId: string;
  url: string;
  path: string;
  title: string | null;
  source: RouteTargetSource;
  depth: number;
  priorityScore: number;
  status: RouteTargetStatus;
  error: string | null;
  attemptCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface RouteTargetSummary {
  id?: number;
  url: string;
  path: string;
  title: string | null;
  source: RouteTargetSource;
  depth: number;
  priorityScore: number;
  status: RouteTargetStatus;
  error: string | null;
  attemptCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  assetCount: number;
  lastExecutedAt: string | null;
}

export interface RouteDiscoveryTarget {
  url: string;
  path: string;
  title?: string;
  source: RouteTargetSource;
  depth: number;
  priorityScore: number;
}

export interface RouteDiscoveryResult {
  entryUrl: string;
  routes: RouteDiscoveryTarget[];
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
  archivedAt: string | null;
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
  selectedForImport: boolean;
  importStatus: AssetImportStatus;
  importOk: boolean;
  importError: string | null;
  eagleId: string | null;
  folderOverrideId: string | null;
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
  pendingConfirmationCount: number;
  importSuccessCount: number;
  importFailedCount: number;
  sourceUrl: string | null;
  archivedAt: string | null;
}

export interface PluginContextHistoryJob {
  id: string;
  status: JobStatus;
  createdAt: string;
  mode: JobMode;
  assetCount: number;
}

export interface PluginContextEagleItem {
  id: string;
  name: string;
  url: string;
  mtime: number | null;
  jobId?: string;
  assetId?: number;
  clickable: boolean;
}

export interface PluginContextResponse {
  requestUrl: string;
  normalizedUrl: string;
  runtime: {
    serverHealthy: true;
    playwrightHealthy: boolean;
    eagleHealthy: boolean;
    messages: string[];
  };
  history: {
    hitCount: number;
    recentJobs: PluginContextHistoryJob[];
  };
  eagle: {
    available: boolean;
    hitCount: number;
    recentItems: PluginContextEagleItem[];
  };
  defaults: JobExecutionOptions;
}

export interface JobDetail {
  job: JobRecord;
  assets: AssetRecord[];
  logs: JobLogRecord[];
  routes: RouteTargetSummary[];
  manifest: RunManifest | null;
}

export interface AssetPreviewRecord extends AssetRecord {
  pageTitle?: string;
  resolvedEagleFolderId: string | null;
  resolvedEagleFolderPath: string | null;
  targetEagleFolderId: string | null;
  targetEagleFolderPath: string | null;
  folderSelectionSource: FolderSelectionSource;
  eagleFolderId: string | null;
  eagleFolderPath: string | null;
  previewUrl: string;
  thumbnailUrl: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
}

export interface JobDetailResponse extends Omit<JobDetail, "assets"> {
  assets: AssetPreviewRecord[];
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
