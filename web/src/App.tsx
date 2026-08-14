import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Crop } from "lucide-react";
import {
  buildFeedbackContext,
  buildAssetLookupIndex,
  canFocusDebugAsset,
  formatPendingImportLabel,
  findAssetForRouteFromIndex,
  findAssetsForRouteFromIndex,
  getCoreRoutePreviewState,
} from "./asset-feedback";
import { ActionDialog, type ActionDialogTone } from "./ActionDialog";
import { ActionToast, type ActionToastTone } from "./ActionToast";
import { FolderPickerDialog } from "./FolderPickerDialog";
import { Button } from "./ui/Button";
import {
  filterAndRankFolders,
  formatFolderNameForCard,
  formatFolderPathForCard,
  parseRecentFolderIds,
  RECENT_EAGLE_FOLDER_IDS_STORAGE_KEY,
  rememberRecentFolderId,
  type EagleFolderOption,
  type RankedEagleFolderOption,
} from "./folder-picker";
import {
  deriveRouteProgress,
  describeCompletedCoreRoutesStatus,
  describeEagleImportQueueStatus,
  isActiveStatus,
} from "./job-progress";
import { getNextSelectedJobId } from "./job-selection";
import { buildRestoreOriginalConfirmation } from "./restore-original-confirmation";
import { canRerunRoute } from "./route-retry";
import {
  readSelectedAssetIdFromSearch,
  readSelectedJobIdFromSearch,
  syncSelectionToUrl,
} from "./job-location";

type JobStatus =
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "success"
  | "partial_success"
  | "failed"
  | "cancelled";

type JobMode = "single" | "core-routes";
type DprOption = "auto" | 1 | 2;
type SectionScope = "classic" | "all-top-level" | "manual";
type SectionType =
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
type SectionDebugPhase = "raw" | "merged" | "selected";
type AssetImportStatus = "pending_confirmation" | "imported" | "failed";
type FolderSelectionSource = "auto" | "manual" | "missing";
type CopyFeedbackState = "success" | "error" | null;

