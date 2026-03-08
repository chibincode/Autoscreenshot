import { useEffect, useMemo, useState } from "react";
import {
  buildFeedbackContext,
  canFocusDebugAsset,
  findAssetForRoute,
  getCoreRoutePreviewState,
} from "./asset-feedback";
import { deriveRouteProgress, isActiveStatus } from "./job-progress";
import { getNextSelectedJobId } from "./job-selection";
import { canRetryRoute } from "./route-retry";

type JobStatus =
  | "queued"
  | "running"
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

interface SectionScoreBreakdown {
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
  importSuccessCount: number;
  importFailedCount: number;
  sourceUrl: string | null;
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
  importOk: boolean;
  importError: string | null;
  eagleId: string | null;
  eagleFolderId?: string | null;
  eagleFolderPath?: string | null;
  previewUrl: string;
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
    error: string | null;
    outputDir: string | null;
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

function statusClass(status: string): string {
  return `status status-${status}`;
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
  const folderPath = asset.eagleFolderPath?.trim();
  return folderPath ? `${folderPath}/${eagleName}` : eagleName;
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

function StatusBadge({
  status,
  emphasis = false,
}: {
  status: JobStatus | RouteTargetSummary["status"];
  emphasis?: boolean;
}) {
  const active = isActiveStatus(status);
  return (
    <span className={cx(statusClass(status), active && "status-live", emphasis && "status-emphasis")}>
      {active ? (
        <span className="status-indicator" aria-hidden="true">
          <span className="status-indicator-ring" />
          <span className="status-indicator-dot" />
        </span>
      ) : null}
      <span>{status}</span>
    </span>
  );
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [instruction, setInstruction] = useState("");
  const [quality, setQuality] = useState(92);
  const [dpr, setDpr] = useState<DprOption>("auto");
  const [mode, setMode] = useState<JobMode>("single");
  const [maxRoutes, setMaxRoutes] = useState(12);
  const [sectionScope, setSectionScope] = useState<SectionScope>("classic");
  const [classicMaxSections, setClassicMaxSections] = useState(10);
  const [outputDir, setOutputDir] = useState("./output");

  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [totalJobs, setTotalJobs] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJobDetail, setSelectedJobDetail] = useState<JobDetail | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [keywordFilter, setKeywordFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [submitting, setSubmitting] = useState(false);
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

  const totalPages = useMemo(() => Math.max(1, Math.ceil(totalJobs / pageSize)), [pageSize, totalJobs]);
  const selectedJobMode = useMemo(
    () => parseJobMode(selectedJobDetail?.job.optionsJson ?? null),
    [selectedJobDetail?.job.optionsJson],
  );
  const routeProgress = useMemo(
    () => deriveRouteProgress(selectedJobDetail?.routes ?? []),
    [selectedJobDetail?.routes],
  );
  const selectedJobIsRunning = useMemo(() => {
    if (!selectedJobDetail) {
      return false;
    }
    return config?.queue.runningJobId === selectedJobDetail.job.id || isActiveStatus(selectedJobDetail.job.status);
  }, [config?.queue.runningJobId, selectedJobDetail]);
  const selectedJobStatusNote = useMemo(() => {
    if (!selectedJobDetail) {
      return null;
    }
    if (selectedJobMode === "core-routes") {
      if (routeProgress.total === 0) {
        return selectedJobIsRunning ? "实时执行中 · 正在发现核心路由" : "等待核心路由列表";
      }
      if (selectedJobIsRunning) {
        if (routeProgress.currentRouteLabel) {
          return `实时执行中 · 当前路由 ${routeProgress.currentRouteLabel}`;
        }
        return `实时执行中 · 进度 ${routeProgress.done} / ${routeProgress.total}`;
      }
      return `核心路由进度 ${routeProgress.done} / ${routeProgress.total}`;
    }
    if (selectedJobIsRunning) {
      return "实时执行中 · 正在采集页面与导入资源";
    }
    return null;
  }, [routeProgress.currentRouteLabel, routeProgress.done, routeProgress.total, selectedJobDetail, selectedJobIsRunning, selectedJobMode]);
  const canCancelSelectedJob = useMemo(() => {
    if (!selectedJobDetail) {
      return false;
    }
    if (selectedJobDetail.job.status === "queued") {
      return true;
    }
    return selectedJobDetail.job.status === "running" && selectedJobMode === "core-routes";
  }, [selectedJobDetail, selectedJobMode]);
  const sectionDebug = useMemo(
    () => readSectionDebug(selectedJobDetail?.manifest ?? null),
    [selectedJobDetail],
  );
  const manifestAssets = useMemo(
    () => readManifestAssets(selectedJobDetail?.manifest ?? null),
    [selectedJobDetail?.manifest],
  );
  const hasSectionDebug = sectionDebug !== null;
  const routeAssetEntries = useMemo(
    () =>
      (selectedJobDetail?.routes ?? []).map((route) => ({
        route,
        asset: findAssetForRoute(route, selectedJobDetail?.assets ?? []),
      })),
    [selectedJobDetail?.assets, selectedJobDetail?.routes],
  );
  const focusedAsset = useMemo(
    () =>
      selectedAssetId !== null
        ? selectedJobDetail?.assets.find((asset) => asset.id === selectedAssetId) ?? null
        : null,
    [selectedAssetId, selectedJobDetail],
  );
  const previewAsset = useMemo(
    () =>
      previewAssetId !== null
        ? selectedJobDetail?.assets.find((asset) => asset.id === previewAssetId) ?? null
        : null,
    [previewAssetId, selectedJobDetail],
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

  async function loadJobs(preferredSelectedJobId?: string | null): Promise<void> {
    const params = new URLSearchParams();
    if (statusFilter) {
      params.set("status", statusFilter);
    }
    if (keywordFilter.trim()) {
      params.set("q", keywordFilter.trim());
    }
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    const result = await apiFetch<{
      items: JobSummary[];
      total: number;
    }>(`/api/jobs?${params.toString()}`);
    setJobs(result.items);
    setTotalJobs(result.total);
    setSelectedJobId((currentSelectedJobId) =>
      getNextSelectedJobId(preferredSelectedJobId ?? currentSelectedJobId, result.items),
    );
  }

  async function loadJobDetail(jobId: string): Promise<void> {
    const detail = await apiFetch<JobDetail>(`/api/jobs/${jobId}`);
    setSelectedJobDetail(detail);
  }

  useEffect(() => {
    void loadConfig();
  }, []);

  useEffect(() => {
    void loadJobs().catch((error: unknown) => {
      setErrorText(error instanceof Error ? error.message : "Failed loading jobs");
    });
  }, [page, pageSize, statusFilter, keywordFilter]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadJobs().catch(() => {
        // no-op
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [page, pageSize, statusFilter, keywordFilter]);

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedJobDetail(null);
      return;
    }
    void loadJobDetail(selectedJobId).catch((error: unknown) => {
      setErrorText(error instanceof Error ? error.message : "Failed loading job detail");
    });
  }, [selectedJobId]);

  useEffect(() => {
    setSelectedAssetId(null);
    setFocusSectionType(null);
    setFocusSelector(null);
    setFocusMessage(null);
    setPreviewAssetId(null);
    setCopyFeedbackState(null);
  }, [selectedJobId]);

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
      void loadJobs().catch(() => {
        // no-op
      });
      void loadJobDetail(selectedJobId).catch(() => {
        // no-op
      });
    };
    return () => {
      setLiveConnected(false);
      eventSource.close();
    };
  }, [selectedJobId, page, pageSize, statusFilter, keywordFilter]);

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

  async function submitJob(): Promise<void> {
    if (!instruction.trim()) {
      setErrorText("请输入截图指令");
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
      setSelectedJobId(result.jobId);
      await loadJobs(result.jobId);
      await loadJobDetail(result.jobId);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "提交任务失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function retryImport(jobId: string): Promise<void> {
    try {
      await apiFetch(`/api/jobs/${jobId}/retry-import`, {
        method: "POST",
      });
      await loadJobs();
      await loadJobDetail(jobId);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "重试导入失败");
    }
  }

  async function retryRoute(jobId: string, routeId: number): Promise<void> {
    try {
      await apiFetch(`/api/jobs/${jobId}/retry-route`, {
        method: "POST",
        body: JSON.stringify({ routeId }),
      });
      await loadJobs();
      await loadJobDetail(jobId);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "重试路由失败");
    }
  }

  async function cancelJob(jobId: string): Promise<void> {
    const firstConfirm = window.confirm("确定要取消这个任务吗？");
    if (!firstConfirm) {
      return;
    }
    const secondConfirm = window.confirm("再次确认：取消后当前任务不会继续执行。");
    if (!secondConfirm) {
      return;
    }

    try {
      const result = await apiFetch<{ cancellationRequested?: boolean }>(`/api/jobs/${jobId}/cancel`, {
        method: "POST",
      });
      await loadJobs();
      await loadJobDetail(jobId);
      setErrorText(
        result.cancellationRequested
          ? "已请求取消，当前路由结束后会停止。"
          : null,
      );
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "取消任务失败");
    }
  }

  function clearFocus(): void {
    setSelectedAssetId(null);
    setFocusSectionType(null);
    setFocusSelector(null);
    setFocusMessage(null);
  }

  function openPreview(assetId: number): void {
    setPreviewAssetId(assetId);
    setCopyFeedbackState(null);
  }

  function closePreview(): void {
    setPreviewAssetId(null);
    setCopyFeedbackState(null);
  }

  function focusDebugFromAsset(asset: JobAsset): void {
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
  }

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

  async function copyFeedbackContext(): Promise<void> {
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
  }

  return (
    <div className="layout">
      <aside className="panel panel-create">
        <div className="panel-header">
          <h1>Autoscreenshot</h1>
          <p>本地 Web 控制台 · Eagle 导入</p>
        </div>

        <label className="field-label" htmlFor="instruction">
          截图指令
        </label>
        <textarea
          id="instruction"
          className="instruction-input"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="例如：打开 https://stripe.com，抓 full page 和 hero/testimonial，标签: landing,marketing"
        />

        <div className="field-grid">
          <label className="field">
            <span>JPG 质量</span>
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
                single
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "core-routes"}
                className={mode === "core-routes" ? "segmented-control-option active" : "segmented-control-option"}
                onClick={() => setMode("core-routes")}
              >
                core-routes
              </button>
            </div>
          </div>
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
          {mode === "core-routes" ? (
            <label className="field">
              <span>Max Routes</span>
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

        <label className="field">
          <span>输出目录</span>
          <input value={outputDir} onChange={(event) => setOutputDir(event.target.value)} />
        </label>

        <button className="submit-btn" type="button" onClick={() => void submitJob()} disabled={submitting || !config}>
          {submitting ? "提交中..." : "提交任务"}
        </button>

        {errorText ? <div className="error-text">{errorText}</div> : null}

        <div className="meta-lines">
          <div>默认值：quality {config?.defaults.quality ?? "..."}</div>
          <div>默认模式：{config?.defaults.mode ?? "single"}</div>
          <div>max routes：{config?.defaults.maxRoutes ?? "..."}</div>
          <div>classic max：{config?.defaults.classicMaxSections ?? "..."}</div>
          <div>实时连接：{liveConnected ? "已连接" : "未连接"}</div>
          <div>
            Eagle 文件夹策略：
            {config?.eagleImportPolicy?.allowCreateFolder ? "允许创建" : "仅复用已有文件夹"}
          </div>
        </div>
      </aside>

      <main className="panel panel-main">
        <div className="toolbar">
          <h2>任务队列</h2>
          <div className="filters">
            <select value={statusFilter} onChange={(event) => {
              setStatusFilter(event.target.value);
              setPage(1);
            }}>
              <option value="">全部状态</option>
              <option value="queued">queued</option>
              <option value="running">running</option>
              <option value="success">success</option>
              <option value="partial_success">partial_success</option>
              <option value="failed">failed</option>
            </select>
            <input
              placeholder="搜索指令关键词"
              value={keywordFilter}
              onChange={(event) => {
                setKeywordFilter(event.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>

        <div className="split">
          <section className="jobs-list">
            {jobs.map((job) => (
              <button
                key={job.id}
                type="button"
                className={cx(
                  "job-card",
                  selectedJobId === job.id && "selected",
                  (config?.queue.runningJobId === job.id || isActiveStatus(job.status)) && "job-card-live",
                )}
                onClick={() => setSelectedJobId(job.id)}
              >
                <div className="job-top">
                  <StatusBadge status={job.status} />
                  <span className="job-time">{formatDate(job.createdAt)}</span>
                </div>
                <div className="job-title">{job.sourceUrl ?? "未解析 URL"}</div>
                <div className="job-instruction">{job.instruction}</div>
                <div className="job-stats">
                  <span>资产 {job.assetCount}</span>
                  <span>导入成功 {job.importSuccessCount}</span>
                  <span>导入失败 {job.importFailedCount}</span>
                </div>
                {config?.queue.runningJobId === job.id ? (
                  <div className="job-live-note">队列执行中</div>
                ) : null}
              </button>
            ))}
            {jobs.length === 0 ? <div className="empty-text">暂无任务</div> : null}

            <div className="pagination">
              <button type="button" disabled={page <= 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
                上一页
              </button>
              <span>
                第 {page} / {totalPages} 页
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              >
                下一页
              </button>
            </div>
          </section>

          <section className="job-detail">
            {!selectedJobDetail ? (
              <div className="empty-text">选择一个任务查看详情</div>
            ) : (
              <>
                <div className="detail-header">
                  <div>
                    <h3>{selectedJobDetail.job.id}</h3>
                    <p>{selectedJobDetail.job.instruction}</p>
                  </div>
                  <div className={cx("detail-status", selectedJobIsRunning && "detail-status-live")}>
                    <StatusBadge status={selectedJobDetail.job.status} emphasis />
                    {selectedJobStatusNote ? <span className="detail-status-note">{selectedJobStatusNote}</span> : null}
                  </div>
                </div>

                <div className="detail-actions">
                  {canCancelSelectedJob ? (
                    <button
                      type="button"
                      className="danger-button"
                      onClick={() => void cancelJob(selectedJobDetail.job.id)}
                    >
                      取消任务
                    </button>
                  ) : null}
                  <button type="button" onClick={() => void retryImport(selectedJobDetail.job.id)}>
                    重试导入失败项
                  </button>
                  <span>开始: {formatDate(selectedJobDetail.job.startedAt)}</span>
                  <span>完成: {formatDate(selectedJobDetail.job.finishedAt)}</span>
                </div>

                {selectedJobMode === "core-routes" ? (
                  <div className={cx("progress-panel", selectedJobIsRunning && "progress-panel-live")}>
                    <div className="progress-panel-top">
                      <div>
                        <div className="progress-kicker">核心路由进度</div>
                        <strong>
                          进度 {routeProgress.done} / {routeProgress.total || 0}
                        </strong>
                        <p>
                          {routeProgress.total === 0
                            ? selectedJobIsRunning
                              ? "正在发现核心路由..."
                              : "尚未生成核心路由"
                            : routeProgress.currentRouteLabel
                              ? `当前路由 ${routeProgress.currentRouteLabel}`
                              : routeProgress.done === routeProgress.total
                                ? "全部路由已处理"
                                : `等待中 ${routeProgress.queued} 条`}
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
                      aria-label={`核心路由进度 ${routeProgress.done} / ${routeProgress.total || 0}`}
                    >
                      <div
                        className="progress-fill"
                        style={{ width: `${Math.max(0, Math.min(100, routeProgress.completionRatio * 100))}%` }}
                      />
                    </div>
                  </div>
                ) : null}

                {selectedJobMode === "core-routes" ? (
                  selectedJobDetail.routes.length > 0 ? (
                    <div className="route-list-panel">
                      <h4>核心路由卡片</h4>
                      <div className="core-route-card-list">
                        {routeAssetEntries.map(({ route, asset }) => {
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
                                <div className="core-route-card-path" title={route.url}>
                                  {route.path}
                                </div>
                                <div className="core-route-card-actions">
                                  {asset && canFocusDebugAsset(asset, hasSectionDebug) ? (
                                    <button type="button" onClick={() => focusDebugFromAsset(asset)}>
                                      Debug 聚焦
                                    </button>
                                  ) : null}
                                  {canRetryRoute(selectedJobDetail.job.status, route.status) ? (
                                    <button
                                      type="button"
                                      onClick={() => void retryRoute(selectedJobDetail.job.id, route.id)}
                                    >
                                      重试该路由
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                              <div className="core-route-card-preview">
                                {asset ? (
                                  <button
                                    type="button"
                                    className="asset-preview-trigger core-route-preview-trigger"
                                    onClick={() => openPreview(asset.id)}
                                  >
                                    <img src={asset.previewUrl} alt={asset.fileName} loading="lazy" />
                                  </button>
                                ) : (
                                  <div className={cx("route-preview-placeholder", `route-preview-${previewState}`)}>
                                    <strong className="route-preview-title">
                                      {previewState === "pending"
                                        ? "等待截图"
                                        : previewState === "failed"
                                          ? "截图失败"
                                          : "暂无封面"}
                                    </strong>
                                    <span className="route-preview-copy">
                                      {previewState === "pending"
                                        ? "仍在执行或排队"
                                        : previewState === "failed"
                                          ? "没有成功产物"
                                          : "无匹配封面"}
                                    </span>
                                  </div>
                                )}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  ) : null
                ) : (
                  <div className="assets-grid">
                    {selectedJobDetail.assets.map((asset) => (
                      <article
                        key={asset.id}
                        className={`asset-card ${selectedAssetId === asset.id ? "asset-card-focused" : ""}`}
                      >
                        <button
                          type="button"
                          className="asset-preview-trigger"
                          onClick={() => openPreview(asset.id)}
                        >
                          <img src={asset.previewUrl} alt={asset.fileName} loading="lazy" />
                        </button>
                        <div className="asset-meta">
                          <strong>{asset.label}</strong>
                          <span>{asset.kind}{asset.sectionType ? ` · ${asset.sectionType}` : ""}</span>
                          <span>q{asset.quality} · dpr{asset.dpr}</span>
                          <span>{asset.importOk ? "Eagle 导入成功" : `导入失败: ${asset.importError ?? "未知错误"}`}</span>
                        </div>
                        <div className="asset-card-actions">
                          <button type="button" onClick={() => openPreview(asset.id)}>
                            打开预览
                          </button>
                          {canFocusDebugAsset(asset, hasSectionDebug) ? (
                            <button type="button" onClick={() => focusDebugFromAsset(asset)}>
                              Debug 聚焦
                            </button>
                          ) : null}
                        </div>
                      </article>
                    ))}
                    {selectedJobDetail.assets.length === 0 ? <div className="empty-text">暂无产物</div> : null}
                  </div>
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
                  <div className="log-box">
                    <h4>运行日志</h4>
                    <div className="log-scroll">
                      {selectedJobDetail.logs.map((log) => (
                        <div key={log.id} className={`log-line log-${log.level}`}>
                          <span>{new Date(log.ts).toLocaleTimeString()}</span>
                          <span>{log.level.toUpperCase()}</span>
                          <span>{log.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="manifest-box">
                    <h4>Manifest</h4>
                    <pre>{JSON.stringify(selectedJobDetail.manifest, null, 2)}</pre>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </main>

      {previewAsset ? (
        <div className="asset-preview-modal-backdrop" onClick={closePreview}>
          <div className="asset-preview-modal" onClick={(event) => event.stopPropagation()}>
            <div className="asset-preview-modal-header">
              <div>
                <strong>{previewEagleName ?? previewAsset.fileName}</strong>
                <span>
                  {previewRoute ? `${previewRoute.path} · ${previewRoute.status}` : previewAsset.label}
                </span>
              </div>
              <button type="button" className="asset-preview-close" onClick={closePreview}>
                关闭
              </button>
            </div>
            <div className="asset-preview-modal-body">
              <div className="asset-preview-image-wrap">
                <img src={previewAsset.previewUrl} alt={previewAsset.fileName} className="asset-preview-image" />
              </div>
              <aside className="asset-preview-sidebar">
                <div className="asset-preview-actions">
                  <button type="button" onClick={() => void copyFeedbackContext()}>
                    Copy Feedback Context
                  </button>
                  {canFocusDebugAsset(previewAsset, hasSectionDebug) ? (
                    <button
                      type="button"
                      onClick={() => {
                        focusDebugFromAsset(previewAsset);
                        closePreview();
                      }}
                    >
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
                    <dd>{previewAsset.eagleFolderPath ?? "Root"}</dd>
                  </div>
                  <div>
                    <dt>Eagle Name</dt>
                    <dd>{previewEagleName ?? "—"}</dd>
                  </div>
                  {previewHasDistinctEagleName ? (
                    <div>
                      <dt>File Name</dt>
                      <dd>{previewAsset.fileName}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Job</dt>
                    <dd>
                      {selectedJobDetail.job.id} · {selectedJobMode} · {selectedJobDetail.job.status}
                    </dd>
                  </div>
                  <div>
                    <dt>Route</dt>
                    <dd>{previewRoute ? `${previewRoute.path} · ${previewRoute.url}` : "—"}</dd>
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
                      {previewAsset.importOk
                        ? `成功${previewAsset.eagleId ? ` · Eagle ${previewAsset.eagleId}` : ""}`
                        : `失败 · ${previewAsset.importError ?? "未知错误"}`}
                    </dd>
                  </div>
                  <div>
                    <dt>Preview URL</dt>
                    <dd>{previewAsset.previewUrl}</dd>
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
      ) : null}
    </div>
  );
}
