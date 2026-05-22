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
} from "react";
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
import {
  filterAndRankFolders,
  formatFolderNameForCard,
  formatFolderPathForCard,
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
import { canRetryRoute } from "./route-retry";
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
  archivedAt: string | null;
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
  sourceUrl: string | null;
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
    archivedAt: string | null;
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
      leftItem.archivedAt !== rightItem.archivedAt
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
  totalPages,
  page,
  onSelectJob,
  onArchiveJob,
  onPreviousPage,
  onNextPage,
}: {
  jobs: JobSummary[];
  selectedJobId: string | null;
  runningJobId: string | null;
  exitingJobIds: ReadonlySet<string>;
  totalPages: number;
  page: number;
  onSelectJob: (jobId: string) => void;
  onArchiveJob: (jobId: string, archived: boolean) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
}) {
  return (
    <section className="jobs-list">
      {jobs.map((job) => {
        const jobIsLive = runningJobId === job.id || isActiveStatus(job.status);
        const showQuickArchive = canQuickArchiveJob(job);
        const nextArchivedState = !Boolean(job.archivedAt);
        const isExiting = exitingJobIds.has(job.id);
        return (
          <div key={job.id} className={cx("job-card-shell", isExiting && "job-card-shell-exiting")}>
            <article
              className={cx(
                "job-card",
                selectedJobId === job.id && "selected",
                jobIsLive && "job-card-live",
                showQuickArchive && "job-card-has-action",
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
                  {job.archivedAt ? <span className="job-archived-pill">archived</span> : null}
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
                {job.archivedAt ? <div className="job-archived-note">Archived · {formatDate(job.archivedAt)}</div> : null}
              </div>
              {runningJobId === job.id ? <div className="job-live-note">Running</div> : null}
              {showQuickArchive ? (
                <button
                  type="button"
                  className="job-card-quick-action"
                  onClick={(event) => {
                    event.stopPropagation();
                    onArchiveJob(job.id, nextArchivedState);
                  }}
                  aria-label={nextArchivedState ? "Archive job" : "Unarchive job"}
                >
                  {nextArchivedState ? "Archive" : "Unarchive"}
                </button>
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
  assetImportSummary,
  canImportSelected,
  canRetryFailedImport,
  importingSelected,
  retryingFailedImport,
  onCancel,
  onArchive,
  onImportSelected,
  onRevealImportBlocker,
  onRetryImport,
}: {
  detail: JobDetail;
  statusNote: string | null;
  isRunning: boolean;
  canCancel: boolean;
  canArchive: boolean;
  assetImportSummary: ReturnType<typeof summarizeAssets>;
  canImportSelected: boolean;
  canRetryFailedImport: boolean;
  importingSelected: boolean;
  retryingFailedImport: boolean;
  onCancel: (jobId: string) => void;
  onArchive: (jobId: string, archived: boolean) => void;
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
              detail.job.status === "partial_success"
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
        {canCancel ? (
          <button type="button" className="danger-button" onClick={() => onCancel(detail.job.id)}>
            Cancel
          </button>
        ) : null}
        {canArchive ? (
          <button type="button" onClick={() => onArchive(detail.job.id, !Boolean(detail.job.archivedAt))}>
            {detail.job.archivedAt ? "Unarchive" : "Archive"}
          </button>
        ) : null}
        <button
          type="button"
          className={cx("primary-button", importBlockedByFolders && "primary-button-blocked")}
          disabled={!canImportSelected && !importBlockedByFolders}
          data-blocked={importBlockedByFolders ? "true" : undefined}
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
          {importingSelected ? "Queueing..." : importBlockedByFolders ? "Fix folders" : "Import selected"}
        </button>
        {assetImportSummary.failed > 0 ? (
          <button type="button" disabled={!canRetryFailedImport} onClick={() => void onRetryImport(detail.job.id)}>
            {retryingFailedImport ? "Queueing retry..." : "Retry failed"}
          </button>
        ) : null}
        <span>Pending: {assetImportSummary.pending}</span>
        {assetImportSummary.selectedPendingMissingFolderCount > 0 ? (
          <span>Pending folders: {assetImportSummary.selectedPendingMissingFolderCount}</span>
        ) : null}
        {assetImportSummary.selectedFailedMissingFolderCount > 0 ? (
          <span>Retry folders: {assetImportSummary.selectedFailedMissingFolderCount}</span>
        ) : null}
        <span>Imported: {assetImportSummary.imported}</span>
        <span>Failed: {assetImportSummary.failed}</span>
        <span>Started: {formatDate(detail.job.startedAt)}</span>
        <span>Finished: {formatDate(detail.job.finishedAt)}</span>
        {detail.job.archivedAt ? <span>Archived: {formatDate(detail.job.archivedAt)}</span> : null}
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
  onRetryRoute,
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
  onRetryRoute: (jobId: string, routeId: number) => void | Promise<void>;
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
                  label={route.path}
                  className="core-route-card-path"
                  title={route.url}
                />
                <div className="core-route-card-actions">
                  {asset && canFocusDebugAsset(asset, hasSectionDebug) ? (
                    <button type="button" onClick={() => onFocusDebug(asset)}>
                      Focus Debug
                    </button>
                  ) : null}
                  {canRetryRoute(detail.job.status, route.status) ? (
                    <button
                      type="button"
                      disabled={browserActionsDisabled}
                      onClick={() => void onRetryRoute(detail.job.id, route.id)}
                    >
                      Retry page
                    </button>
                  ) : null}
                </div>
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
  copyFeedbackState: string | null;
  onClose: () => void;
  onToggleSelection: (assetId: number, checked: boolean) => void | Promise<void>;
  onCopyFeedbackContext: () => void | Promise<void>;
  onFocusAndClose: (asset: JobAsset) => void;
}) {
  return (
    <div className="asset-preview-modal-backdrop" onClick={onClose}>
      <div className="asset-preview-modal" onClick={(event) => event.stopPropagation()}>
        <div className="asset-preview-modal-header">
          <div>
            <strong>{previewEagleName ?? previewAsset.fileName}</strong>
            <span>{previewRoute ? `${previewRoute.path} · ${previewRoute.status}` : previewAsset.label}</span>
          </div>
          <button type="button" className="asset-preview-close" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="asset-preview-modal-body">
          <div className="asset-preview-image-wrap">
            <img
              src={previewAsset.previewUrl}
              alt={previewAsset.fileName}
              className="asset-preview-image"
              decoding="async"
            />
          </div>
          <aside className="asset-preview-sidebar">
            <div className="asset-preview-actions">
              <label className="asset-select-control asset-select-control-inline">
                <input
                  type="checkbox"
                  checked={previewAsset.selectedForImport}
                  disabled={assetActionsDisabled}
                  onChange={(event) => void onToggleSelection(previewAsset.id, event.target.checked)}
                />
                <span>导入到 Eagle</span>
              </label>
              <button type="button" onClick={() => void onCopyFeedbackContext()}>
                Copy Feedback Context
              </button>
              {canFocusDebugAsset(previewAsset, hasSectionDebug) ? (
                <button type="button" onClick={() => onFocusAndClose(previewAsset)}>
                  Debug 聚焦
                </button>
              ) : null}
            </div>
            {copyFeedbackState ? <div className="copy-feedback-state">{copyFeedbackState}</div> : null}
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
  const [copyFeedbackState, setCopyFeedbackState] = useState<string | null>(null);
  const [actionDialog, setActionDialog] = useState<ActionDialogState | null>(null);
  const [actionDialogBusy, setActionDialogBusy] = useState(false);
  const [actionToast, setActionToast] = useState<ActionToastState | null>(null);
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [importingSelected, setImportingSelected] = useState(false);
  const [retryingFailedImport, setRetryingFailedImport] = useState(false);
  const [exitingJobIds, setExitingJobIds] = useState<Set<string>>(() => new Set());
  const [pendingQueueAction, setPendingQueueAction] = useState<{
    jobId: string;
    kind: PendingQueueActionKind;
  } | null>(null);
  const [folderSavingAssetIds, setFolderSavingAssetIds] = useState<Set<number>>(() => new Set());
  const [folderPickerState, setFolderPickerState] = useState<FolderPickerState | null>(null);
  const [folderPickerSaving, setFolderPickerSaving] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [manifestExpanded, setManifestExpanded] = useState(false);
  const sseRefreshTimerRef = useRef<number | null>(null);
  const selectedJobDetailRef = useRef<JobDetail | null>(null);
  const pinnedJobIdRef = useRef<string | null>(initialSelectedJobId);
  const pendingAssetIdRef = useRef<number | null>(initialSelectedAssetId);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(totalJobs / pageSize)), [pageSize, totalJobs]);
  const runningJobId = config?.queue.runningJobId ?? null;
  const playwrightNeedsRepair = Boolean(playwrightRuntime?.needsRepair);
  const browserActionsDisabled = playwrightNeedsRepair || playwrightRuntime?.repairing || playwrightRepairPending;
  const showPlaywrightBanner = Boolean(
    playwrightRuntime && (playwrightRuntime.needsRepair || playwrightRuntime.repairing),
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
    return !isActiveStatus(selectedJobDetail.job.status) && selectedJobDetail.job.status !== "queued";
  }, [selectedJobDetail]);
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
  const assetActionsDisabled = selectionSaving || importingSelected || retryingFailedImport || selectedJobIsBusy;
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
          )
        : [],
    [eagleFolders, folderPickerAsset, folderPickerState],
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
        showToast("Chromium 已修复，可以继续提交任务。");
        return;
      }
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "修复 Chromium 失败");
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
      setErrorText(playwrightRuntime?.message ?? "Chromium 截图浏览器缺失，请先修复。");
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
      closeFolderPicker();
      return;
    }

    setFolderPickerSaving(true);
    const saved = await saveAssetTargetFolder(folderPickerAsset.id, folder.id);
    if (saved) {
      closeFolderPicker();
      return;
    }
    setFolderPickerSaving(false);
  }, [closeFolderPicker, folderPickerAsset, folderPickerSaving, saveAssetTargetFolder]);

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

  const retryRoute = useCallback(async (jobId: string, routeId: number): Promise<void> => {
    if (browserActionsDisabled) {
      setErrorText(playwrightRuntime?.message ?? "Chromium 截图浏览器缺失，请先修复。");
      return;
    }
    try {
      await apiFetch(`/api/jobs/${jobId}/retry-route`, {
        method: "POST",
        body: JSON.stringify({ routeId }),
      });
      await loadJobs();
      await loadJobDetail(jobId);
      showToast("已重新加入该路由", "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : "重试路由失败";
      setErrorText(message);
      if (isRepairablePlaywrightMessage(message)) {
        void loadPlaywrightRuntime().catch(() => {
          // no-op
        });
      }
    }
  }, [browserActionsDisabled, loadJobDetail, loadJobs, playwrightRuntime?.message, showToast]);

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
      setCopyFeedbackState("反馈上下文已复制");
    } catch (error) {
      setCopyFeedbackState(error instanceof Error ? error.message : "复制失败");
    }
  }, [previewAsset, previewRoute, selectedJobDetail, selectedJobMode]);

  return (
    <div className="layout">
      {showPlaywrightBanner ? (
        <div className="runtime-banner" role="status" aria-live="polite">
          <div className="runtime-banner-copy">
            <strong className="runtime-banner-title">
              {playwrightRuntime?.repairing || playwrightRepairPending
                ? "正在修复本机 Chromium 截图运行环境"
                : "当前 Chromium 截图浏览器缺失"}
            </strong>
            <span className="runtime-banner-text">
              {playwrightRuntime?.repairing || playwrightRepairPending
                ? "请稍候，修复完成后这里会自动恢复。"
                : "这不是网站失败，新的截图任务会直接失败。"}
            </span>
            {playwrightRuntime?.detail ? (
              <span className="runtime-banner-detail">{playwrightRuntime.detail}</span>
            ) : null}
          </div>
          <div className="runtime-banner-actions">
            <button
              type="button"
              className="runtime-banner-button"
              onClick={() => void repairPlaywrightRuntime()}
              disabled={playwrightRuntime?.repairing || playwrightRepairPending}
            >
              {playwrightRuntime?.repairing || playwrightRepairPending ? "修复中..." : "修复 Chromium"}
            </button>
            <span className="runtime-banner-meta">目标：{playwrightRuntime?.target ?? "chromium"}</span>
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

        <button
          className="submit-btn"
          type="button"
          onClick={() => void submitJob()}
          disabled={submitting || !config || browserActionsDisabled}
        >
          {submitting ? "Submitting..." : "Run"}
        </button>

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
        </div>
      </aside>

      <main className="panel panel-main">
        <div className="toolbar">
          <h2>Queue</h2>
          <div className="filters">
            <select value={statusFilter} onChange={(event) => {
              setStatusFilter(event.target.value);
              setPage(1);
            }}>
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
                  setArchivedOnly(event.target.checked);
                  setPage(1);
                }}
              />
              <span className="filter-toggle-indicator" aria-hidden="true">
                <span className="filter-toggle-knob" />
              </span>
              <span>Archived</span>
            </label>
          </div>
        </div>

        <div className="split">
          <JobsListPanel
            jobs={jobs}
            selectedJobId={selectedJobId}
            runningJobId={runningJobId}
            exitingJobIds={exitingJobIds}
            totalPages={totalPages}
            page={page}
            onSelectJob={selectJob}
            onArchiveJob={archiveJob}
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
                  assetImportSummary={assetImportSummary}
                  canImportSelected={canImportSelected}
                  canRetryFailedImport={canRetryFailedImport}
                  importingSelected={importingSelected}
                  retryingFailedImport={retryingFailedImport}
                  onCancel={cancelJob}
                  onArchive={archiveJob}
                  onImportSelected={importSelected}
                  onRevealImportBlocker={revealImportBlocker}
                  onRetryImport={retryImport}
                />
                {eagleFoldersError ? <div className="detail-inline-warning">{eagleFoldersError}</div> : null}

                {selectedJobMode === "core-routes" ? (
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

                {selectedJobMode === "core-routes" ? (
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
                    onRetryRoute={retryRoute}
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

                <details className="section-debug-panel" open>
                  <summary>Section Debug</summary>
                  {!sectionDebug ? (
                    <div className="empty-text">当前任务没有 sectionDebug 数据</div>
                  ) : (
                    <>
                      <div className="section-debug-toolbar">
                        <label>
                          阶段
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
                          仅显示 faq/testimonial 冲突
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
                          <span className="focus-source">聚焦模式：已展示 raw/merged/selected 全阶段</span>
                        ) : null}
                        {selectedAssetId !== null ? (
                          <button type="button" className="focus-clear-btn" onClick={clearFocus}>
                            清除聚焦
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
                  )}
                </details>

                <div className="detail-columns">
                  <LogsPanel
                    logs={selectedJobDetail.logs}
                    expanded={logsExpanded}
                    onToggle={() => setLogsExpanded((current) => !current)}
                  />
                  <ManifestPanel
                    manifest={selectedJobDetail.manifest}
                    expanded={manifestExpanded}
                    onToggle={() => setManifestExpanded((current) => !current)}
                  />
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