interface SectionScoreBreakdown {
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

interface SectionSignalHit {
  label: SectionType;
  weight: number;
  rule: string;
}

interface SectionDebugCandidate {
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

interface SectionDetectionDebug {
  scope: SectionScope;
  viewportHeight: number;
  rawCandidates: SectionDebugCandidate[];
  mergedCandidates: SectionDebugCandidate[];
  selectedCandidates: SectionDebugCandidate[];
}

interface ManifestView {
  sectionDebug?: SectionDetectionDebug;
  [key: string]: unknown;
}

interface ManifestAssetView {
  kind: "fullPage" | "section";
  sectionType: string | null;
  label: string;
  fileName: string;
  pageTitle?: string;
  sourceUrl: string | null;
}

interface JobSummary {
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
  importCompletedAt: string | null;
  archivedAt: string | null;
  cleanedAt: string | null;
}

interface JobAsset {
  id: number;
  kind: "fullPage" | "section";
  sectionType: string | null;
  label: string;
  fileName: string;
  pageTitle?: string;
  quality: number;
  dpr: number;
  capturedAt: string;
  selectedForImport: boolean;
  importStatus: AssetImportStatus;
  importOk: boolean;
  importError: string | null;
  eagleId: string | null;
  folderOverrideId?: string | null;
  resolvedEagleFolderId: string | null;
  resolvedEagleFolderPath: string | null;
  targetEagleFolderId: string | null;
  targetEagleFolderPath: string | null;
  folderSelectionSource: FolderSelectionSource;
  eagleFolderId?: string | null;
  eagleFolderPath?: string | null;
  previewUrl: string;
  thumbnailUrl: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
  imageWidth: number;
  imageHeight: number;
  canRestoreOriginal: boolean;
  sourceUrl: string | null;
}

type AssetCropOperation =
  | {
      type: "remove-bottom";
      keepHeight: number;
    }
  | {
      type: "remove-band";
      startY: number;
      endY: number;
    };

type CropToolMode = "bottom" | "band";
type CropDragTarget = "bottom" | "band-start" | "band-end" | "band-body";

const LAST_CROP_TOOL_MODE_STORAGE_KEY = "autoscreenshot.lastCropToolMode.v1";

function readLastCropToolMode(): CropToolMode {
  if (typeof window === "undefined") {
    return "bottom";
  }
  try {
    const storedMode = window.localStorage.getItem(LAST_CROP_TOOL_MODE_STORAGE_KEY);
    return storedMode === "band" || storedMode === "bottom" ? storedMode : "bottom";
  } catch {
    return "bottom";
  }
}

function rememberCropToolMode(mode: CropToolMode): void {
  try {
    window.localStorage.setItem(LAST_CROP_TOOL_MODE_STORAGE_KEY, mode);
  } catch {
    // Keep the current session usable when browser storage is unavailable.
  }
}

interface JobLog {
  id: number;
  level: "info" | "warn" | "error";
  message: string;
  ts: string;
}

interface JobDetail {
  job: {
    id: string;
    status: JobStatus;
    instruction: string;
    optionsJson: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    importCompletedAt: string | null;
    archivedAt: string | null;
    cleanedAt: string | null;
    error: string | null;
    outputDir: string | null;
    updatedAt: string;
  };
  assets: JobAsset[];
  logs: JobLog[];
  routes: RouteTargetSummary[];
  manifest: ManifestView | null;
}

interface RouteTargetSummary {
  id: number;
  url: string;
  path: string;
  title: string | null;
  source: "nav" | "link";
  depth: number;
  priorityScore: number;
  status: "queued" | "running" | "success" | "failed" | "skipped";
  error: string | null;
  attemptCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  assetCount: number;
  lastExecutedAt: string | null;
}

interface ActionDialogState {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ActionDialogTone;
  onConfirm: () => Promise<void>;
}

interface FolderPickerState {
  assetId: number;
  query: string;
  activeIndex: number;
}

interface ActionToastState {
  message: string;
  tone?: ActionToastTone;
}

interface ArchivedCleanupPreview {
  jobCount: number;
  assetCount: number;
}

interface ArchivedCleanupResult {
  eligibleJobCount: number;
  eligibleAssetCount: number;
  cleanedCount: number;
  filesDeletedCount: number;
  failedCount: number;
  failures: Array<{ jobId: string; error: string }>;
}

type PendingQueueActionKind = "import-selected" | "retry-import";

interface AppConfig {
  defaults: {
    quality: number;
    dpr: DprOption;
    sectionScope: SectionScope;
    classicMaxSections: number;
    mode: JobMode;
    maxRoutes: number;
    outputDir: string;
  };
  queue: {
    queued: number;
    runningJobId: string | null;
  };
  eagleImportPolicy?: {
    allowCreateFolder: boolean;
    mappingSource: string;
    fallback: "root";
  };
}

interface PlaywrightRuntimeState {
  healthy: boolean;
  needsRepair: boolean;
  repairing: boolean;
  repairFailed?: boolean;
  target: "chromium";
  message: string;
  detail?: string;
  lastCheckedAt: string;
}

interface CreateJobRequest {
  instruction: string;
  quality: number;
  dpr: DprOption;
  sectionScope: SectionScope;
  classicMaxSections: number;
  mode: JobMode;
  maxRoutes: number;
  outputDir: string;
}

interface SectionDebugRow extends SectionDebugCandidate {
  phase: SectionDebugPhase;
  isSelected: boolean;
  isConflict: boolean;
  isFocusMatch: boolean;
  top1: { label: keyof SectionScoreBreakdown; score: number };
  top2: { label: keyof SectionScoreBreakdown; score: number } | null;
}

const SECTION_TYPES: SectionType[] = [
  "hero",
  "feature",
  "security",
  "testimonial",
  "pricing",
  "team",
  "faq",
  "blog",
  "cta",
  "contact",
  "footer",
  "unknown",
];

const URL_PATTERN = /(https?:\/\/[^\s]+)/gi;

function resolveLinkHref(value: string): string | null {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return new URL(trimmed, window.location.origin).toString();
  }
  return null;
}

function stopLinkEventPropagation(event: MouseEvent<HTMLAnchorElement> | KeyboardEvent<HTMLAnchorElement>): void {
  event.stopPropagation();
}

function ExternalLink({
  href,
  label,
  className,
  title,
}: {
  href: string;
  label: string;
  className?: string;
  title?: string;
}): JSX.Element {
  const resolvedHref = resolveLinkHref(href);
  if (!resolvedHref) {
    return <span className={className}>{label}</span>;
  }
  return (
    <a
      className={cx("external-link", className)}
      href={resolvedHref}
      target="_blank"
      rel="noreferrer noopener"
      title={title ?? resolvedHref}
      onClick={stopLinkEventPropagation}
      onKeyDown={stopLinkEventPropagation}
    >
      {label}
    </a>
  );
}

function LinkifiedText({
  text,
  className,
}: {
  text: string;
  className?: string;
}): JSX.Element {
  const matches = Array.from(text.matchAll(URL_PATTERN));
  if (matches.length === 0) {
    return <span className={className}>{text}</span>;
  }

  let cursor = 0;
  return (
    <span className={className}>
      {matches.map((match, index) => {
        const matchText = match[0];
        const matchIndex = match.index ?? 0;
        const leadingText = text.slice(cursor, matchIndex);
        cursor = matchIndex + matchText.length;
        const trailingText = index === matches.length - 1 ? text.slice(cursor) : "";

        return (
          <span key={`${matchText}-${matchIndex}`}>
            {leadingText}
            <ExternalLink href={matchText} label={matchText} />
            {trailingText}
          </span>
        );
      })}
    </span>
  );
}

const PLAYWRIGHT_RUNTIME_POLL_MS = 30_000;
const LOG_VIRTUALIZE_THRESHOLD = 80;
const LOG_ROW_HEIGHT = 42;
const ASSET_VIRTUALIZE_THRESHOLD = 36;
const ASSET_GRID_ROW_HEIGHT = 336;
const ASSET_GRID_OVERSCAN_ROWS = 2;
const ARCHIVE_EXIT_MS = 220;

function getAssetGridColumns(width: number): number {
  if (width >= 960) {
    return 3;
  }
  if (width >= 640) {
    return 2;
  }
  return 1;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const hasBody = init?.body !== undefined && init.body !== null;
  if (hasBody) {
    const contentType = headers.get("Content-Type");
    if (!contentType) {
      headers.set("Content-Type", "application/json");
    }
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function isRepairablePlaywrightMessage(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  return (
    normalized.includes("executable doesn't exist") ||
    normalized.includes("playwright install chromium") ||
    normalized.includes("chromium_headless_shell") ||
    normalized.includes("chrome-headless-shell") ||
    normalized.includes("ms-playwright/chromium")
  );
}

function statusClass(status: string): string {
  return `status status-${status}`;
}

function formatStatusLabel(status: JobStatus | RouteTargetSummary["status"]): string {
  switch (status) {
    case "awaiting_confirmation":
      return "Awaiting confirmation";
    case "partial_success":
      return "Needs review";
    default:
      return status;
  }
}

function formatPartialSuccessJobBadge(params: {
  imported: number;
  failed: number;
  pending: number;
}): {
  label: string;
  tone: JobStatus | RouteTargetSummary["status"];
} {
  const { failed, imported, pending } = params;
  if (failed > 0 && imported === 0 && pending === 0) {
    return { label: "Import failed", tone: "failed" };
  }
  if (imported > 0 && failed === 0) {
    return { label: "Imported to Eagle", tone: "success" };
  }
  if (imported > 0 || failed > 0) {
    return { label: "Imported with issues", tone: "partial_success" };
  }
  return { label: "Needs review", tone: "partial_success" };
}

function canQuickArchiveJob(job: JobSummary): boolean {
  return Boolean(job.archivedAt) && !job.cleanedAt && !isActiveStatus(job.status) && job.status !== "queued";
}

function canMoveJobToHistory(
  job: Pick<
    JobSummary,
    "status" | "cleanedAt" | "pendingConfirmationCount" | "importSuccessCount" | "importFailedCount"
  >,
): boolean {
  return (
    !job.cleanedAt &&
    !isActiveStatus(job.status) &&
    job.status !== "queued" &&
    job.pendingConfirmationCount === 0 &&
    job.importSuccessCount > 0 &&
    job.importFailedCount === 0
  );
}

function canRescanJob(job: Pick<JobSummary, "status">): boolean {
  return !isActiveStatus(job.status) && job.status !== "queued";
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function formatDate(input: string | null): string {
  if (!input) {
    return "—";
  }
  return new Date(input).toLocaleString();
}

function formatAutoHistoryDate(importCompletedAt: string): string {
  return formatDate(new Date(new Date(importCompletedAt).getTime() + 24 * 60 * 60 * 1000).toISOString());
}

function normalizeComparableUrl(value: string | null): string {
  if (!value) {
    return "";
  }
  return value.trim().replace(/\/+$/, "");
}

function shouldShowJobInstruction(job: Pick<JobSummary, "instruction" | "sourceUrl">): boolean {
  const instruction = normalizeComparableUrl(job.instruction);
  if (!instruction) {
    return false;
  }
  const sourceUrl = normalizeComparableUrl(job.sourceUrl);
  return !sourceUrl || instruction !== sourceUrl;
}

function areJobSummariesEqual(left: JobSummary[], right: JobSummary[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (
      leftItem.id !== rightItem.id ||
      leftItem.status !== rightItem.status ||
      leftItem.instruction !== rightItem.instruction ||
      leftItem.createdAt !== rightItem.createdAt ||
      leftItem.startedAt !== rightItem.startedAt ||
      leftItem.finishedAt !== rightItem.finishedAt ||
      leftItem.error !== rightItem.error ||
      leftItem.outputDir !== rightItem.outputDir ||
      leftItem.assetCount !== rightItem.assetCount ||
      leftItem.pendingConfirmationCount !== rightItem.pendingConfirmationCount ||
      leftItem.importSuccessCount !== rightItem.importSuccessCount ||
      leftItem.importFailedCount !== rightItem.importFailedCount ||
      leftItem.sourceUrl !== rightItem.sourceUrl ||
      leftItem.archivedAt !== rightItem.archivedAt ||
      leftItem.cleanedAt !== rightItem.cleanedAt
    ) {
      return false;
    }
  }

  return true;
}

function isSameJobDetailVersion(left: JobDetail | null, right: JobDetail): boolean {
  return Boolean(left && left.job.id === right.job.id && left.job.updatedAt === right.job.updatedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toSectionDebugCandidate(value: unknown): SectionDebugCandidate | null {
  if (!isRecord(value) || !isRecord(value.bbox) || !isRecord(value.scores)) {
    return null;
  }
  if (
    typeof value.selector !== "string" ||
    typeof value.tagName !== "string" ||
    typeof value.sectionType !== "string" ||
    typeof value.confidence !== "number" ||
    typeof value.textPreview !== "string"
  ) {
    return null;
  }

  const bbox = value.bbox;
  const scores = value.scores;
  const signalArray = Array.isArray(value.signals) ? value.signals : [];
  if (
    typeof bbox.x !== "number" ||
    typeof bbox.y !== "number" ||
    typeof bbox.width !== "number" ||
    typeof bbox.height !== "number"
  ) {
    return null;
  }

  const requiredScoreKeys: Array<keyof SectionScoreBreakdown> = [
    "hero",
    "feature",
    "testimonial",
    "pricing",
    "team",
    "faq",
    "blog",
    "cta",
    "contact",
    "footer",
    "unknown",
  ];
  for (const key of requiredScoreKeys) {
    if (typeof scores[key] !== "number") {
      return null;
    }
  }
  const securityScore = typeof scores.security === "number" ? scores.security : 0;

  return {
    selector: value.selector,
    tagName: value.tagName,
    sectionType: value.sectionType as SectionType,
    confidence: value.confidence,
    bbox: {
      x: bbox.x,
      y: bbox.y,
      width: bbox.width,
      height: bbox.height,
    },
    textPreview: value.textPreview,
    scores: {
      hero: scores.hero,
      feature: scores.feature,
      security: securityScore,
      testimonial: scores.testimonial,
      pricing: scores.pricing,
      team: scores.team,
      faq: scores.faq,
      blog: scores.blog,
      cta: scores.cta,
      contact: scores.contact,
      footer: scores.footer,
      unknown: scores.unknown,
    },
    signals: signalArray
      .filter(
        (signal): signal is SectionSignalHit =>
          isRecord(signal) &&
          typeof signal.label === "string" &&
          typeof signal.weight === "number" &&
          typeof signal.rule === "string",
      )
      .map((signal) => ({
        label: signal.label as SectionType,
        weight: signal.weight,
        rule: signal.rule,
      })),
  };
}

function readSectionDebug(manifest: ManifestView | null): SectionDetectionDebug | null {
  if (!manifest || !isRecord(manifest.sectionDebug)) {
    return null;
  }
  const debug = manifest.sectionDebug;
  const parseCandidates = (value: unknown): SectionDebugCandidate[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((candidate) => toSectionDebugCandidate(candidate))
      .filter((candidate): candidate is SectionDebugCandidate => candidate !== null);
  };

  return {
    scope:
      debug.scope === "classic" || debug.scope === "all-top-level" || debug.scope === "manual"
        ? debug.scope
        : "classic",
    viewportHeight: typeof debug.viewportHeight === "number" ? debug.viewportHeight : 0,
    rawCandidates: parseCandidates(debug.rawCandidates),
    mergedCandidates: parseCandidates(debug.mergedCandidates),
    selectedCandidates: parseCandidates(debug.selectedCandidates),
  };
}

function readManifestAssets(manifest: ManifestView | null): ManifestAssetView[] {
  if (!manifest || !Array.isArray(manifest.assets)) {
    return [];
  }

  return manifest.assets
    .map((asset) => {
      if (!isRecord(asset) || typeof asset.kind !== "string" || typeof asset.fileName !== "string") {
        return null;
      }
      const kind = asset.kind === "fullPage" || asset.kind === "section" ? asset.kind : null;
      if (!kind) {
        return null;
      }
      return {
        kind,
        sectionType: typeof asset.sectionType === "string" ? asset.sectionType : null,
        label: typeof asset.label === "string" ? asset.label : "",
        fileName: asset.fileName,
        pageTitle: typeof asset.pageTitle === "string" ? asset.pageTitle : undefined,
        sourceUrl: typeof asset.sourceUrl === "string" ? asset.sourceUrl : null,
      } satisfies ManifestAssetView;
    })
    .filter((asset): asset is ManifestAssetView => asset !== null);
}

function findManifestAssetForPreview(
  manifestAssets: ManifestAssetView[],
  asset: JobAsset | null,
): ManifestAssetView | null {
  if (!asset) {
    return null;
  }
  return (
    manifestAssets.find(
      (candidate) =>
        candidate.fileName === asset.fileName &&
        candidate.kind === asset.kind &&
        candidate.label === asset.label &&
        candidate.sectionType === asset.sectionType &&
        candidate.sourceUrl === asset.sourceUrl,
    ) ?? null
  );
}

function resolvePreviewEagleName(asset: JobAsset | null, manifestAsset: ManifestAssetView | null): string | null {
  if (!asset) {
    return null;
  }
  const backendPageTitle = asset.pageTitle?.trim();
  if (backendPageTitle) {
    return backendPageTitle;
  }
  const pageTitle = manifestAsset?.pageTitle?.trim();
  if (pageTitle) {
    return pageTitle;
  }
  return asset.fileName;
}

function resolvePreviewEaglePath(asset: JobAsset | null, eagleName: string | null): string | null {
  if (!asset || !eagleName) {
    return null;
  }
  const folderPath = asset.targetEagleFolderPath?.trim();
  return folderPath ? `${folderPath}/${eagleName}` : null;
}

function pickTopTwoScores(scores: SectionScoreBreakdown): {
  top1: { label: keyof SectionScoreBreakdown; score: number };
  top2: { label: keyof SectionScoreBreakdown; score: number } | null;
} {
  const sorted = (Object.entries(scores) as Array<[keyof SectionScoreBreakdown, number]>).sort(
    (a, b) => b[1] - a[1],
  );
  return {
    top1: { label: sorted[0][0], score: sorted[0][1] },
    top2: sorted[1] ? { label: sorted[1][0], score: sorted[1][1] } : null,
  };
}

function toSectionType(value: string | null): SectionType | null {
  if (!value) {
    return null;
  }
  if ((SECTION_TYPES as string[]).includes(value)) {
    return value as SectionType;
  }
  return null;
}

function debugRowKey(row: SectionDebugRow): string {
  return `${row.phase}:${row.selector}:${row.bbox.y}:${row.bbox.height}`;
}

function formatCoreRouteCardLabel(path: string): string {
  return path === "/" ? "Home" : path;
}

function parseJobMode(optionsJson: string | null): JobMode {
  if (!optionsJson) {
    return "single";
  }
  try {
    const parsed = JSON.parse(optionsJson) as { mode?: unknown };
    return parsed.mode === "core-routes" ? "core-routes" : "single";
  } catch {
    return "single";
  }
}

function formatJobModeLabel(mode: JobMode): string {
  return mode === "core-routes" ? "Core Pages" : "Section";
}

function formatAssetImportStatus(
  status: AssetImportStatus,
  selectedForImport: boolean,
  error: string | null,
): string {
  if (status === "imported") {
    return "Imported to Eagle";
  }
  if (status === "pending_confirmation") {
    return formatPendingImportLabel(selectedForImport);
  }
  return `Import failed: ${error ?? "Unknown error"}`;
}

function summarizeAssets(assets: JobAsset[]): {
  pending: number;
  imported: number;
  failed: number;
  selectedPending: number;
  selectedFailed: number;
  selectedPendingMissingFolderCount: number;
  selectedFailedMissingFolderCount: number;
} {
  let pending = 0;
  let imported = 0;
  let failed = 0;
  let selectedPending = 0;
  let selectedFailed = 0;
  let selectedPendingMissingFolderCount = 0;
  let selectedFailedMissingFolderCount = 0;

  for (const asset of assets) {
    if (asset.importStatus === "imported") {
      imported += 1;
      continue;
    }
    if (asset.importStatus === "failed") {
      failed += 1;
      if (asset.selectedForImport) {
        selectedFailed += 1;
        if (asset.folderSelectionSource === "missing") {
          selectedFailedMissingFolderCount += 1;
        }
      }
      continue;
    }
    pending += 1;
    if (asset.selectedForImport) {
      selectedPending += 1;
      if (asset.folderSelectionSource === "missing") {
        selectedPendingMissingFolderCount += 1;
      }
    }
  }

  return {
    pending,
    imported,
    failed,
    selectedPending,
    selectedFailed,
    selectedPendingMissingFolderCount,
    selectedFailedMissingFolderCount,
  };
}

function StatusBadge({
  status,
  label,
  tone,
  emphasis = false,
}: {
  status: JobStatus | RouteTargetSummary["status"];
  label?: string;
  tone?: JobStatus | RouteTargetSummary["status"];
  emphasis?: boolean;
}) {
  const active = isActiveStatus(status);
  return (
    <span className={cx(statusClass(tone ?? status), active && "status-live", emphasis && "status-emphasis")}>
      {active ? (
        <span className="status-indicator" aria-hidden="true">
          <span className="status-indicator-ring" />
          <span className="status-indicator-dot" />
        </span>
      ) : null}
      <span>{label ?? formatStatusLabel(status)}</span>
    </span>
  );
}

function useElementSize<T extends HTMLElement>(ref: { current: T | null }): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }

    const update = () => {
      setSize({
        width: element.clientWidth,
        height: element.clientHeight,
      });
    };

    update();

    const observer = new ResizeObserver(() => {
      update();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

const AssetThumbnail = memo(function AssetThumbnail({
  asset,
  alt,
  className,
}: {
  asset: Pick<JobAsset, "thumbnailUrl" | "thumbnailWidth" | "thumbnailHeight" | "fileName">;
  alt: string;
  className?: string;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const loaded = loadedSrc === asset.thumbnailUrl;

  useLayoutEffect(() => {
    const image = imgRef.current;
    if (image?.complete && image.naturalWidth > 0) {
      setLoadedSrc(asset.thumbnailUrl);
      return;
    }
    setLoadedSrc(null);
  }, [asset.thumbnailUrl]);

  return (
    <span className={cx("asset-thumbnail-frame", loaded && "asset-thumbnail-frame-loaded", className)}>
      <img
        key={asset.thumbnailUrl}
        ref={imgRef}
        src={asset.thumbnailUrl}
        alt={alt}
        width={asset.thumbnailWidth}
        height={asset.thumbnailHeight}
        loading="lazy"
        decoding="async"
        className={cx("asset-thumbnail-image", loaded && "asset-thumbnail-image-loaded")}
        onLoad={() => setLoadedSrc(asset.thumbnailUrl)}
        onError={() => setLoadedSrc(null)}
      />
    </span>
  );
});

function formatFolderSelectionSourceLabel(source: FolderSelectionSource): string {
  switch (source) {
    case "manual":
      return "Manual";
    case "auto":
      return "Auto";
    default:
      return "Pending";
  }
}

const AssetFolderControl = memo(function AssetFolderControl({
  asset,
  disabled,
  onOpenFolderPicker,
}: {
  asset: Pick<
    JobAsset,
    | "id"
    | "importStatus"
    | "selectedForImport"
    | "folderSelectionSource"
    | "resolvedEagleFolderPath"
    | "targetEagleFolderPath"
  >;
  disabled: boolean;
  onOpenFolderPicker: (assetId: number) => void;
}) {
  const isImported = asset.importStatus === "imported";
  const currentPath = asset.targetEagleFolderPath ?? "";
  const displayName = currentPath ? formatFolderNameForCard(currentPath) : "";
  const displayPath = currentPath ? formatFolderPathForCard(currentPath, 38) : "";
  const showSecondaryPath = Boolean(displayPath) && displayPath !== displayName;
  const needsFolderSelection =
    asset.selectedForImport && !isImported && asset.folderSelectionSource === "missing";

  return (
    <div className={cx("asset-folder-field", needsFolderSelection && "asset-folder-field-missing")}>
      <div className="asset-folder-field-header">
        <span className="asset-folder-label">Folder</span>
        <span className={cx("asset-folder-source", `asset-folder-source-${asset.folderSelectionSource}`)}>
          {formatFolderSelectionSourceLabel(asset.folderSelectionSource)}
        </span>
      </div>
      {isImported ? (
        <div className="asset-folder-readonly" title={currentPath || undefined}>
          {displayName ? (
            <div className="asset-folder-path-stack">
              <span className="asset-folder-path-primary">{displayName}</span>
              {showSecondaryPath ? <span className="asset-folder-path-secondary">{displayPath}</span> : null}
            </div>
          ) : (
            <span className="asset-folder-path asset-folder-path-empty">—</span>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="asset-folder-trigger"
          disabled={disabled}
          onClick={() => onOpenFolderPicker(asset.id)}
          title={currentPath || undefined}
        >
          {displayName ? (
            <span className="asset-folder-path-stack">
              <span className="asset-folder-path-primary">{displayName}</span>
              {showSecondaryPath ? <span className="asset-folder-path-secondary">{displayPath}</span> : null}
            </span>
          ) : (
            <span className="asset-folder-path asset-folder-path-empty">Choose an Eagle folder</span>
          )}
          <span className="asset-folder-trigger-chevron" aria-hidden="true" />
        </button>
      )}
      {asset.folderSelectionSource === "manual" &&
      asset.resolvedEagleFolderPath &&
      asset.resolvedEagleFolderPath !== currentPath ? (
        <div className="asset-folder-hint">Suggested: {asset.resolvedEagleFolderPath}</div>
      ) : null}
      {asset.folderSelectionSource === "missing" ? (
        <div className="asset-folder-hint asset-folder-hint-warning">
          {asset.selectedForImport
            ? "Selected assets need an existing Eagle folder first."
            : "No matching Eagle folder yet. Pick one manually."}
        </div>
      ) : null}
    </div>
  );
});

const AssetCard = memo(function AssetCard({
  asset,
  selected,
  compact = false,
  assetActionsDisabled,
  folderSaving,
  hasSectionDebug,
  onToggleSelection,
  onOpenFolderPicker,
  onOpenPreview,
  onFocusDebug,
  trailingToolbarAction,
}: {
  asset: JobAsset;
  selected: boolean;
  compact?: boolean;
  assetActionsDisabled: boolean;
  folderSaving: boolean;
  hasSectionDebug: boolean;
  onToggleSelection: (assetId: number, checked: boolean) => void | Promise<void>;
  onOpenFolderPicker: (assetId: number) => void;
  onOpenPreview: (assetId: number) => void;
  onFocusDebug: (asset: JobAsset) => void;
  trailingToolbarAction?: ReactNode;
}) {
  const needsFolderSelection =
    asset.selectedForImport && asset.importStatus !== "imported" && asset.folderSelectionSource === "missing";
  const canFocusDebug = canFocusDebugAsset(asset, hasSectionDebug);

  return (
    <article
      data-asset-id={asset.id}
      data-needs-folder={needsFolderSelection ? "true" : undefined}
      className={cx(
        compact ? "route-asset-card" : "asset-card",
        !asset.selectedForImport && (compact ? "route-asset-card-unselected" : "asset-card-unselected"),
        selected && (compact ? "route-asset-card-focused" : "asset-card-focused"),
        needsFolderSelection && (compact ? "route-asset-card-needs-folder" : "asset-card-needs-folder"),
      )}
    >
      <div className={compact ? "route-asset-toolbar" : "asset-card-toolbar"}>
        <label className="asset-select-control">
          <input
            type="checkbox"
            checked={asset.selectedForImport}
            disabled={assetActionsDisabled}
            onChange={(event) => void onToggleSelection(asset.id, event.target.checked)}
          />
          <span>Import</span>
        </label>
        {trailingToolbarAction || canFocusDebug ? (
          <div className="asset-toolbar-actions">
            {trailingToolbarAction}
            {canFocusDebug ? (
              <button
                type="button"
                className="asset-icon-button"
                onClick={() => onFocusDebug(asset)}
                aria-label="Focus debug"
                title="Focus debug"
              >
                <span className="asset-focus-icon" aria-hidden="true">
                  <span className="asset-focus-icon-corners" />
                  <span className="asset-focus-icon-dot" />
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className={cx("asset-preview-trigger", compact && "core-route-preview-trigger")}
        onClick={() => onOpenPreview(asset.id)}
      >
        <AssetThumbnail asset={asset} alt={asset.fileName} />
      </button>
      <div className={compact ? "route-asset-meta" : "asset-meta"}>
        {!compact ? <strong>{asset.label}</strong> : null}
        {compact ? <span>{formatAssetImportStatus(asset.importStatus, asset.selectedForImport, asset.importError)}</span> : null}
      </div>
      <div className={compact ? "route-asset-folder-wrap" : "asset-folder-wrap"}>
        <AssetFolderControl
          asset={asset}
          disabled={assetActionsDisabled || folderSaving}
          onOpenFolderPicker={onOpenFolderPicker}
        />
      </div>
      {compact && canFocusDebug ? (
        <div className="route-asset-actions">
          <button type="button" onClick={() => onFocusDebug(asset)}>
            Focus Debug
          </button>
        </div>
      ) : null}
    </article>
  );
});

const JobsListPanel = memo(function JobsListPanel({
  jobs,
  selectedJobId,
  runningJobId,
  exitingJobIds,
  archivingJobId,
  totalPages,
  page,
  onSelectJob,
  onArchiveJob,
  onCleanJob,
  onPreviousPage,
  onNextPage,
}: {
  jobs: JobSummary[];
  selectedJobId: string | null;
  runningJobId: string | null;
  exitingJobIds: ReadonlySet<string>;
  archivingJobId: string | null;
  totalPages: number;
  page: number;
  onSelectJob: (jobId: string) => void;
  onArchiveJob: (jobId: string, archived: boolean) => void;
  onCleanJob: (jobId: string) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
}) {
  return (
    <section className="jobs-list">
      {jobs.map((job) => {
        const jobIsLive = runningJobId === job.id || isActiveStatus(job.status);
        const showQuickArchive = canQuickArchiveJob(job);
        const showMoveToHistory = canMoveJobToHistory(job);
        const showQuickActions = showQuickArchive || showMoveToHistory;
        const nextArchivedState = !Boolean(job.archivedAt);
        const isExiting = exitingJobIds.has(job.id);
        const isArchiving = archivingJobId === job.id;
        return (
          <div key={job.id} className={cx("job-card-shell", isExiting && "job-card-shell-exiting")}>
            <article
              className={cx(
                "job-card",
                selectedJobId === job.id && "selected",
                jobIsLive && "job-card-live",
                showQuickActions && "job-card-has-action",
                isExiting && "job-card-exiting",
              )}
              role="button"
              tabIndex={0}
              aria-pressed={selectedJobId === job.id}
              onClick={() => onSelectJob(job.id)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) {
                  return;
                }
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectJob(job.id);
                }
              }}
            >
              <div className="job-top">
                <div className="job-top-left">
                  {(() => {
                    const badge =
                      job.status === "partial_success"
                        ? formatPartialSuccessJobBadge({
                            imported: job.importSuccessCount,
                            failed: job.importFailedCount,
                            pending: job.pendingConfirmationCount,
                          })
                        : null;
                    return <StatusBadge status={job.status} label={badge?.label} tone={badge?.tone} />;
                  })()}
                  {job.cleanedAt ? (
                    <span className="job-cleaned-pill">files cleaned</span>
                  ) : job.archivedAt ? (
                    <span className="job-archived-pill">history</span>
                  ) : null}
                </div>
              </div>
              <div className="job-title">
                {job.sourceUrl ? <ExternalLink href={job.sourceUrl} label={job.sourceUrl} /> : "No URL"}
              </div>
              {shouldShowJobInstruction(job) ? (
                <div className="job-instruction">
                  <LinkifiedText text={job.instruction} />
                </div>
              ) : null}
              <div className="job-stats">
                <span>Assets {job.assetCount}</span>
                <span>Pending {job.pendingConfirmationCount}</span>
                <span>Imported {job.importSuccessCount}</span>
                <span>Failed {job.importFailedCount}</span>
              </div>
              <div className="job-meta-row">
                <span className="job-time">{formatDate(job.createdAt)}</span>
                {job.cleanedAt ? (
                  <div className="job-cleaned-note">Files cleaned · {formatDate(job.cleanedAt)}</div>
                ) : job.archivedAt ? (
                  <div className="job-archived-note">Moved to history · {formatDate(job.archivedAt)}</div>
                ) : job.importCompletedAt ? (
                  <div className="job-auto-history-note">
                    Auto history · {formatAutoHistoryDate(job.importCompletedAt)}
                  </div>
                ) : null}
              </div>
              {runningJobId === job.id ? <div className="job-live-note">Running</div> : null}
              {showQuickActions ? (
                <div className="job-card-quick-actions">
                  {showQuickArchive ? (
                    <button
                      type="button"
                      className="job-card-quick-action"
                      disabled={archivingJobId !== null}
                      aria-busy={isArchiving || undefined}
                      onClick={(event) => {
                        event.stopPropagation();
                        onArchiveJob(job.id, nextArchivedState);
                      }}
                      aria-label={nextArchivedState ? "Archive job" : "Unarchive job"}
                    >
                      {isArchiving
                        ? nextArchivedState
                          ? "Archiving..."
                          : "Unarchiving..."
                        : nextArchivedState
                          ? "Archive"
                          : "Unarchive"}
                    </button>
                  ) : null}
                  {showMoveToHistory ? (
                    <button
                      type="button"
                      className="job-card-quick-action job-card-clean-action"
                      disabled={archivingJobId !== null}
                      onClick={(event) => {
                        event.stopPropagation();
                        onCleanJob(job.id);
                      }}
                      aria-label={job.archivedAt ? "Clean local files" : "Move job to history"}
                    >
                      {job.archivedAt ? "Clean files" : "Move to history"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </article>
          </div>
        );
      })}
      {jobs.length === 0 ? <div className="empty-text">No jobs</div> : null}

      <div className="pagination">
        <button type="button" disabled={page <= 1} onClick={onPreviousPage}>
          Prev
        </button>
        <span>
          {page} / {totalPages}
        </span>
        <button type="button" disabled={page >= totalPages} onClick={onNextPage}>
          Next
        </button>
      </div>
    </section>
  );
});

const JobDetailSummary = memo(function JobDetailSummary({
  detail,
  statusNote,
  isRunning,
  canCancel,
  canArchive,
  archiving,
  canClean,
  canRescan,
  rescanDisabled,
  rescanning,
  mode,
  assetImportSummary,
  canImportSelected,
  canRetryFailedImport,
  importingSelected,
  retryingFailedImport,
  onCancel,
  onArchive,
  onClean,
  onRescan,
  onImportSelected,
  onRevealImportBlocker,
  onRetryImport,
}: {
  detail: JobDetail;
  statusNote: string | null;
  isRunning: boolean;
  canCancel: boolean;
  canArchive: boolean;
  archiving: boolean;
  canClean: boolean;
  canRescan: boolean;
  rescanDisabled: boolean;
  rescanning: boolean;
  mode: JobMode;
  assetImportSummary: ReturnType<typeof summarizeAssets>;
  canImportSelected: boolean;
  canRetryFailedImport: boolean;
  importingSelected: boolean;
  retryingFailedImport: boolean;
  onCancel: (jobId: string) => void;
  onArchive: (jobId: string, archived: boolean) => void;
  onClean: (jobId: string) => void;
  onRescan: (jobId: string) => void | Promise<void>;
  onImportSelected: (jobId: string) => void | Promise<void>;
  onRevealImportBlocker: () => void;
  onRetryImport: (jobId: string) => void | Promise<void>;
}) {
  const importBlockedByFolders =
    !canImportSelected &&
    !importingSelected &&
    assetImportSummary.selectedPending > 0 &&
    assetImportSummary.selectedPendingMissingFolderCount > 0;

  return (
    <>
      <div className="detail-header">
        <div>
          <h3>Detail</h3>
          <p>
            <LinkifiedText text={detail.job.instruction} />
          </p>
        </div>
        <div className={cx("detail-status", isRunning && "detail-status-live")}>
          {(() => {
            const badge =
              detail.job.status === "partial_success" && !detail.job.cleanedAt
                ? formatPartialSuccessJobBadge({
                    imported: assetImportSummary.imported,
                    failed: assetImportSummary.failed,
                    pending: assetImportSummary.pending,
                  })
                : null;
            return <StatusBadge status={detail.job.status} label={badge?.label} tone={badge?.tone} emphasis />;
          })()}
          {statusNote ? <span className="detail-status-note">{statusNote}</span> : null}
        </div>
      </div>

      <div className="detail-actions">
        {!detail.job.cleanedAt ? (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={!canImportSelected && !importBlockedByFolders}
              data-blocked={importBlockedByFolders ? "true" : undefined}
              loading={importingSelected}
              loadingLabel="Queueing..."
              title={importBlockedByFolders ? "Jump to the first selected asset that needs a folder" : undefined}
              onClick={() => {
                if (canImportSelected) {
                  void onImportSelected(detail.job.id);
                  return;
                }
                if (importBlockedByFolders) {
                  onRevealImportBlocker();
                }
              }}
            >
              {importBlockedByFolders ? "Fix folders" : "Import selected"}
            </Button>
            {assetImportSummary.failed > 0 ? (
              <Button
                size="sm"
                disabled={!canRetryFailedImport}
                loading={retryingFailedImport}
                loadingLabel="Queueing retry..."
                onClick={() => void onRetryImport(detail.job.id)}
              >
                Retry failed
              </Button>
            ) : null}
          </>
        ) : null}
        {canCancel ? (
          <Button variant="danger" size="sm" onClick={() => onCancel(detail.job.id)}>
            Cancel
          </Button>
        ) : null}
        {canRescan ? (
          <Button
            size="sm"
            disabled={rescanDisabled || rescanning}
            loading={rescanning}
            loadingLabel="Queueing..."
            onClick={() => void onRescan(detail.job.id)}
          >
            Rescan {formatJobModeLabel(mode)}
          </Button>
        ) : null}
        {canArchive ? (
          <Button
            size="sm"
            loading={archiving}
            loadingLabel={detail.job.archivedAt ? "Unarchiving..." : "Archiving..."}
            onClick={() => onArchive(detail.job.id, !Boolean(detail.job.archivedAt))}
          >
            {detail.job.archivedAt ? "Unarchive" : "Archive"}
          </Button>
        ) : null}
        {canClean ? (
          <Button variant="danger" size="sm" disabled={archiving} onClick={() => onClean(detail.job.id)}>
            {detail.job.archivedAt ? "Clean files" : "Move to history"}
          </Button>
        ) : null}
        {detail.job.cleanedAt ? (
          <span className="detail-cleaned-note">Local files cleaned · history retained</span>
        ) : (
          <>
            <span>Pending: {assetImportSummary.pending}</span>
            {assetImportSummary.selectedPendingMissingFolderCount > 0 ? (
              <span>Pending folders: {assetImportSummary.selectedPendingMissingFolderCount}</span>
            ) : null}
            {assetImportSummary.selectedFailedMissingFolderCount > 0 ? (
              <span>Retry folders: {assetImportSummary.selectedFailedMissingFolderCount}</span>
            ) : null}
            <span>Imported: {assetImportSummary.imported}</span>
            <span>Failed: {assetImportSummary.failed}</span>
          </>
        )}
        <span>Started: {formatDate(detail.job.startedAt)}</span>
        <span>Finished: {formatDate(detail.job.finishedAt)}</span>
        {detail.job.importCompletedAt && !detail.job.cleanedAt ? (
          <span>Auto history: {formatAutoHistoryDate(detail.job.importCompletedAt)}</span>
        ) : null}
        {detail.job.archivedAt ? <span>Archived: {formatDate(detail.job.archivedAt)}</span> : null}
        {detail.job.cleanedAt ? <span>Cleaned: {formatDate(detail.job.cleanedAt)}</span> : null}
      </div>
    </>
  );
});

const CoreRoutesPanel = memo(function CoreRoutesPanel({
  detail,
  assetLookup,
  selectedAssetId,
  assetActionsDisabled,
  folderSavingAssetIds,
  hasSectionDebug,
  onToggleAssetSelection,
  onOpenFolderPicker,
  onOpenPreview,
  onFocusDebug,
  onRerunRoute,
  rerunningRouteId,
  browserActionsDisabled,
}: {
  detail: JobDetail;
  assetLookup: ReturnType<typeof buildAssetLookupIndex>;
  selectedAssetId: number | null;
  assetActionsDisabled: boolean;
  folderSavingAssetIds: Set<number>;
  hasSectionDebug: boolean;
  onToggleAssetSelection: (assetId: number, checked: boolean) => void | Promise<void>;
  onOpenFolderPicker: (assetId: number) => void;
  onOpenPreview: (assetId: number) => void;
  onFocusDebug: (asset: JobAsset) => void;
  onRerunRoute: (jobId: string, route: RouteTargetSummary) => void | Promise<void>;
  rerunningRouteId: number | null;
  browserActionsDisabled: boolean;
}) {
  return detail.routes.length > 0 ? (
    <div className="route-list-panel">
      <h4>Core Pages</h4>
      <div className="core-route-card-list">
        {detail.routes.map((route) => {
          const asset = findAssetForRouteFromIndex(route, assetLookup);
          const assets = findAssetsForRouteFromIndex(route, assetLookup);
          const previewState = getCoreRoutePreviewState(route.status, asset);
          const rerunAction = canRerunRoute(detail.job.status, route.status) ? (
            <Button
              size="sm"
              className="route-rerun-button"
              disabled={browserActionsDisabled || rerunningRouteId !== null}
              loading={rerunningRouteId === route.id}
              loadingLabel={route.status === "failed" ? "Retrying..." : "Rescanning..."}
              aria-label={`${route.status === "failed" ? "Retry" : "Rescan"} ${formatCoreRouteCardLabel(route.path)}`}
              onClick={() => void onRerunRoute(detail.job.id, route)}
            >
              {route.status === "failed" ? "Retry page" : "Rescan page"}
            </Button>
          ) : null;
          const canFocusRouteDebug = asset ? canFocusDebugAsset(asset, hasSectionDebug) : false;

          return (
            <article
              key={route.id}
              className={cx(
                "core-route-card",
                route.status === "running" && "core-route-card-live",
                route.status === "queued" && "core-route-card-queued",
              )}
            >
              <div className="core-route-card-main">
                <div className="core-route-card-top">
                  <StatusBadge status={route.status} />
                </div>
                <ExternalLink
                  href={route.url}
                  label={formatCoreRouteCardLabel(route.path)}
                  className="core-route-card-path"
                  title={route.url}
                />
                {canFocusRouteDebug || (!asset && rerunAction) ? (
                  <div className="core-route-card-actions">
                    {asset && canFocusRouteDebug ? (
                      <button type="button" onClick={() => onFocusDebug(asset)}>
                        Focus Debug
                      </button>
                    ) : null}
                    {!asset ? rerunAction : null}
                  </div>
                ) : null}
              </div>
              <div className="core-route-card-preview">
                {assets.length > 0 ? (
                  <div className="route-asset-grid">
                    {assets.map((routeAsset) => (
                      <AssetCard
                        key={routeAsset.id}
                        asset={routeAsset}
                        compact
                        selected={selectedAssetId === routeAsset.id}
                        assetActionsDisabled={assetActionsDisabled}
                        folderSaving={folderSavingAssetIds.has(routeAsset.id)}
                        hasSectionDebug={hasSectionDebug}
                        onToggleSelection={onToggleAssetSelection}
                        onOpenFolderPicker={onOpenFolderPicker}
                        onOpenPreview={onOpenPreview}
                        onFocusDebug={onFocusDebug}
                        trailingToolbarAction={routeAsset.id === asset?.id ? rerunAction : null}
                      />
                    ))}
                  </div>
                ) : (
                  <div className={cx("route-preview-placeholder", `route-preview-${previewState}`)}>
                    <strong className="route-preview-title">
                      {previewState === "pending"
                        ? "Waiting for capture"
                        : previewState === "failed"
                          ? "Capture failed"
                          : "No preview"}
                    </strong>
                    <span className="route-preview-copy">
                      {previewState === "pending"
                        ? "Still running or queued"
                        : previewState === "failed"
                          ? "No successful output"
                          : "No matching preview"}
                    </span>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  ) : null;
});

const AssetGridPanel = memo(function AssetGridPanel({
  assets,
  selectedAssetId,
  assetActionsDisabled,
  folderSavingAssetIds,
  hasSectionDebug,
  onToggleAssetSelection,
  onOpenFolderPicker,
  onOpenPreview,
  onFocusDebug,
}: {
  assets: JobAsset[];
  selectedAssetId: number | null;
  assetActionsDisabled: boolean;
  folderSavingAssetIds: Set<number>;
  hasSectionDebug: boolean;
  onToggleAssetSelection: (assetId: number, checked: boolean) => void | Promise<void>;
  onOpenFolderPicker: (assetId: number) => void;
  onOpenPreview: (assetId: number) => void;
  onFocusDebug: (asset: JobAsset) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(containerRef);
  const [scrollTop, setScrollTop] = useState(0);
  const shouldVirtualize = assets.length > ASSET_VIRTUALIZE_THRESHOLD;
  const columns = useMemo(() => getAssetGridColumns(width), [width]);

  const virtualWindow = useMemo(() => {
    if (!shouldVirtualize) {
      return {
        startIndex: 0,
        endIndex: assets.length,
        offsetTop: 0,
        totalHeight: 0,
        visibleAssets: assets,
        columns: 1,
      };
    }

    const activeColumns = columns || 1;
    const rowCount = Math.ceil(assets.length / activeColumns);
    const viewportHeight = Math.max(height || ASSET_GRID_ROW_HEIGHT * 2, ASSET_GRID_ROW_HEIGHT * 2);
    const startRow = Math.max(0, Math.floor(scrollTop / ASSET_GRID_ROW_HEIGHT) - ASSET_GRID_OVERSCAN_ROWS);
    const visibleRowCount = Math.ceil(viewportHeight / ASSET_GRID_ROW_HEIGHT) + ASSET_GRID_OVERSCAN_ROWS * 2;
    const endRow = Math.min(rowCount, startRow + visibleRowCount);
    const startIndex = startRow * activeColumns;
    const endIndex = Math.min(assets.length, endRow * activeColumns);

    return {
      startIndex,
      endIndex,
      offsetTop: startRow * ASSET_GRID_ROW_HEIGHT,
      totalHeight: rowCount * ASSET_GRID_ROW_HEIGHT,
      visibleAssets: assets.slice(startIndex, endIndex),
      columns: activeColumns,
    };
  }, [assets, columns, height, scrollTop, shouldVirtualize]);

  if (assets.length === 0) {
    return <div className="empty-text">暂无产物</div>;
  }

  if (!shouldVirtualize) {
    return (
      <div
        ref={containerRef}
        className="assets-grid"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {assets.map((asset) => (
          <AssetCard
            key={asset.id}
            asset={asset}
            selected={selectedAssetId === asset.id}
            assetActionsDisabled={assetActionsDisabled}
            folderSaving={folderSavingAssetIds.has(asset.id)}
            hasSectionDebug={hasSectionDebug}
            onToggleSelection={onToggleAssetSelection}
            onOpenFolderPicker={onOpenFolderPicker}
            onOpenPreview={onOpenPreview}
            onFocusDebug={onFocusDebug}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className="assets-grid-scroll"
      ref={containerRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="assets-grid-virtual-spacer" style={{ height: `${virtualWindow.totalHeight}px` }}>
        <div
          className="assets-grid assets-grid-virtual"
          style={
            {
              transform: `translateY(${virtualWindow.offsetTop}px)`,
              gridTemplateColumns: `repeat(${virtualWindow.columns}, minmax(0, 1fr))`,
            } satisfies CSSProperties
          }
        >
          {virtualWindow.visibleAssets.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              selected={selectedAssetId === asset.id}
              assetActionsDisabled={assetActionsDisabled}
              folderSaving={folderSavingAssetIds.has(asset.id)}
              hasSectionDebug={hasSectionDebug}
              onToggleSelection={onToggleAssetSelection}
              onOpenFolderPicker={onOpenFolderPicker}
              onOpenPreview={onOpenPreview}
              onFocusDebug={onFocusDebug}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

const LogsPanel = memo(function LogsPanel({
  logs,
  expanded,
  onToggle,
}: {
  logs: JobLog[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { height } = useElementSize(scrollRef);
  const [scrollTop, setScrollTop] = useState(0);
  const shouldVirtualize = expanded && logs.length > LOG_VIRTUALIZE_THRESHOLD;
  const viewportHeight = Math.max(height || 220, 220);
  const startIndex = shouldVirtualize ? Math.max(0, Math.floor(scrollTop / LOG_ROW_HEIGHT) - 4) : 0;
  const visibleCount = shouldVirtualize ? Math.ceil(viewportHeight / LOG_ROW_HEIGHT) + 8 : logs.length;
  const endIndex = shouldVirtualize ? Math.min(logs.length, startIndex + visibleCount) : logs.length;
  const visibleLogs = logs.slice(startIndex, endIndex);

  return (
    <div className="log-box">
      <div className="collapsible-panel-header">
        <h4>运行日志</h4>
        <button type="button" className="collapsible-toggle" onClick={onToggle}>
          {expanded ? "收起" : `展开 (${logs.length})`}
        </button>
      </div>
      {expanded ? (
        <div className="log-scroll" ref={scrollRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
          {shouldVirtualize ? (
            <div style={{ height: `${logs.length * LOG_ROW_HEIGHT}px`, position: "relative" }}>
              <div
                style={{ transform: `translateY(${startIndex * LOG_ROW_HEIGHT}px)` }}
                className="log-scroll-virtual"
              >
                {visibleLogs.map((log) => (
                  <div key={log.id} className={`log-line log-${log.level}`}>
                    <span>{new Date(log.ts).toLocaleTimeString()}</span>
                    <span>{log.level.toUpperCase()}</span>
                    <span>{log.message}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            logs.map((log) => (
              <div key={log.id} className={`log-line log-${log.level}`}>
                <span>{new Date(log.ts).toLocaleTimeString()}</span>
                <span>{log.level.toUpperCase()}</span>
                <span>{log.message}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="collapsible-panel-hint">默认折叠，避免大日志列表持续占用渲染和布局开销。</div>
      )}
    </div>
  );
});

const ManifestPanel = memo(function ManifestPanel({
  manifest,
  expanded,
  onToggle,
}: {
  manifest: ManifestView | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const manifestText = useMemo(() => {
    if (!expanded) {
      return "";
    }
    return JSON.stringify(manifest, null, 2);
  }, [expanded, manifest]);

  return (
    <div className="manifest-box">
      <div className="collapsible-panel-header">
        <h4>Manifest</h4>
        <button type="button" className="collapsible-toggle" onClick={onToggle}>
          {expanded ? "收起" : "展开"}
        </button>
      </div>
      {expanded ? (
        <pre>{manifestText}</pre>
      ) : (
        <div className="collapsible-panel-hint">默认折叠，避免在每次 detail 更新时序列化整份 manifest。</div>
      )}
    </div>
  );
});

const PreviewModal = memo(function PreviewModal({
  previewAsset,
  previewRoute,
  previewEagleName,
  previewEaglePath,
  previewHasDistinctEagleName,
  selectedJobDetail,
  selectedJobMode,
  assetActionsDisabled,
  hasSectionDebug,
  copyFeedbackState,
  onClose,
  onToggleSelection,
  onCopyFeedbackContext,
  onFocusAndClose,
  onCrop,
  onRestoreOriginal,
}: {
  previewAsset: JobAsset;
  previewRoute: RouteTargetSummary | null;
  previewEagleName: string | null;
  previewEaglePath: string | null;
  previewHasDistinctEagleName: boolean;
  selectedJobDetail: JobDetail;
  selectedJobMode: JobMode;
  assetActionsDisabled: boolean;
  hasSectionDebug: boolean;
  copyFeedbackState: CopyFeedbackState;
  onClose: () => void;
  onToggleSelection: (assetId: number, checked: boolean) => void | Promise<void>;
  onCopyFeedbackContext: () => void | Promise<void>;
  onFocusAndClose: (asset: JobAsset) => void;
  onCrop: (
    assetId: number,
    operation: AssetCropOperation,
    expectedWidth: number,
    expectedHeight: number,
  ) => Promise<boolean>;
  onRestoreOriginal: (assetId: number) => void;
}) {
  const imageWrapRef = useRef<HTMLDivElement | null>(null);
  const cropStageRef = useRef<HTMLDivElement | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [cropToolMode, setCropToolMode] = useState<CropToolMode>(readLastCropToolMode);
  const [cropKeepHeight, setCropKeepHeight] = useState(previewAsset.imageHeight);
  const [cropBandStartY, setCropBandStartY] = useState(0);
  const [cropBandEndY, setCropBandEndY] = useState(0);
  const cropDragRef = useRef<{
    target: CropDragTarget;
    anchorY: number;
    startY: number;
    endY: number;
  } | null>(null);
  const canEditImage =
    !assetActionsDisabled &&
    previewAsset.importStatus !== "imported" &&
    previewAsset.imageHeight > 64;
  const canRestoreOriginal = previewAsset.canRestoreOriginal;
  const canFocusDebug = canFocusDebugAsset(previewAsset, hasSectionDebug);
  const secondaryActionCount = Number(canRestoreOriginal) + Number(canFocusDebug);
  const originalPageUrl = resolveLinkHref(previewAsset.sourceUrl ?? previewRoute?.url ?? "");
  const normalizedKeepHeight = Math.max(
    64,
    Math.min(previewAsset.imageHeight - 1, Math.round(cropKeepHeight)),
  );
  const normalizedBandStartY = Math.max(
    0,
    Math.min(previewAsset.imageHeight - 1, Math.round(cropBandStartY)),
  );
  const normalizedBandEndY = Math.max(
    normalizedBandStartY + 1,
    Math.min(previewAsset.imageHeight, Math.round(cropBandEndY)),
  );
  const removalStartY =
    cropToolMode === "bottom" ? normalizedKeepHeight : normalizedBandStartY;
  const removalEndY =
    cropToolMode === "bottom" ? previewAsset.imageHeight : normalizedBandEndY;
  const removedHeight = Math.max(0, removalEndY - removalStartY);
  const removalStartPercent = (removalStartY / previewAsset.imageHeight) * 100;
  const removalEndPercent = (removalEndY / previewAsset.imageHeight) * 100;

  useEffect(() => {
    setCropMode(false);
    setCropKeepHeight(previewAsset.imageHeight);
    setCropBandStartY(0);
    setCropBandEndY(0);
    cropDragRef.current = null;
  }, [previewAsset.id, previewAsset.imageHeight]);

  const getNaturalYFromClientY = useCallback((clientY: number): number | null => {
    const stage = cropStageRef.current;
    if (!stage) {
      return null;
    }
    const rect = stage.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return Math.round(ratio * previewAsset.imageHeight);
  }, [previewAsset.imageHeight]);

  const scrollToNaturalY = useCallback((naturalY: number): void => {
    window.requestAnimationFrame(() => {
      const wrap = imageWrapRef.current;
      const stage = cropStageRef.current;
      if (!wrap || !stage) {
        return;
      }
      const lineY = stage.offsetHeight * (naturalY / previewAsset.imageHeight);
      wrap.scrollTo({
        top: Math.max(0, lineY - wrap.clientHeight * 0.5),
        behavior: "smooth",
      });
    });
  }, [previewAsset.imageHeight]);

  const setDefaultCropForMode = useCallback((mode: CropToolMode, shouldScroll = true): void => {
    if (mode === "bottom") {
      const keepHeight = Math.max(64, Math.round(previewAsset.imageHeight * 0.9));
      setCropKeepHeight(keepHeight);
      if (shouldScroll) {
        scrollToNaturalY(keepHeight);
      }
      return;
    }

    const bandHeight = Math.max(1, Math.round(previewAsset.imageHeight * 0.2));
    const startY = Math.max(0, Math.round((previewAsset.imageHeight - bandHeight) / 2));
    const endY = Math.min(previewAsset.imageHeight, startY + bandHeight);
    setCropBandStartY(startY);
    setCropBandEndY(endY);
    if (shouldScroll) {
      scrollToNaturalY(startY + (endY - startY) / 2);
    }
  }, [previewAsset.imageHeight, scrollToNaturalY]);

  const beginCrop = useCallback((): void => {
    setDefaultCropForMode(cropToolMode);
    setCropMode(true);
  }, [cropToolMode, setDefaultCropForMode]);

  const switchCropToolMode = useCallback((mode: CropToolMode): void => {
    setCropToolMode(mode);
    rememberCropToolMode(mode);
    setDefaultCropForMode(mode);
    cropDragRef.current = null;
  }, [setDefaultCropForMode]);

  const beginCropDrag = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    target: CropDragTarget,
  ): void => {
    const naturalY = getNaturalYFromClientY(event.clientY);
    if (naturalY === null) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    cropDragRef.current = {
      target,
      anchorY: naturalY,
      startY: normalizedBandStartY,
      endY: normalizedBandEndY,
    };
    if (target === "bottom") {
      setCropKeepHeight(
        Math.max(64, Math.min(previewAsset.imageHeight - 1, naturalY)),
      );
    }
  }, [
    getNaturalYFromClientY,
    normalizedBandEndY,
    normalizedBandStartY,
    previewAsset.imageHeight,
  ]);

  const moveCropDrag = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    const drag = cropDragRef.current;
    const naturalY = getNaturalYFromClientY(event.clientY);
    if (!drag || naturalY === null) {
      return;
    }

    if (drag.target === "bottom") {
      setCropKeepHeight(
        Math.max(64, Math.min(previewAsset.imageHeight - 1, naturalY)),
      );
      return;
    }
    if (drag.target === "band-start") {
      setCropBandStartY(Math.max(0, Math.min(normalizedBandEndY - 1, naturalY)));
      return;
    }
    if (drag.target === "band-end") {
      setCropBandEndY(
        Math.max(normalizedBandStartY + 1, Math.min(previewAsset.imageHeight, naturalY)),
      );
      return;
    }

    const bandHeight = drag.endY - drag.startY;
    const requestedStartY = drag.startY + naturalY - drag.anchorY;
    const nextStartY = Math.max(
      0,
      Math.min(previewAsset.imageHeight - bandHeight, requestedStartY),
    );
    setCropBandStartY(nextStartY);
    setCropBandEndY(nextStartY + bandHeight);
  }, [
    getNaturalYFromClientY,
    normalizedBandEndY,
    normalizedBandStartY,
    previewAsset.imageHeight,
  ]);

  const endCropDrag = useCallback((): void => {
    cropDragRef.current = null;
  }, []);

  return (
    <div className="asset-preview-modal-backdrop" onClick={onClose}>
      <div className="asset-preview-modal" onClick={(event) => event.stopPropagation()}>
        <div className="asset-preview-modal-header">
          <div>
            <strong>{previewEagleName ?? previewAsset.fileName}</strong>
            <span>{previewRoute ? `${previewRoute.path} · ${previewRoute.status}` : previewAsset.label}</span>
          </div>
          <button type="button" className="asset-preview-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="asset-preview-modal-body">
          <div className="asset-preview-image-wrap" ref={imageWrapRef}>
            <div
              className={cx("asset-preview-crop-stage", cropMode && "asset-preview-crop-stage-active")}
              ref={cropStageRef}
            >
              <img
                key={previewAsset.previewUrl}
                src={previewAsset.previewUrl}
                alt={previewAsset.fileName}
                className="asset-preview-image"
                decoding="async"
              />
              {cropMode ? (
                <>
                  <button
                    type="button"
                    className={cx(
                      "asset-crop-discard-overlay",
                      cropToolMode === "band" && "asset-crop-discard-overlay-movable",
                    )}
                    style={{
                      top: `${removalStartPercent}%`,
                      bottom: `${100 - removalEndPercent}%`,
                    }}
                    aria-label={
                      cropToolMode === "band"
                        ? "Drag section to remove"
                        : `Crop ${removedHeight.toLocaleString()} px from the bottom`
                    }
                    onPointerDown={
                      cropToolMode === "band"
                        ? (event) => beginCropDrag(event, "band-body")
                        : undefined
                    }
                    onPointerMove={cropToolMode === "band" ? moveCropDrag : undefined}
                    onPointerUp={cropToolMode === "band" ? endCropDrag : undefined}
                    onPointerCancel={cropToolMode === "band" ? endCropDrag : undefined}
                  >
                    <span>
                      {cropToolMode === "bottom" ? "Crop bottom" : "Remove section"}
                      {" · "}
                      {removedHeight.toLocaleString()} px
                    </span>
                  </button>
                  <button
                    type="button"
                    className="asset-crop-handle asset-crop-handle-start"
                    style={{ top: `${removalStartPercent}%` }}
                    aria-label={
                      cropToolMode === "bottom" ? "Drag bottom crop line" : "Drag section top edge"
                    }
                    onPointerDown={(event) =>
                      beginCropDrag(
                        event,
                        cropToolMode === "bottom" ? "bottom" : "band-start",
                      )
                    }
                    onPointerMove={moveCropDrag}
                    onPointerUp={endCropDrag}
                    onPointerCancel={endCropDrag}
                  >
                    <span />
                  </button>
                  {cropToolMode === "band" ? (
                    <button
                      type="button"
                      className="asset-crop-handle asset-crop-handle-end"
                      style={{ top: `${removalEndPercent}%` }}
                      aria-label="Drag section bottom edge"
                      onPointerDown={(event) => beginCropDrag(event, "band-end")}
                      onPointerMove={moveCropDrag}
                      onPointerUp={endCropDrag}
                      onPointerCancel={endCropDrag}
                    >
                      <span />
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
          <aside className="asset-preview-sidebar">
            <div className="asset-preview-actions">
              <label className="asset-select-control asset-select-control-inline asset-preview-import-control">
                <input
                  type="checkbox"
                  checked={previewAsset.selectedForImport}
                  disabled={assetActionsDisabled}
                  onChange={(event) => void onToggleSelection(previewAsset.id, event.target.checked)}
                />
                <span>Import to Eagle</span>
              </label>
              {!cropMode ? (
                <>
                  <button
                    type="button"
                    className="asset-preview-primary-action"
                    disabled={!canEditImage}
                    title={
                      previewAsset.importStatus === "imported"
                        ? "Assets already imported to Eagle cannot be cropped"
                        : "Remove unwanted regions from the screenshot"
                    }
                    onClick={beginCrop}
                  >
                    <Crop className="asset-preview-primary-action-icon" aria-hidden="true" />
                    <span>Crop image</span>
                  </button>
                  <div
                    className={cx(
                      "asset-preview-secondary-actions",
                      !originalPageUrl && "asset-preview-secondary-actions-single",
                    )}
                  >
                    {originalPageUrl ? (
                      <a
                        className="asset-preview-source-action"
                        href={originalPageUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        title="Open original site in an external browser"
                      >
                        <span>Visit original</span>
                        <span className="asset-preview-source-action-icon" aria-hidden="true">
                          ↗
                        </span>
                      </a>
                    ) : null}
                    <button
                      type="button"
                      className={`asset-preview-feedback-action${
                        copyFeedbackState === "success"
                          ? " is-success"
                          : copyFeedbackState === "error"
                            ? " is-error"
                            : ""
                      }`}
                      aria-label={
                        copyFeedbackState === "success"
                          ? "Feedback copied"
                          : copyFeedbackState === "error"
                            ? "Copy failed"
                            : "Copy feedback"
                      }
                      aria-live="polite"
                      onClick={() => void onCopyFeedbackContext()}
                    >
                      {copyFeedbackState === "success" ? (
                        <span className="asset-preview-feedback-success-icon" aria-hidden="true">
                          ✓
                        </span>
                      ) : copyFeedbackState === "error" ? (
                        "Copy failed"
                      ) : (
                        "Copy feedback"
                      )}
                    </button>
                  </div>
                  {secondaryActionCount === 1 && canRestoreOriginal ? (
                    <button
                      type="button"
                      className="asset-preview-utility-action"
                      disabled={!canEditImage}
                      onClick={() => onRestoreOriginal(previewAsset.id)}
                    >
                      Restore original
                    </button>
                  ) : null}
                  {secondaryActionCount === 1 && canFocusDebug ? (
                    <button
                      type="button"
                      className="asset-preview-utility-action"
                      onClick={() => onFocusAndClose(previewAsset)}
                    >
                      Focus debug
                    </button>
                  ) : null}
                  {secondaryActionCount > 1 ? (
                    <details className="asset-preview-more-actions">
                      <summary>More actions</summary>
                      <div className="asset-preview-more-menu">
                        {canRestoreOriginal ? (
                          <button
                            type="button"
                            disabled={!canEditImage}
                            onClick={() => onRestoreOriginal(previewAsset.id)}
                          >
                            Restore original
                          </button>
                        ) : null}
                        {canFocusDebug ? (
                          <button type="button" onClick={() => onFocusAndClose(previewAsset)}>
                            Focus debug
                          </button>
                        ) : null}
                      </div>
                    </details>
                  ) : null}
                </>
              ) : null}
            </div>
            {cropMode ? (
              <div className="asset-crop-controls">
                <div className="asset-crop-mode-switch" role="tablist" aria-label="Crop mode">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={cropToolMode === "bottom"}
                    className={cropToolMode === "bottom" ? "active" : undefined}
                    onClick={() => switchCropToolMode("bottom")}
                  >
                    Crop bottom
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={cropToolMode === "band"}
                    className={cropToolMode === "band" ? "active" : undefined}
                    onClick={() => switchCropToolMode("band")}
                  >
                    Remove section
                  </button>
                </div>
                <div className="asset-crop-summary">
                  <strong>{cropToolMode === "bottom" ? "Bottom crop" : "Horizontal section"}</strong>
                  <span>
                    {cropToolMode === "bottom"
                      ? `Keep ${normalizedKeepHeight.toLocaleString()} px`
                      : `${normalizedBandStartY.toLocaleString()}–${normalizedBandEndY.toLocaleString()} px`}
                    {" · "}
                    Remove {removedHeight.toLocaleString()} px
                  </span>
                </div>
                {cropToolMode === "bottom" ? (
                  <input
                    type="range"
                    min={64}
                    max={Math.max(64, previewAsset.imageHeight - 1)}
                    step={1}
                    value={normalizedKeepHeight}
                    aria-label="Keep image height"
                    onChange={(event) => setCropKeepHeight(Number(event.target.value))}
                  />
                ) : (
                  <div className="asset-crop-coordinate-inputs">
                    <label>
                      <span>Start</span>
                      <span className="asset-crop-number-field">
                        <input
                          type="number"
                          min={0}
                          max={normalizedBandEndY - 1}
                          step={1}
                          value={normalizedBandStartY}
                          onChange={(event) =>
                            setCropBandStartY(
                              Math.max(
                                0,
                                Math.min(normalizedBandEndY - 1, Number(event.target.value)),
                              ),
                            )
                          }
                        />
                        <span>px</span>
                      </span>
                    </label>
                    <label>
                      <span>End</span>
                      <span className="asset-crop-number-field">
                        <input
                          type="number"
                          min={normalizedBandStartY + 1}
                          max={previewAsset.imageHeight}
                          step={1}
                          value={normalizedBandEndY}
                          onChange={(event) =>
                            setCropBandEndY(
                              Math.max(
                                normalizedBandStartY + 1,
                                Math.min(previewAsset.imageHeight, Number(event.target.value)),
                              ),
                            )
                          }
                        />
                        <span>px</span>
                      </span>
                    </label>
                  </div>
                )}
                <div className="asset-crop-control-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setCropMode(false);
                      setCropKeepHeight(previewAsset.imageHeight);
                      cropDragRef.current = null;
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="asset-crop-apply"
                    disabled={assetActionsDisabled || removedHeight < 1}
                    onClick={() => {
                      const operation: AssetCropOperation =
                        cropToolMode === "bottom"
                          ? {
                              type: "remove-bottom",
                              keepHeight: normalizedKeepHeight,
                            }
                          : {
                              type: "remove-band",
                              startY: normalizedBandStartY,
                              endY: normalizedBandEndY,
                            };
                      void onCrop(
                        previewAsset.id,
                        operation,
                        previewAsset.imageWidth,
                        previewAsset.imageHeight,
                      ).then((saved) => {
                        if (saved) {
                          setCropMode(false);
                        }
                      });
                    }}
                  >
                    Apply crop
                  </button>
                </div>
              </div>
            ) : null}
            <dl className="asset-preview-meta">
              <div>
                <dt>Eagle Path</dt>
                <dd>{previewEaglePath ?? "—"}</dd>
              </div>
              <div>
                <dt>Eagle Folder</dt>
                <dd>{previewAsset.targetEagleFolderPath ?? "—"}</dd>
              </div>
              <div>
                <dt>Folder Source</dt>
                <dd>{formatFolderSelectionSourceLabel(previewAsset.folderSelectionSource)}</dd>
              </div>
              <div>
                <dt>Eagle Name</dt>
                <dd>{previewEagleName ?? "—"}</dd>
              </div>
              {previewAsset.folderSelectionSource === "manual" && previewAsset.resolvedEagleFolderPath ? (
                <div>
                  <dt>Suggested Folder</dt>
                  <dd>{previewAsset.resolvedEagleFolderPath}</dd>
                </div>
              ) : null}
              {previewHasDistinctEagleName ? (
                <div>
                  <dt>File Name</dt>
                  <dd>{previewAsset.fileName}</dd>
                </div>
              ) : null}
              <div>
                <dt>Job</dt>
                <dd>
                  {selectedJobDetail.job.id} · {formatJobModeLabel(selectedJobMode)} · {formatStatusLabel(selectedJobDetail.job.status)}
                </dd>
              </div>
              <div>
                <dt>Route</dt>
                <dd>
                  {previewRoute ? (
                    <>
                      <span>{previewRoute.path} · </span>
                      <ExternalLink href={previewRoute.url} label={previewRoute.url} />
                    </>
                  ) : "—"}
                </dd>
              </div>
              {previewRoute ? (
                <div>
                  <dt>Route Stats</dt>
                  <dd>
                    assets {previewRoute.assetCount} · attempts {previewRoute.attemptCount}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Asset</dt>
                <dd>
                  #{previewAsset.id} · {previewAsset.label} · {previewAsset.kind}
                  {previewAsset.sectionType ? ` · ${previewAsset.sectionType}` : ""}
                </dd>
              </div>
              <div>
                <dt>Capture</dt>
                <dd>
                  q{previewAsset.quality} · dpr{previewAsset.dpr} · {formatDate(previewAsset.capturedAt)}
                </dd>
              </div>
              <div>
                <dt>Import</dt>
                <dd>
                  {formatAssetImportStatus(
                    previewAsset.importStatus,
                    previewAsset.selectedForImport,
                    previewAsset.importError,
                  )}
                  {previewAsset.importStatus === "imported" && previewAsset.eagleId
                    ? ` · Eagle ${previewAsset.eagleId}`
                    : ""}
                </dd>
              </div>
              <div>
                <dt>Source URL</dt>
                <dd>
                  {previewAsset.sourceUrl ? (
                    <ExternalLink href={previewAsset.sourceUrl} label={previewAsset.sourceUrl} />
                  ) : "—"}
                </dd>
              </div>
              <div>
                <dt>Preview URL</dt>
                <dd>
                  <ExternalLink href={previewAsset.previewUrl} label={previewAsset.previewUrl} />
                </dd>
              </div>
              {previewRoute?.error ? (
                <div>
                  <dt>Route Error</dt>
                  <dd>{previewRoute.error}</dd>
                </div>
              ) : null}
            </dl>
          </aside>
        </div>
      </div>
    </div>
  );
});

export function App() {
  const initialSelectedJobId = readSelectedJobIdFromSearch(window.location.search);
  const initialSelectedAssetId = readSelectedAssetIdFromSearch(window.location.search);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [eagleFolders, setEagleFolders] = useState<EagleFolderOption[]>([]);
  const [eagleFoldersError, setEagleFoldersError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [quality, setQuality] = useState(92);
  const [dpr, setDpr] = useState<DprOption>("auto");
  const [mode, setMode] = useState<JobMode>("core-routes");
  const [maxRoutes, setMaxRoutes] = useState(12);
  const [sectionScope, setSectionScope] = useState<SectionScope>("classic");
  const [classicMaxSections, setClassicMaxSections] = useState(10);
  const [outputDir, setOutputDir] = useState("./output");

  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [totalJobs, setTotalJobs] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(initialSelectedJobId);
  const [selectedJobDetail, setSelectedJobDetail] = useState<JobDetail | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [keywordFilter, setKeywordFilter] = useState("");
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [submitting, setSubmitting] = useState(false);
  const [playwrightRuntime, setPlaywrightRuntime] = useState<PlaywrightRuntimeState | null>(null);
  const [playwrightRepairPending, setPlaywrightRepairPending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [debugPhaseFilter, setDebugPhaseFilter] = useState<"all" | SectionDebugPhase>("selected");
  const [showDebugConflictsOnly, setShowDebugConflictsOnly] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);
  const [focusSectionType, setFocusSectionType] = useState<SectionType | null>(null);
  const [focusSelector, setFocusSelector] = useState<string | null>(null);
  const [focusMessage, setFocusMessage] = useState<string | null>(null);
  const [previewAssetId, setPreviewAssetId] = useState<number | null>(null);
  const [copyFeedbackState, setCopyFeedbackState] = useState<CopyFeedbackState>(null);
  const [actionDialog, setActionDialog] = useState<ActionDialogState | null>(null);
  const [actionDialogBusy, setActionDialogBusy] = useState(false);
  const [actionToast, setActionToast] = useState<ActionToastState | null>(null);
  const [archivedCleanupPreview, setArchivedCleanupPreview] = useState<ArchivedCleanupPreview | null>(null);
  const [archivedCleanupBusy, setArchivedCleanupBusy] = useState(false);
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [importingSelected, setImportingSelected] = useState(false);
  const [retryingFailedImport, setRetryingFailedImport] = useState(false);
  const [rescanningJobId, setRescanningJobId] = useState<string | null>(null);
  const [rerunningRouteId, setRerunningRouteId] = useState<number | null>(null);
  const [archivingJobId, setArchivingJobId] = useState<string | null>(null);
  const [exitingJobIds, setExitingJobIds] = useState<Set<string>>(() => new Set());
  const [pendingQueueAction, setPendingQueueAction] = useState<{
    jobId: string;
    kind: PendingQueueActionKind;
  } | null>(null);
  const [folderSavingAssetIds, setFolderSavingAssetIds] = useState<Set<number>>(() => new Set());
  const [folderPickerState, setFolderPickerState] = useState<FolderPickerState | null>(null);
  const [folderPickerSaving, setFolderPickerSaving] = useState(false);
  const [assetCropPending, setAssetCropPending] = useState(false);
  const [recentEagleFolderIds, setRecentEagleFolderIds] = useState<string[]>(() => {
    try {
      return parseRecentFolderIds(window.localStorage.getItem(RECENT_EAGLE_FOLDER_IDS_STORAGE_KEY));
    } catch {
      return [];
    }
  });
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [manifestExpanded, setManifestExpanded] = useState(false);
  const sseRefreshTimerRef = useRef<number | null>(null);
  const selectedJobDetailRef = useRef<JobDetail | null>(null);
  const pinnedJobIdRef = useRef<string | null>(initialSelectedJobId);
  const pendingAssetIdRef = useRef<number | null>(initialSelectedAssetId);
  const archivingJobIdRef = useRef<string | null>(null);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(totalJobs / pageSize)), [pageSize, totalJobs]);
  const runningJobId = config?.queue.runningJobId ?? null;
  const playwrightNeedsRepair = Boolean(playwrightRuntime?.needsRepair);
  const playwrightRuntimePreparing = Boolean(
    playwrightRuntime === null ||
      playwrightRuntime.repairing ||
      playwrightRepairPending ||
      (playwrightNeedsRepair && !playwrightRuntime.repairFailed),
  );
  const browserActionsDisabled = playwrightRuntimePreparing || Boolean(playwrightRuntime?.repairFailed);
  const showPlaywrightBanner = Boolean(
    playwrightRuntime?.repairFailed && !playwrightRuntime.repairing && !playwrightRepairPending,
  );
  const selectedJobMode = useMemo(
    () => parseJobMode(selectedJobDetail?.job.optionsJson ?? null),
    [selectedJobDetail?.job.optionsJson],
  );
  const selectedPendingQueueActionKind = useMemo<PendingQueueActionKind | null>(() => {
    if (!selectedJobDetail || !pendingQueueAction) {
      return null;
    }
    return pendingQueueAction.jobId === selectedJobDetail.job.id ? pendingQueueAction.kind : null;
  }, [pendingQueueAction, selectedJobDetail]);
  const assetImportSummary = useMemo(
    () => summarizeAssets(selectedJobDetail?.assets ?? []),
    [selectedJobDetail?.assets],
  );
  const routeProgress = useMemo(
    () => deriveRouteProgress(selectedJobDetail?.routes ?? []),
    [selectedJobDetail?.routes],
  );
  const selectedJobIsRunning = useMemo(() => {
    if (!selectedJobDetail) {
      return false;
    }
    return runningJobId === selectedJobDetail.job.id || isActiveStatus(selectedJobDetail.job.status);
  }, [runningJobId, selectedJobDetail]);
  const selectedJobIsBusy = selectedJobIsRunning || selectedJobDetail?.job.status === "queued";
  const selectedJobStatusNote = useMemo(() => {
    if (!selectedJobDetail) {
      return null;
    }
    if (selectedJobDetail.job.cleanedAt) {
      return "Local files cleaned · history retained";
    }
    if (selectedPendingQueueActionKind === "import-selected") {
      return "Sending Eagle import request...";
    }
    if (selectedPendingQueueActionKind === "retry-import") {
      return "Sending Eagle retry request...";
    }
    const eagleImportQueueStatus = describeEagleImportQueueStatus({
      status: selectedJobDetail.job.status,
      assetCount: selectedJobDetail.assets.length,
      selectedPending: assetImportSummary.selectedPending,
      selectedFailed: assetImportSummary.selectedFailed,
      routeProgress,
    });
    if (eagleImportQueueStatus) {
      return eagleImportQueueStatus;
    }
    if (selectedJobMode === "core-routes") {
      if (routeProgress.total === 0) {
        return selectedJobIsRunning ? "Live · discovering core pages" : "Waiting for core pages";
      }
      if (selectedJobIsRunning) {
        if (routeProgress.currentRouteLabel) {
          return `Live · ${routeProgress.currentRouteLabel}`;
        }
        return `Live · ${routeProgress.done} / ${routeProgress.total}`;
      }
      const completedStatusCopy = describeCompletedCoreRoutesStatus({
        status: selectedJobDetail.job.status,
        routeProgress,
        selectedPending: assetImportSummary.selectedPending,
        selectedPendingMissingFolderCount: assetImportSummary.selectedPendingMissingFolderCount,
      });
      if (completedStatusCopy) {
        return completedStatusCopy;
      }
      return `Core page progress · ${routeProgress.done} / ${routeProgress.total}`;
    }
    if (selectedJobIsRunning) {
      return "Live · capturing page";
    }
    if (selectedJobDetail.job.status === "awaiting_confirmation") {
      if (assetImportSummary.selectedPendingMissingFolderCount > 0) {
        return `${assetImportSummary.selectedPendingMissingFolderCount} folders needed`;
      }
      return `${assetImportSummary.selectedPending} pending import`;
    }
    return null;
  }, [
    assetImportSummary.pending,
    assetImportSummary.selectedFailed,
    assetImportSummary.selectedPending,
    assetImportSummary.selectedPendingMissingFolderCount,
    routeProgress.currentRouteLabel,
    routeProgress.done,
    routeProgress.queued,
    routeProgress.running,
    routeProgress.total,
    selectedJobDetail,
    selectedJobIsRunning,
    selectedJobMode,
    selectedPendingQueueActionKind,
  ]);
  const canCancelSelectedJob = useMemo(() => {
    if (!selectedJobDetail) {
      return false;
    }
    if (selectedJobDetail.job.status === "queued") {
      return true;
    }
    return selectedJobDetail.job.status === "running" && selectedJobMode === "core-routes";
  }, [selectedJobDetail, selectedJobMode]);
  const canArchiveSelectedJob = useMemo(() => {
    if (!selectedJobDetail) {
      return false;
    }
    return (
      Boolean(selectedJobDetail.job.archivedAt) &&
      !selectedJobDetail.job.cleanedAt &&
      !isActiveStatus(selectedJobDetail.job.status) &&
      selectedJobDetail.job.status !== "queued"
    );
  }, [selectedJobDetail]);
  const canMoveSelectedJobToHistory = useMemo(() => {
    if (!selectedJobDetail) {
      return false;
    }
    return (
      !selectedJobDetail.job.cleanedAt &&
      !selectedJobIsBusy &&
      assetImportSummary.selectedPending === 0 &&
      assetImportSummary.selectedFailed === 0 &&
      assetImportSummary.imported > 0
    );
  }, [assetImportSummary, selectedJobDetail, selectedJobIsBusy]);
  const canRescanSelectedJob = useMemo(() => {
    if (!selectedJobDetail) {
      return false;
    }
    return canRescanJob(selectedJobDetail.job);
  }, [selectedJobDetail]);
  const selectedJobIsRescanning =
    selectedJobDetail !== null && rescanningJobId === selectedJobDetail.job.id;
  const selectedJobIsArchiving =
    selectedJobDetail !== null && archivingJobId === selectedJobDetail.job.id;
  const sectionDebug = useMemo(
    () => readSectionDebug(selectedJobDetail?.manifest ?? null),
    [selectedJobDetail?.manifest],
  );
  const manifestAssets = useMemo(
    () => readManifestAssets(selectedJobDetail?.manifest ?? null),
    [selectedJobDetail?.manifest],
  );
  const hasSectionDebug = sectionDebug !== null;
  const assetLookup = useMemo(
    () => buildAssetLookupIndex(selectedJobDetail?.assets ?? []),
    [selectedJobDetail?.assets],
  );
  const assetActionsDisabled =
    selectionSaving ||
    importingSelected ||
    retryingFailedImport ||
    assetCropPending ||
    selectedJobIsArchiving ||
    selectedJobIsBusy;
  const canImportSelected =
    !assetActionsDisabled &&
    assetImportSummary.selectedPending > 0 &&
    assetImportSummary.selectedPendingMissingFolderCount === 0;
  const canRetryFailedImport =
    !assetActionsDisabled &&
    assetImportSummary.selectedFailed > 0 &&
    assetImportSummary.selectedFailedMissingFolderCount === 0;
  const firstPendingMissingFolderAssetId = useMemo(() => {
    const asset = selectedJobDetail?.assets.find(
      (item) =>
        item.selectedForImport &&
        item.importStatus === "pending_confirmation" &&
        item.folderSelectionSource === "missing",
    );
    return asset?.id ?? null;
  }, [selectedJobDetail?.assets]);
  const focusedAsset = useMemo(
    () =>
      selectedAssetId !== null
        ? assetLookup.assetById.get(selectedAssetId) ?? null
        : null,
    [assetLookup, selectedAssetId],
  );
  const previewAsset = useMemo(
    () =>
      previewAssetId !== null
        ? assetLookup.assetById.get(previewAssetId) ?? null
        : null,
    [assetLookup, previewAssetId],
  );
  const folderPickerAsset = useMemo(
    () =>
      folderPickerState !== null
        ? assetLookup.assetById.get(folderPickerState.assetId) ?? null
        : null,
    [assetLookup, folderPickerState],
  );
  const folderPickerResults = useMemo<RankedEagleFolderOption[]>(
    () =>
      folderPickerAsset
        ? filterAndRankFolders(
            eagleFolders,
            folderPickerState?.query ?? "",
            folderPickerAsset.targetEagleFolderPath,
            folderPickerAsset.resolvedEagleFolderPath,
            recentEagleFolderIds,
          )
        : [],
    [eagleFolders, folderPickerAsset, folderPickerState, recentEagleFolderIds],
  );
  const previewRoute = useMemo(() => {
    if (!previewAsset || !selectedJobDetail) {
      return null;
    }
    return (
      selectedJobDetail.routes.find((route) => route.url === previewAsset.sourceUrl) ?? null
    );
  }, [previewAsset, selectedJobDetail]);
  const previewManifestAsset = useMemo(
    () => findManifestAssetForPreview(manifestAssets, previewAsset),
    [manifestAssets, previewAsset],
  );
  const previewEagleName = useMemo(
    () => resolvePreviewEagleName(previewAsset, previewManifestAsset),
    [previewAsset, previewManifestAsset],
  );
  const previewEaglePath = useMemo(
    () => resolvePreviewEaglePath(previewAsset, previewEagleName),
    [previewAsset, previewEagleName],
  );
  const previewHasDistinctEagleName = Boolean(
    previewAsset && previewEagleName && previewEagleName !== previewAsset.fileName,
  );
  const sectionDebugRows = useMemo(() => {
    if (!sectionDebug) {
      return [] as SectionDebugRow[];
    }

    const staged: Array<{ phase: SectionDebugPhase; candidates: SectionDebugCandidate[] }> = [
      { phase: "raw", candidates: sectionDebug.rawCandidates },
      { phase: "merged", candidates: sectionDebug.mergedCandidates },
      { phase: "selected", candidates: sectionDebug.selectedCandidates },
    ];

    const rows: SectionDebugRow[] = [];
    for (const stage of staged) {
      for (const candidate of stage.candidates) {
        const { top1, top2 } = pickTopTwoScores(candidate.scores);
        const faqScore = candidate.scores.faq;
        const testimonialScore = candidate.scores.testimonial;
        const isConflict =
          Math.max(faqScore, testimonialScore) >= 2 &&
          Math.abs(faqScore - testimonialScore) <= 1;

        rows.push({
          ...candidate,
          phase: stage.phase,
          isSelected: stage.phase === "selected",
          isConflict,
          isFocusMatch: false,
          top1,
          top2,
        });
      }
    }

    if (!focusSectionType) {
      return rows.filter((row) => {
        if (debugPhaseFilter !== "all" && row.phase !== debugPhaseFilter) {
          return false;
        }
        if (showDebugConflictsOnly && !row.isConflict) {
          return false;
        }
        return true;
      });
    }

    const baseFiltered = rows;

    const selectorMatches = focusSelector
      ? baseFiltered.filter((row) => row.selector === focusSelector)
      : [];
    const focusedRows = selectorMatches.length > 0
      ? selectorMatches
      : baseFiltered.filter((row) => row.sectionType === focusSectionType);

    return focusedRows.map((row) => ({
      ...row,
      isFocusMatch: focusSelector ? row.selector === focusSelector : row.sectionType === focusSectionType,
    }));
  }, [debugPhaseFilter, focusSectionType, focusSelector, sectionDebug, showDebugConflictsOnly]);

  const focusAnchorDomId = useMemo(() => {
    if (!focusSectionType || sectionDebugRows.length === 0) {
      return null;
    }
    const anchorRow =
      (focusSelector
        ? sectionDebugRows.find((row) => row.selector === focusSelector)
        : null) ?? sectionDebugRows[0];
    return `debug-row-${encodeURIComponent(debugRowKey(anchorRow))}`;
  }, [focusSectionType, focusSelector, sectionDebugRows]);
  const focusNoMatchHint = useMemo(() => {
    if (selectedAssetId === null || !focusSectionType) {
      return null;
    }
    if (sectionDebugRows.length > 0) {
      return null;
    }
    return "未找到对应候选（可能被过滤）。";
  }, [focusSectionType, sectionDebugRows.length, selectedAssetId]);

  async function loadPlaywrightRuntime(): Promise<void> {
    const result = await apiFetch<PlaywrightRuntimeState>("/api/runtime/playwright");
    setPlaywrightRuntime(result);
    if (result.healthy) {
      setErrorText((current) => (isRepairablePlaywrightMessage(current) ? null : current));
    }
  }

  async function loadConfig(): Promise<void> {
    const result = await apiFetch<AppConfig>("/api/config");
    setConfig(result);
    setQuality(result.defaults.quality);
    setDpr(result.defaults.dpr);
    setMode(result.defaults.mode);
    setMaxRoutes(result.defaults.maxRoutes);
    setSectionScope(result.defaults.sectionScope);
    setClassicMaxSections(result.defaults.classicMaxSections);
    setOutputDir(result.defaults.outputDir);
  }

  const loadEagleFolders = useCallback(async (): Promise<void> => {
    try {
      const result = await apiFetch<EagleFolderOption[]>("/api/eagle/folders");
      setEagleFolders(result);
      setEagleFoldersError(null);
    } catch (error) {
      setEagleFolders([]);
      setEagleFoldersError(error instanceof Error ? error.message : "Failed loading Eagle folders");
    }
  }, []);

  async function repairPlaywrightRuntime(): Promise<void> {
    if (playwrightRepairPending) {
      return;
    }
    setPlaywrightRepairPending(true);
    try {
      const result = await apiFetch<PlaywrightRuntimeState>("/api/runtime/playwright/repair", {
        method: "POST",
      });
      setPlaywrightRuntime(result);
      if (result.healthy) {
        setErrorText((current) => (isRepairablePlaywrightMessage(current) ? null : current));
        showToast("Screenshot engine is ready.");
        return;
      }
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Automatic screenshot setup failed");
    } finally {
      setPlaywrightRepairPending(false);
      void loadPlaywrightRuntime().catch(() => {
        // no-op
      });
    }
  }

  const selectJob = useCallback((jobId: string | null): void => {
    pinnedJobIdRef.current = jobId;
    setSelectedJobId(jobId);
  }, []);

  const loadJobs = useCallback(async (preferredSelectedJobId?: string | null): Promise<void> => {
    const params = new URLSearchParams();
    if (statusFilter) {
      params.set("status", statusFilter);
    }
    if (keywordFilter.trim()) {
      params.set("q", keywordFilter.trim());
    }
    if (archivedOnly) {
      params.set("archivedOnly", "true");
    }
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    const result = await apiFetch<{
      items: JobSummary[];
      total: number;
    }>(`/api/jobs?${params.toString()}`);
    startTransition(() => {
      setJobs((currentJobs) => (areJobSummariesEqual(currentJobs, result.items) ? currentJobs : result.items));
      setTotalJobs((currentTotal) => (currentTotal === result.total ? currentTotal : result.total));
      setSelectedJobId((currentSelectedJobId) => {
        const pinnedJobId = pinnedJobIdRef.current;
        const preferredJobId = preferredSelectedJobId ?? currentSelectedJobId;
        if (
          pinnedJobId &&
          (preferredJobId === pinnedJobId || currentSelectedJobId === pinnedJobId) &&
          !result.items.some((job) => job.id === pinnedJobId)
        ) {
          return pinnedJobId;
        }
        return getNextSelectedJobId(preferredJobId, result.items);
      });
    });
  }, [archivedOnly, keywordFilter, page, pageSize, statusFilter]);

  const loadJobDetail = useCallback(async (jobId: string): Promise<void> => {
    const detail = await apiFetch<JobDetail>(`/api/jobs/${jobId}`);
    if (isSameJobDetailVersion(selectedJobDetailRef.current, detail)) {
      return;
    }
    startTransition(() => {
      setSelectedJobDetail(detail);
    });
  }, []);

  const loadArchivedCleanupPreview = useCallback(async (): Promise<void> => {
    const preview = await apiFetch<ArchivedCleanupPreview>("/api/cleanup/archived");
    setArchivedCleanupPreview(preview);
  }, []);

  useEffect(() => {
    void loadConfig();
    void loadPlaywrightRuntime().catch((error: unknown) => {
      setErrorText(error instanceof Error ? error.message : "Failed loading runtime status");
    });
  }, []);

  useEffect(() => {
    selectedJobDetailRef.current = selectedJobDetail;
  }, [selectedJobDetail]);

  useEffect(() => {
    window.history.replaceState(
      null,
      "",
      syncSelectionToUrl(window.location.href, {
        jobId: selectedJobId,
        assetId: previewAssetId,
      }),
    );
  }, [previewAssetId, selectedJobId]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadPlaywrightRuntime().catch(() => {
        // no-op
      });
    }, PLAYWRIGHT_RUNTIME_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void loadJobs().catch((error: unknown) => {
      setErrorText(error instanceof Error ? error.message : "Failed loading jobs");
    });
  }, [archivedOnly, keywordFilter, loadJobs, page, pageSize, statusFilter]);

  useEffect(() => {
    if (!archivedOnly) {
      setArchivedCleanupPreview(null);
      return;
    }

    const refresh = (): void => {
      void loadArchivedCleanupPreview().catch(() => {
        // Keep the archived list usable if the cleanup preview is temporarily unavailable.
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [archivedOnly, loadArchivedCleanupPreview]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadJobs().catch(() => {
        // no-op
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [archivedOnly, keywordFilter, loadJobs, page, pageSize, statusFilter]);

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedJobDetail(null);
      setFolderPickerState(null);
      setFolderPickerSaving(false);
      return;
    }
    void loadEagleFolders().catch(() => {
      // no-op
    });
    void loadJobDetail(selectedJobId).catch((error: unknown) => {
      setErrorText(error instanceof Error ? error.message : "Failed loading job detail");
    });
  }, [loadEagleFolders, loadJobDetail, selectedJobId]);

  useEffect(() => {
    if (!selectedJobDetail) {
      return;
    }
    const pendingAssetId = pendingAssetIdRef.current;
    if (pendingAssetId === null) {
      return;
    }

    const targetAsset = selectedJobDetail.assets.find((asset) => asset.id === pendingAssetId) ?? null;
    pendingAssetIdRef.current = null;
    if (!targetAsset) {
      return;
    }

    setSelectedAssetId(targetAsset.id);
    setPreviewAssetId(targetAsset.id);
    setCopyFeedbackState(null);
  }, [selectedJobDetail]);

  useEffect(() => {
    if (!copyFeedbackState) {
      return;
    }
    const timer = window.setTimeout(() => setCopyFeedbackState(null), 1600);
    return () => window.clearTimeout(timer);
  }, [copyFeedbackState]);

  useEffect(() => {
    setSelectedAssetId(null);
    setFocusSectionType(null);
    setFocusSelector(null);
    setFocusMessage(null);
    setPreviewAssetId(null);
    setCopyFeedbackState(null);
    setFolderSavingAssetIds(new Set());
    setFolderPickerState(null);
    setFolderPickerSaving(false);
    setLogsExpanded(false);
    setManifestExpanded(false);
  }, [loadJobDetail, selectedJobId]);

  useEffect(() => {
    if (!folderPickerState) {
      return;
    }

    if (!folderPickerAsset) {
      setFolderPickerState(null);
      setFolderPickerSaving(false);
      return;
    }

    const nextActiveIndex = folderPickerResults.length === 0
      ? 0
      : Math.min(folderPickerState.activeIndex, folderPickerResults.length - 1);

    if (nextActiveIndex !== folderPickerState.activeIndex) {
      setFolderPickerState((current) =>
        current
          ? {
              ...current,
              activeIndex: nextActiveIndex,
            }
          : current,
      );
    }
  }, [folderPickerAsset, folderPickerResults.length, folderPickerState]);

  useEffect(() => {
    if (previewAssetId === null) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewAssetId(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewAssetId]);

  useEffect(() => {
    if (!selectedJobId) {
      return;
    }
    const eventSource = new EventSource(`/api/jobs/${selectedJobId}/events`);
    eventSource.onopen = () => {
      setLiveConnected(true);
    };
    eventSource.onerror = () => {
      setLiveConnected(false);
    };
    eventSource.onmessage = () => {
      if (sseRefreshTimerRef.current !== null) {
        return;
      }
      sseRefreshTimerRef.current = window.setTimeout(() => {
        sseRefreshTimerRef.current = null;
        void loadJobDetail(selectedJobId).catch(() => {
          // no-op
        });
      }, 220);
    };
    return () => {
      if (sseRefreshTimerRef.current !== null) {
        window.clearTimeout(sseRefreshTimerRef.current);
        sseRefreshTimerRef.current = null;
      }
      setLiveConnected(false);
      eventSource.close();
    };
  }, [loadJobDetail, selectedJobId]);

  useEffect(() => {
    if (!focusAnchorDomId) {
      return;
    }
    const element = document.getElementById(focusAnchorDomId);
    if (!element) {
      return;
    }
    element.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusAnchorDomId]);

  useEffect(() => {
    if (!actionToast) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setActionToast(null);
    }, 2600);

    return () => window.clearTimeout(timer);
  }, [actionToast]);

  const showToast = useCallback((message: string, tone: ActionToastTone = "success"): void => {
    setActionToast({ message, tone });
  }, []);

  const revealImportBlocker = useCallback((): void => {
    if (firstPendingMissingFolderAssetId === null) {
      showToast("没有找到需要处理的 Folder", "info");
      return;
    }

    setSelectedAssetId(firstPendingMissingFolderAssetId);
    showToast("已定位到需要选择 Folder 的资产", "info");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const card = document.querySelector<HTMLElement>(
          `[data-asset-id="${firstPendingMissingFolderAssetId}"]`,
        );
        const target = card?.querySelector<HTMLElement>(".asset-folder-field-missing") ?? card;
        if (!target) {
          return;
        }
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        card?.classList.add("asset-card-reveal");
        window.setTimeout(() => {
          card?.classList.remove("asset-card-reveal");
        }, 1600);
      });
    });
  }, [firstPendingMissingFolderAssetId, showToast]);

  const refreshJobSoon = useCallback((jobId: string): void => {
    const delays = [0, 300, 1200];
    for (const delay of delays) {
      window.setTimeout(() => {
        void loadJobs(jobId).catch(() => {
          // no-op
        });
        void loadJobDetail(jobId).catch(() => {
          // no-op
        });
      }, delay);
    }
  }, [loadJobDetail, loadJobs]);

  async function submitJob(): Promise<void> {
    if (!instruction.trim()) {
      setErrorText("请输入截图指令");
      return;
    }
    if (browserActionsDisabled) {
      setErrorText("Screenshot engine is preparing. Try again shortly.");
      return;
    }
    setSubmitting(true);
    setErrorText(null);
    try {
      const payload: CreateJobRequest = {
        instruction: instruction.trim(),
        quality,
        dpr,
        sectionScope,
        classicMaxSections,
        mode,
        maxRoutes,
        outputDir,
      };
      const result = await apiFetch<{ jobId: string }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setInstruction("");
      selectJob(result.jobId);
      await loadJobs(result.jobId);
      await loadJobDetail(result.jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "提交任务失败";
      setErrorText(message);
      if (isRepairablePlaywrightMessage(message)) {
        void loadPlaywrightRuntime().catch(() => {
          // no-op
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const rescanJob = useCallback(async (jobId: string): Promise<void> => {
    if (browserActionsDisabled) {
      setErrorText("Screenshot engine is preparing. Try again shortly.");
      return;
    }

    setRescanningJobId(jobId);
    setErrorText(null);
    try {
      const result = await apiFetch<{ jobId: string; mode: JobMode }>(`/api/jobs/${jobId}/rescan`, {
        method: "POST",
      });
      selectJob(result.jobId);
      if (archivedOnly) {
        setArchivedOnly(false);
        setPage(1);
      }
      await Promise.all([
        loadJobs(result.jobId),
        loadJobDetail(result.jobId),
      ]);
      showToast(`已按原配置重新扫描 ${formatJobModeLabel(result.mode)}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : "重新扫描任务失败";
      setErrorText(message);
      if (isRepairablePlaywrightMessage(message)) {
        void loadPlaywrightRuntime().catch(() => {
          // no-op
        });
      }
    } finally {
      setRescanningJobId((current) => (current === jobId ? null : current));
    }
  }, [
    archivedOnly,
    browserActionsDisabled,
    loadJobDetail,
    loadJobs,
    playwrightRuntime?.message,
    selectJob,
    showToast,
  ]);

  const retryImport = useCallback(async (jobId: string): Promise<void> => {
    setRetryingFailedImport(true);
    setPendingQueueAction({ jobId, kind: "retry-import" });
    try {
      await apiFetch(`/api/jobs/${jobId}/retry-import`, {
        method: "POST",
      });
      showToast("已加入重试队列，正在重新导入到 Eagle", "info");
      refreshJobSoon(jobId);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "提交重试导入请求失败");
      setPendingQueueAction((current) =>
        current?.jobId === jobId && current.kind === "retry-import" ? null : current,
      );
    } finally {
      setRetryingFailedImport(false);
      window.setTimeout(() => {
        setPendingQueueAction((current) =>
          current?.jobId === jobId && current.kind === "retry-import" ? null : current,
        );
      }, 1500);
    }
  }, [refreshJobSoon, showToast]);

  const saveAssetSelection = useCallback(async (jobId: string, selectedAssetIds: number[]): Promise<void> => {
    setSelectionSaving(true);
    try {
      await apiFetch(`/api/jobs/${jobId}/assets/selection`, {
        method: "PATCH",
        body: JSON.stringify({ selectedAssetIds }),
      });
      await loadJobs();
      await loadJobDetail(jobId);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "保存勾选状态失败");
    } finally {
      setSelectionSaving(false);
    }
  }, [loadJobDetail, loadJobs]);

  const saveAssetTargetFolder = useCallback(async (assetId: number, folderId: string): Promise<boolean> => {
    if (!selectedJobDetail) {
      return false;
    }

    setFolderSavingAssetIds((current) => {
      const next = new Set(current);
      next.add(assetId);
      return next;
    });
    try {
      await apiFetch(`/api/jobs/${selectedJobDetail.job.id}/assets/${assetId}/folder`, {
        method: "PATCH",
        body: JSON.stringify({ targetEagleFolderId: folderId }),
      });
      await loadJobs();
      await loadJobDetail(selectedJobDetail.job.id);
      showToast("已更新目标文件夹", "info");
      return true;
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "保存目标文件夹失败");
      return false;
    } finally {
      setFolderSavingAssetIds((current) => {
        const next = new Set(current);
        next.delete(assetId);
        return next;
      });
    }
  }, [loadJobDetail, loadJobs, selectedJobDetail, showToast]);

  const openFolderPicker = useCallback((assetId: number): void => {
    if (assetActionsDisabled) {
      return;
    }
    setFolderPickerState({
      assetId,
      query: "",
      activeIndex: 0,
    });
    setFolderPickerSaving(false);
  }, [assetActionsDisabled]);

  const closeFolderPicker = useCallback((): void => {
    setFolderPickerState(null);
    setFolderPickerSaving(false);
  }, []);

  const rememberRecentEagleFolder = useCallback((folderId: string): void => {
    setRecentEagleFolderIds((current) => {
      const next = rememberRecentFolderId(current, folderId);
      try {
        window.localStorage.setItem(RECENT_EAGLE_FOLDER_IDS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Keep recency in memory when browser storage is unavailable.
      }
      return next;
    });
  }, []);

  const updateFolderPickerQuery = useCallback((query: string): void => {
    setFolderPickerState((current) =>
      current
        ? {
            ...current,
            query,
            activeIndex: 0,
          }
        : current,
    );
  }, []);

  const updateFolderPickerActiveIndex = useCallback((activeIndex: number): void => {
    setFolderPickerState((current) =>
      current
        ? {
            ...current,
            activeIndex,
          }
        : current,
    );
  }, []);

  const selectFolderFromPicker = useCallback(async (folder: EagleFolderOption): Promise<void> => {
    if (!folderPickerAsset || folderPickerSaving) {
      return;
    }
    if (folder.id === folderPickerAsset.targetEagleFolderId) {
      rememberRecentEagleFolder(folder.id);
      closeFolderPicker();
      return;
    }

    setFolderPickerSaving(true);
    const saved = await saveAssetTargetFolder(folderPickerAsset.id, folder.id);
    if (saved) {
      rememberRecentEagleFolder(folder.id);
      closeFolderPicker();
      return;
    }
    setFolderPickerSaving(false);
  }, [
    closeFolderPicker,
    folderPickerAsset,
    folderPickerSaving,
    rememberRecentEagleFolder,
    saveAssetTargetFolder,
  ]);

  const toggleAssetSelection = useCallback(async (assetId: number, selected: boolean): Promise<void> => {
    if (!selectedJobDetail) {
      return;
    }
    const selectedAssetIds = selectedJobDetail.assets
      .filter((asset) => asset.id !== assetId && asset.selectedForImport)
      .map((asset) => asset.id);
    if (selected) {
      selectedAssetIds.push(assetId);
    }
    await saveAssetSelection(selectedJobDetail.job.id, selectedAssetIds);
  }, [saveAssetSelection, selectedJobDetail]);

  const cropAsset = useCallback(async (
    assetId: number,
    operation: AssetCropOperation,
    expectedWidth: number,
    expectedHeight: number,
  ): Promise<boolean> => {
    if (!selectedJobDetail) {
      return false;
    }
    setAssetCropPending(true);
    try {
      const result = await apiFetch<{ removedHeight: number }>(
        `/api/jobs/${selectedJobDetail.job.id}/assets/${assetId}/crop`,
        {
          method: "PATCH",
          body: JSON.stringify({ operation, expectedWidth, expectedHeight }),
        },
      );
      await Promise.all([
        loadJobs(selectedJobDetail.job.id),
        loadJobDetail(selectedJobDetail.job.id),
      ]);
      setErrorText(null);
      showToast(
        operation.type === "remove-bottom"
          ? `已裁掉底部 ${result.removedHeight.toLocaleString()} px`
          : `已删除区段 ${result.removedHeight.toLocaleString()} px`,
      );
      return true;
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "裁切图片失败");
      return false;
    } finally {
      setAssetCropPending(false);
    }
  }, [loadJobDetail, loadJobs, selectedJobDetail, showToast]);

  const restoreAssetOriginal = useCallback(async (assetId: number): Promise<boolean> => {
    if (!selectedJobDetail) {
      return false;
    }
    setAssetCropPending(true);
    try {
      await apiFetch(`/api/jobs/${selectedJobDetail.job.id}/assets/${assetId}/crop`, {
        method: "DELETE",
      });
      await Promise.all([
        loadJobs(selectedJobDetail.job.id),
        loadJobDetail(selectedJobDetail.job.id),
      ]);
      setErrorText(null);
      showToast("已恢复原图");
      return true;
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "恢复原图失败");
      return false;
    } finally {
      setAssetCropPending(false);
    }
  }, [loadJobDetail, loadJobs, selectedJobDetail, showToast]);

  const confirmRestoreAssetOriginal = useCallback((assetId: number): void => {
    setActionDialog(buildRestoreOriginalConfirmation(assetId, restoreAssetOriginal));
  }, [restoreAssetOriginal]);

  const importSelected = useCallback(async (jobId: string): Promise<void> => {
    setImportingSelected(true);
    setPendingQueueAction({ jobId, kind: "import-selected" });
    try {
      await apiFetch(`/api/jobs/${jobId}/import-selected`, {
        method: "POST",
      });
      showToast("已加入导入队列，正在导入到 Eagle", "info");
      refreshJobSoon(jobId);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "提交导入请求失败");
      setPendingQueueAction((current) =>
        current?.jobId === jobId && current.kind === "import-selected" ? null : current,
      );
    } finally {
      setImportingSelected(false);
      window.setTimeout(() => {
        setPendingQueueAction((current) =>
          current?.jobId === jobId && current.kind === "import-selected" ? null : current,
        );
      }, 1500);
    }
  }, [refreshJobSoon, showToast]);

  const executeRerunRoute = useCallback(async (
    jobId: string,
    routeId: number,
    routeStatus: RouteTargetSummary["status"],
  ): Promise<void> => {
    if (browserActionsDisabled) {
      setErrorText("Screenshot engine is preparing. Try again shortly.");
      return;
    }
    setRerunningRouteId(routeId);
    try {
      await apiFetch(`/api/jobs/${jobId}/retry-route`, {
        method: "POST",
        body: JSON.stringify({ routeId }),
      });
      await loadJobs();
      await loadJobDetail(jobId);
      setErrorText(null);
      showToast(
        routeStatus === "failed" ? "已重新加入该页面" : "已加入单页重扫队列",
        "info",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "重新扫描页面失败";
      setErrorText(message);
      if (isRepairablePlaywrightMessage(message)) {
        void loadPlaywrightRuntime().catch(() => {
          // no-op
        });
      }
    } finally {
      setRerunningRouteId((current) => (current === routeId ? null : current));
    }
  }, [browserActionsDisabled, loadJobDetail, loadJobs, showToast]);

  const rerunRoute = useCallback((jobId: string, route: RouteTargetSummary): void => {
    if (route.status === "failed") {
      void executeRerunRoute(jobId, route.id, route.status);
      return;
    }

    const routeLabel = formatCoreRouteCardLabel(route.path);
    setActionDialog({
      title: `Rescan ${routeLabel}?`,
      description:
        "A new pending screenshot will replace the current unimported capture for this page. Imported Eagle items stay untouched, and the current folder choice is preserved.",
      confirmLabel: "Rescan page",
      cancelLabel: "Keep current",
      onConfirm: () => executeRerunRoute(jobId, route.id, route.status),
    });
  }, [executeRerunRoute]);

  const executeCancelJob = useCallback(async (jobId: string): Promise<void> => {
    try {
      const result = await apiFetch<{ cancellationRequested?: boolean }>(`/api/jobs/${jobId}/cancel`, {
        method: "POST",
      });
      await loadJobs();
      await loadJobDetail(jobId);
      setErrorText(null);
      showToast(
        result.cancellationRequested
          ? "已请求取消，当前路由结束后会停止。"
          : "任务已取消",
        "info",
      );
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "取消任务失败");
    }
  }, [loadJobDetail, loadJobs, showToast]);

  const cancelJob = useCallback((jobId: string): void => {
    setActionDialog({
      title: "取消任务",
      description: "取消后当前任务不会继续执行。正在处理中的当前路由结束后会停止。",
      confirmLabel: "确认取消",
      cancelLabel: "保留任务",
      tone: "danger",
      onConfirm: () => executeCancelJob(jobId),
    });
  }, [executeCancelJob]);

  const executeArchiveJob = useCallback(async (jobId: string, archived: boolean): Promise<void> => {
    if (archivingJobIdRef.current !== null) {
      return;
    }
    archivingJobIdRef.current = jobId;
    setArchivingJobId(jobId);
    let animatedRemoval = false;
    try {
      await apiFetch<{ archivedAt: string | null }>(`/api/jobs/${jobId}/archive`, {
        method: "POST",
        body: JSON.stringify({ archived }),
      });
      const selectedJobWasArchived = selectedJobId === jobId;
      const hiddenByCurrentFilter = archived ? !archivedOnly : archivedOnly;
      if (hiddenByCurrentFilter) {
        animatedRemoval = true;
        setExitingJobIds((current) => {
          const next = new Set(current);
          next.add(jobId);
          return next;
        });
        await new Promise((resolve) => window.setTimeout(resolve, ARCHIVE_EXIT_MS));
      }
      await loadJobs(selectedJobWasArchived && !hiddenByCurrentFilter ? jobId : null);
      if (selectedJobWasArchived && hiddenByCurrentFilter) {
        setSelectedJobDetail(null);
      } else if (selectedJobWasArchived) {
        await loadJobDetail(jobId);
      }
      setErrorText(null);
      showToast(archived ? "任务已归档" : "任务已取消归档");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : archived ? "归档任务失败" : "取消归档失败");
    } finally {
      archivingJobIdRef.current = null;
      setArchivingJobId((current) => (current === jobId ? null : current));
      if (animatedRemoval) {
        setExitingJobIds((current) => {
          const next = new Set(current);
          next.delete(jobId);
          return next;
        });
      }
    }
  }, [archivedOnly, loadJobDetail, loadJobs, selectedJobId, showToast]);

  const archiveJob = useCallback((jobId: string, archived: boolean): void => {
    void executeArchiveJob(jobId, archived);
  }, [executeArchiveJob]);

  const executeCleanJobFiles = useCallback(async (jobId: string): Promise<void> => {
    let animatedRemoval = false;
    try {
      const result = await apiFetch<{ cleanedAt: string; archivedAt: string; filesDeleted: boolean }>(
        `/api/jobs/${jobId}/cleanup`,
        {
          method: "POST",
        },
      );
      const selectedJobWasCleaned = selectedJobId === jobId;
      const hiddenByCurrentFilter = !archivedOnly;
      if (hiddenByCurrentFilter) {
        animatedRemoval = true;
        setExitingJobIds((current) => {
          const next = new Set(current);
          next.add(jobId);
          return next;
        });
        await new Promise((resolve) => window.setTimeout(resolve, ARCHIVE_EXIT_MS));
      }
      await loadJobs(selectedJobWasCleaned && !hiddenByCurrentFilter ? jobId : null);
      if (selectedJobWasCleaned && hiddenByCurrentFilter) {
        setSelectedJobDetail(null);
      } else if (selectedJobWasCleaned) {
        await loadJobDetail(jobId);
      }
      setErrorText(null);
      showToast(
        result.filesDeleted
          ? "Moved to history · local files deleted"
          : "Moved to history · some local files could not be deleted",
        result.filesDeleted ? "success" : "info",
      );
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Failed to move task to history");
    } finally {
      if (animatedRemoval) {
        setExitingJobIds((current) => {
          const next = new Set(current);
          next.delete(jobId);
          return next;
        });
      }
    }
  }, [archivedOnly, loadJobDetail, loadJobs, selectedJobId, showToast]);

  const cleanJobFiles = useCallback((jobId: string): void => {
    setActionDialog({
      title: "Move this task to history?",
      description:
        "Screenshots, manifests, and crop backups will be deleted to save space. Matching records, route history, and run logs will remain available. Imported Eagle images are not affected.",
      confirmLabel: "Move to history",
      cancelLabel: "Keep in queue",
      tone: "danger",
      onConfirm: () => executeCleanJobFiles(jobId),
    });
  }, [executeCleanJobFiles]);

  const executeCleanArchivedFiles = useCallback(async (): Promise<void> => {
    setArchivedCleanupBusy(true);
    try {
      const result = await apiFetch<ArchivedCleanupResult>("/api/cleanup/archived", {
        method: "POST",
      });
      await Promise.all([
        loadJobs(selectedJobId),
        loadArchivedCleanupPreview(),
      ]);
      if (selectedJobId) {
        await loadJobDetail(selectedJobId);
      }
      setErrorText(null);
      showToast(
        result.failedCount === 0
          ? `Cleaned local files for ${result.cleanedCount} history tasks`
          : `Processed ${result.cleanedCount} history tasks · ${result.failedCount} incomplete`,
        result.failedCount === 0 ? "success" : "info",
      );
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Failed to clean history files");
    } finally {
      setArchivedCleanupBusy(false);
    }
  }, [loadArchivedCleanupPreview, loadJobDetail, loadJobs, selectedJobId, showToast]);

  const cleanArchivedFiles = useCallback((): void => {
    if (!archivedCleanupPreview || archivedCleanupPreview.jobCount === 0) {
      return;
    }
    setActionDialog({
      title: "Clean all eligible history files?",
      description:
        `This deletes ${archivedCleanupPreview.assetCount} screenshots plus manifests and crop backups from ${archivedCleanupPreview.jobCount} imported tasks. ` +
        "Matching records, route history, run logs, and Eagle images remain available.",
      confirmLabel: "Clean all files",
      cancelLabel: "Keep files",
      tone: "danger",
      onConfirm: executeCleanArchivedFiles,
    });
  }, [archivedCleanupPreview, executeCleanArchivedFiles]);

  function closeActionDialog(): void {
    if (actionDialogBusy) {
      return;
    }
    setActionDialog(null);
  }

  async function submitActionDialog(): Promise<void> {
    if (!actionDialog || actionDialogBusy) {
      return;
    }
    setActionDialogBusy(true);
    try {
      await actionDialog.onConfirm();
      setActionDialog(null);
    } finally {
      setActionDialogBusy(false);
    }
  }

  const clearFocus = useCallback((): void => {
    setSelectedAssetId(null);
    setFocusSectionType(null);
    setFocusSelector(null);
    setFocusMessage(null);
  }, []);

  const openPreview = useCallback((assetId: number): void => {
    setSelectedAssetId(assetId);
    setPreviewAssetId(assetId);
    setCopyFeedbackState(null);
  }, []);

  const closePreview = useCallback((): void => {
    setPreviewAssetId(null);
    setCopyFeedbackState(null);
  }, []);

  const focusDebugFromAsset = useCallback((asset: JobAsset): void => {
    setSelectedAssetId(asset.id);
    if (asset.kind === "fullPage") {
      setFocusSectionType(null);
      setFocusSelector(null);
      setFocusMessage("fullPage 无单一 section 对应，请查看全量 Debug。");
      return;
    }

    const sectionType = toSectionType(asset.sectionType);
    if (!sectionType || sectionType === "unknown") {
      setFocusSectionType(null);
      setFocusSelector(null);
      setFocusMessage("当前 section 资产没有可匹配的分类信息。");
      return;
    }

    setFocusSectionType(sectionType);
    const anchor = sectionDebug?.selectedCandidates
      .filter((candidate) => candidate.sectionType === sectionType)
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (anchor) {
      setFocusSelector(anchor.selector);
      setFocusMessage(null);
    } else {
      setFocusSelector(null);
      setFocusMessage("未找到对应候选（可能被过滤）。");
    }
  }, [sectionDebug]);

  async function copyText(value: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    if (!copied) {
      throw new Error("Clipboard unavailable");
    }
  }

  const copyFeedbackContext = useCallback(async (): Promise<void> => {
    if (!previewAsset || !selectedJobDetail) {
      return;
    }
    try {
      const assetUrl = previewAsset.previewUrl.startsWith("http")
        ? previewAsset.previewUrl
        : `${window.location.origin}${previewAsset.previewUrl}`;
      const payload = buildFeedbackContext({
        job: {
          id: selectedJobDetail.job.id,
          mode: selectedJobMode,
          status: selectedJobDetail.job.status,
        },
        asset: previewAsset,
        assetUrl,
        route: previewRoute,
      });
      await copyText(payload);
      setCopyFeedbackState("success");
    } catch {
      setCopyFeedbackState("error");
    }
  }, [previewAsset, previewRoute, selectedJobDetail, selectedJobMode]);

  return (
    <div className="layout">
      {showPlaywrightBanner ? (
        <div className="runtime-banner" role="alert">
          <div className="runtime-banner-copy">
            <strong className="runtime-banner-title">Screenshot setup needs attention</strong>
            <span className="runtime-banner-text">
              Automatic setup could not finish. Check your connection and retry.
            </span>
          </div>
          <div className="runtime-banner-actions">
            <button
              type="button"
              className="runtime-banner-button"
              onClick={() => void repairPlaywrightRuntime()}
              disabled={playwrightRuntime?.repairing || playwrightRepairPending}
            >
              {playwrightRuntime?.repairing || playwrightRepairPending ? "Retrying..." : "Retry setup"}
            </button>
          </div>
        </div>
      ) : null}
      <aside className="panel panel-create">
        <div className="panel-header">
          <h1>Autoscreenshot</h1>
        </div>

        <label className="field-label" htmlFor="instruction">
          Prompt
        </label>
        <textarea
          id="instruction"
          className="instruction-input"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="Open https://stripe.com and map core pages. Tags: landing, marketing"
        />

        <div className="field-grid field-grid-primary">
          <div className="field field-mode">
            <span>Mode</span>
            <div className="segmented-control" role="tablist" aria-label="Capture mode">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "single"}
                className={mode === "single" ? "segmented-control-option active" : "segmented-control-option"}
                onClick={() => setMode("single")}
              >
                Section
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "core-routes"}
                className={mode === "core-routes" ? "segmented-control-option active" : "segmented-control-option"}
                onClick={() => setMode("core-routes")}
              >
                Core Pages
              </button>
            </div>
          </div>
          {mode === "core-routes" ? (
            <label className="field">
              <span>Max pages</span>
              <input
                type="number"
                min={1}
                max={30}
                value={maxRoutes}
                onChange={(event) =>
                  setMaxRoutes(
                    Math.max(1, Math.min(30, Number(event.target.value) || 12)),
                  )
                }
              />
            </label>
          ) : null}
        </div>

        <details className="advanced-panel">
          <summary>Advanced</summary>
          <div className="field-grid field-grid-advanced">
            <label className="field">
              <span>JPG Quality</span>
              <input
                type="number"
                min={1}
                max={100}
                value={quality}
                onChange={(event) => setQuality(Math.max(1, Math.min(100, Number(event.target.value) || 92)))}
              />
            </label>
            <label className="field">
              <span>DPR</span>
              <select value={String(dpr)} onChange={(event) => {
                const value = event.target.value;
                setDpr(value === "auto" ? "auto" : value === "1" ? 1 : 2);
              }}>
                <option value="auto">auto</option>
                <option value="1">1</option>
                <option value="2">2</option>
              </select>
            </label>
            <label className="field">
              <span>Section Scope</span>
              <select value={sectionScope} onChange={(event) => setSectionScope(event.target.value as SectionScope)}>
                <option value="classic">classic</option>
                <option value="all-top-level">all-top-level</option>
                <option value="manual">manual</option>
              </select>
            </label>
            <label className="field">
              <span>Classic Max</span>
              <input
                type="number"
                min={1}
                max={20}
                value={classicMaxSections}
                onChange={(event) =>
                  setClassicMaxSections(
                    Math.max(1, Math.min(20, Number(event.target.value) || 10)),
                  )
                }
              />
            </label>
            <label className="field field-output">
              <span>Output Dir</span>
              <input value={outputDir} onChange={(event) => setOutputDir(event.target.value)} />
            </label>
          </div>
        </details>

        <Button
          variant="primary"
          size="lg"
          block
          onClick={() => void submitJob()}
          disabled={submitting || !config || browserActionsDisabled}
          loading={submitting}
          loadingLabel="Submitting..."
        >
          {playwrightRuntimePreparing ? "Preparing..." : "Run"}
        </Button>

        {errorText ? <div className="error-text">{errorText}</div> : null}

        <div className="meta-lines">
          <div>Default quality: {config?.defaults.quality ?? "..."}</div>
          <div>Default mode: {config ? formatJobModeLabel(config.defaults.mode) : "..."}</div>
          <div>Max pages: {config?.defaults.maxRoutes ?? "..."}</div>
          <div>Classic max: {config?.defaults.classicMaxSections ?? "..."}</div>
          <div>Live: {liveConnected ? "connected" : "offline"}</div>
          <div>
            Folder policy:
            {config?.eagleImportPolicy?.allowCreateFolder ? " create allowed" : " reuse only"}
          </div>
          <a className="design-system-link" href="/design-system">Design System</a>
        </div>
      </aside>

      <main className="panel panel-main">
        <div className="toolbar">
          <h2>Queue</h2>
          <div className="toolbar-actions">
            {archivedOnly ? (
              <button
                type="button"
                className="bulk-clean-button"
                disabled={
                  archivedCleanupBusy ||
                  !archivedCleanupPreview ||
                  archivedCleanupPreview.jobCount === 0
                }
                onClick={cleanArchivedFiles}
                aria-label="Clean local files for all archived jobs"
              >
                <span>
                  {archivedCleanupBusy
                    ? "Cleaning..."
                    : archivedCleanupPreview?.jobCount
                      ? "Clean all files"
                      : archivedCleanupPreview
                        ? "No files to clean"
                        : "Checking files..."}
                </span>
                {archivedCleanupPreview?.jobCount ? (
                  <span className="bulk-clean-count">{archivedCleanupPreview.jobCount}</span>
                ) : null}
              </button>
            ) : null}
            <div className="filters">
              <select value={statusFilter} onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(1);
              }}
              >
                <option value="">All</option>
                <option value="queued">queued</option>
                <option value="running">running</option>
                <option value="awaiting_confirmation">awaiting_confirmation</option>
                <option value="success">success</option>
                <option value="partial_success">partial_success</option>
                <option value="failed">failed</option>
              </select>
              <input
                placeholder="Search prompt"
                value={keywordFilter}
                onChange={(event) => {
                  setKeywordFilter(event.target.value);
                  setPage(1);
                }}
              />
              <label className={cx("filter-toggle", archivedOnly && "active")}>
                <input
                  type="checkbox"
                  checked={archivedOnly}
                  onChange={(event) => {
                    selectJob(null);
                    setSelectedJobDetail(null);
                    setArchivedOnly(event.target.checked);
                    setPage(1);
                  }}
                />
                <span className="filter-toggle-indicator" aria-hidden="true">
                  <span className="filter-toggle-knob" />
                </span>
                <span>History</span>
              </label>
            </div>
          </div>
        </div>

        <div className="split">
          <JobsListPanel
            jobs={jobs}
            selectedJobId={selectedJobId}
            runningJobId={runningJobId}
            exitingJobIds={exitingJobIds}
            archivingJobId={archivingJobId}
            totalPages={totalPages}
            page={page}
            onSelectJob={selectJob}
            onArchiveJob={archiveJob}
            onCleanJob={cleanJobFiles}
            onPreviousPage={() => setPage((prev) => Math.max(1, prev - 1))}
            onNextPage={() => setPage((prev) => Math.min(totalPages, prev + 1))}
          />

          <section className="job-detail">
            {!selectedJobDetail ? (
              <div className="empty-text">Select a job</div>
            ) : (
              <>
                <JobDetailSummary
                  detail={selectedJobDetail}
                  statusNote={selectedJobStatusNote}
                  isRunning={selectedJobIsRunning}
                  canCancel={canCancelSelectedJob}
                  canArchive={canArchiveSelectedJob}
                  archiving={selectedJobIsArchiving}
                  canClean={canMoveSelectedJobToHistory}
                  canRescan={canRescanSelectedJob}
                  rescanDisabled={browserActionsDisabled || selectedJobIsArchiving}
                  rescanning={selectedJobIsRescanning}
                  mode={selectedJobMode}
                  assetImportSummary={assetImportSummary}
                  canImportSelected={canImportSelected}
                  canRetryFailedImport={canRetryFailedImport}
                  importingSelected={importingSelected}
                  retryingFailedImport={retryingFailedImport}
                  onCancel={cancelJob}
                  onArchive={archiveJob}
                  onClean={cleanJobFiles}
                  onRescan={rescanJob}
                  onImportSelected={importSelected}
                  onRevealImportBlocker={revealImportBlocker}
                  onRetryImport={retryImport}
                />
                {eagleFoldersError ? <div className="detail-inline-warning">{eagleFoldersError}</div> : null}

                {!selectedJobDetail.job.cleanedAt && selectedJobMode === "core-routes" ? (
                  <div className={cx("progress-panel", selectedJobIsRunning && "progress-panel-live")}>
                    <div className="progress-panel-top">
                      <div>
                        <div className="progress-kicker">Core Page Progress</div>
                        <strong>
                          {routeProgress.done} / {routeProgress.total || 0}
                        </strong>
                        <p>
                          {routeProgress.total === 0
                            ? selectedJobIsRunning
                              ? "Discovering core pages..."
                              : "No core pages yet"
                            : routeProgress.currentRouteLabel
                              ? `Current page: ${routeProgress.currentRouteLabel}`
                              : routeProgress.done === routeProgress.total
                                ? "All pages processed"
                                : `${routeProgress.queued} queued`}
                        </p>
                      </div>
                      <div className="progress-counters">
                        <span>running {routeProgress.running}</span>
                        <span>queued {routeProgress.queued}</span>
                        <span>failed {routeProgress.failed}</span>
                      </div>
                    </div>
                    <div
                      className={cx("progress-track", selectedJobIsRunning && "progress-track-live")}
                      aria-label={`Core page progress ${routeProgress.done} / ${routeProgress.total || 0}`}
                    >
                      <div
                        className="progress-fill"
                        style={{ width: `${Math.max(0, Math.min(100, routeProgress.completionRatio * 100))}%` }}
                      />
                    </div>
                  </div>
                ) : null}

                {selectedJobDetail.job.cleanedAt ? (
                  <div className="cleaned-history-state">
                    <strong>Local files cleaned</strong>
                    <p>
                      The lightweight job record remains available for history and browser-plugin duplicate checks.
                    </p>
                  </div>
                ) : selectedJobMode === "core-routes" ? (
                  <CoreRoutesPanel
                    detail={selectedJobDetail}
                    assetLookup={assetLookup}
                    selectedAssetId={selectedAssetId}
                    assetActionsDisabled={assetActionsDisabled}
                    folderSavingAssetIds={folderSavingAssetIds}
                    hasSectionDebug={hasSectionDebug}
                    onToggleAssetSelection={toggleAssetSelection}
                    onOpenFolderPicker={openFolderPicker}
                    onOpenPreview={openPreview}
                    onFocusDebug={focusDebugFromAsset}
                    onRerunRoute={rerunRoute}
                    rerunningRouteId={rerunningRouteId}
                    browserActionsDisabled={browserActionsDisabled}
                  />
                ) : (
                  <AssetGridPanel
                    assets={selectedJobDetail.assets}
                    selectedAssetId={selectedAssetId}
                    assetActionsDisabled={assetActionsDisabled}
                    folderSavingAssetIds={folderSavingAssetIds}
                    hasSectionDebug={hasSectionDebug}
                    onToggleAssetSelection={toggleAssetSelection}
                    onOpenFolderPicker={openFolderPicker}
                    onOpenPreview={openPreview}
                    onFocusDebug={focusDebugFromAsset}
                  />
                )}

                {sectionDebug ? (
                  <details className="section-debug-panel" open>
                    <summary>Section Debug</summary>
                    <>
                      <div className="section-debug-toolbar">
                        <label>
                          Stage
                          <select
                            value={debugPhaseFilter}
                            onChange={(event) =>
                              setDebugPhaseFilter(event.target.value as "all" | SectionDebugPhase)
                            }
                          >
                            <option value="all">all</option>
                            <option value="raw">raw</option>
                            <option value="merged">merged</option>
                            <option value="selected">selected</option>
                          </select>
                        </label>
                        <label className="debug-checkbox">
                          <input
                            type="checkbox"
                            checked={showDebugConflictsOnly}
                            onChange={(event) => setShowDebugConflictsOnly(event.target.checked)}
                          />
                          FAQ/testimonial conflicts only
                        </label>
                        <span>
                          scope: {sectionDebug.scope} · viewportH: {sectionDebug.viewportHeight} · rows:{" "}
                          {sectionDebugRows.length}
                        </span>
                        {focusedAsset ? (
                          <span className="focus-source">
                            asset: {focusedAsset.kind} · {focusedAsset.sectionType ?? "fullPage"} ·{" "}
                            {focusedAsset.fileName}
                          </span>
                        ) : null}
                        {focusSectionType ? (
                          <span className="focus-source">Focus mode: showing raw, merged, and selected stages</span>
                        ) : null}
                        {selectedAssetId !== null ? (
                          <button type="button" className="focus-clear-btn" onClick={clearFocus}>
                            Clear focus
                          </button>
                        ) : null}
                      </div>

                      {focusMessage || focusNoMatchHint ? (
                        <div className="focus-hint">{focusMessage ?? focusNoMatchHint}</div>
                      ) : null}

                      <div className="section-debug-table-wrap">
                        <table className="section-debug-table">
                          <thead>
                            <tr>
                              <th>stage</th>
                              <th>selector</th>
                              <th>bbox(x,y,w,h)</th>
                              <th>top1</th>
                              <th>top2</th>
                              <th>final</th>
                              <th>signals</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sectionDebugRows.map((row) => (
                              <tr
                                key={`${row.phase}:${row.selector}:${row.bbox.y}:${row.bbox.height}`}
                                id={`debug-row-${encodeURIComponent(debugRowKey(row))}`}
                                className={[
                                  row.isSelected ? "row-selected" : "",
                                  row.isConflict ? "row-conflict" : "",
                                  row.isFocusMatch ? "row-focus-match" : "",
                                ]
                                  .filter(Boolean)
                                  .join(" ")}
                              >
                                <td>{row.phase}</td>
                                <td>
                                  <div className="debug-selector">{row.selector}</div>
                                  <div className="debug-preview">{row.textPreview || "—"}</div>
                                </td>
                                <td>
                                  ({row.bbox.x}, {row.bbox.y}, {row.bbox.width}, {row.bbox.height})
                                </td>
                                <td>
                                  {row.top1.label}:{row.top1.score}
                                </td>
                                <td>{row.top2 ? `${row.top2.label}:${row.top2.score}` : "—"}</td>
                                <td>
                                  {row.sectionType} ({row.confidence.toFixed(2)})
                                </td>
                                <td className="debug-signals">
                                  {row.signals.length > 0
                                    ? row.signals
                                        .map((signal) => `${signal.rule}(${signal.weight >= 0 ? "+" : ""}${signal.weight})`)
                                        .join(", ")
                                    : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  </details>
                ) : null}

                <div className={cx("detail-columns", selectedJobDetail.job.cleanedAt && "detail-columns-history")}>
                  <LogsPanel
                    logs={selectedJobDetail.logs}
                    expanded={logsExpanded}
                    onToggle={() => setLogsExpanded((current) => !current)}
                  />
                  {!selectedJobDetail.job.cleanedAt ? (
                    <ManifestPanel
                      manifest={selectedJobDetail.manifest}
                      expanded={manifestExpanded}
                      onToggle={() => setManifestExpanded((current) => !current)}
                    />
                  ) : null}
                </div>
              </>
            )}
          </section>
        </div>
      </main>

      {previewAsset ? (
        <PreviewModal
          previewAsset={previewAsset}
          previewRoute={previewRoute}
          previewEagleName={previewEagleName}
          previewEaglePath={previewEaglePath}
          previewHasDistinctEagleName={previewHasDistinctEagleName}
          selectedJobDetail={selectedJobDetail}
          selectedJobMode={selectedJobMode}
          assetActionsDisabled={assetActionsDisabled}
          hasSectionDebug={hasSectionDebug}
          copyFeedbackState={copyFeedbackState}
          onClose={closePreview}
          onToggleSelection={toggleAssetSelection}
          onCopyFeedbackContext={copyFeedbackContext}
          onCrop={cropAsset}
          onRestoreOriginal={confirmRestoreAssetOriginal}
          onFocusAndClose={(asset) => {
            focusDebugFromAsset(asset);
            closePreview();
          }}
        />
      ) : null}
      <FolderPickerDialog
        open={folderPickerAsset !== null}
        assetLabel={folderPickerAsset?.label ?? ""}
        assetKind={folderPickerAsset?.kind ?? "section"}
        assetSectionType={folderPickerAsset?.sectionType ?? null}
        currentPath={folderPickerAsset?.targetEagleFolderPath ?? null}
        suggestedPath={folderPickerAsset?.resolvedEagleFolderPath ?? null}
        query={folderPickerState?.query ?? ""}
        results={folderPickerResults}
        activeIndex={folderPickerState?.activeIndex ?? 0}
        pending={folderPickerSaving}
        onClose={closeFolderPicker}
        onQueryChange={updateFolderPickerQuery}
        onActiveIndexChange={updateFolderPickerActiveIndex}
        onSelectFolder={(folder) => void selectFolderFromPicker(folder)}
      />
      <ActionDialog
        open={Boolean(actionDialog)}
        title={actionDialog?.title ?? ""}
        description={actionDialog?.description ?? ""}
        confirmLabel={actionDialog?.confirmLabel ?? ""}
        cancelLabel={actionDialog?.cancelLabel}
        tone={actionDialog?.tone}
        pending={actionDialogBusy}
        onCancel={closeActionDialog}
        onConfirm={() => void submitActionDialog()}
      />
      <ActionToast
        open={Boolean(actionToast)}
        message={actionToast?.message ?? ""}
        tone={actionToast?.tone}
      />
    </div>
  );
}
