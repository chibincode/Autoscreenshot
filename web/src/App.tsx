import { useEffect, useMemo, useState } from "react";

type JobStatus =
  | "queued"
  | "running"
  | "success"
  | "partial_success"
  | "failed"
  | "cancelled";

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
  quality: number;
  dpr: number;
  capturedAt: string;
  importOk: boolean;
  importError: string | null;
  eagleId: string | null;
  previewUrl: string;
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
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    outputDir: string | null;
  };
  assets: JobAsset[];
  logs: JobLog[];
  manifest: ManifestView | null;
}

interface AppConfig {
  defaults: {
    quality: number;
    dpr: DprOption;
    sectionScope: SectionScope;
    classicMaxSections: number;
    outputDir: string;
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
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
    ...init,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function statusClass(status: JobStatus): string {
  return `status status-${status}`;
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

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [instruction, setInstruction] = useState("");
  const [quality, setQuality] = useState(92);
  const [dpr, setDpr] = useState<DprOption>("auto");
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

  const totalPages = useMemo(() => Math.max(1, Math.ceil(totalJobs / pageSize)), [pageSize, totalJobs]);
  const sectionDebug = useMemo(
    () => readSectionDebug(selectedJobDetail?.manifest ?? null),
    [selectedJobDetail],
  );
  const focusedAsset = useMemo(
    () =>
      selectedAssetId !== null
        ? selectedJobDetail?.assets.find((asset) => asset.id === selectedAssetId) ?? null
        : null,
    [selectedAssetId, selectedJobDetail],
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
    setSectionScope(result.defaults.sectionScope);
    setClassicMaxSections(result.defaults.classicMaxSections);
    setOutputDir(result.defaults.outputDir);
  }

  async function loadJobs(): Promise<void> {
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
    if (!selectedJobId && result.items.length > 0) {
      setSelectedJobId(result.items[0].id);
    }
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
  }, [selectedJobId]);

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
        outputDir,
      };
      const result = await apiFetch<{ jobId: string }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setInstruction("");
      setSelectedJobId(result.jobId);
      await loadJobs();
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

  function clearFocus(): void {
    setSelectedAssetId(null);
    setFocusSectionType(null);
    setFocusSelector(null);
    setFocusMessage(null);
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
                className={`job-card ${selectedJobId === job.id ? "selected" : ""}`}
                onClick={() => setSelectedJobId(job.id)}
              >
                <div className="job-top">
                  <span className={statusClass(job.status)}>{job.status}</span>
                  <span className="job-time">{formatDate(job.createdAt)}</span>
                </div>
                <div className="job-title">{job.sourceUrl ?? "未解析 URL"}</div>
                <div className="job-instruction">{job.instruction}</div>
                <div className="job-stats">
                  <span>资产 {job.assetCount}</span>
                  <span>导入成功 {job.importSuccessCount}</span>
                  <span>导入失败 {job.importFailedCount}</span>
                </div>
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
                  <div className={statusClass(selectedJobDetail.job.status)}>
                    {selectedJobDetail.job.status}
                  </div>
                </div>

                <div className="detail-actions">
                  <button type="button" onClick={() => void retryImport(selectedJobDetail.job.id)}>
                    重试导入失败项
                  </button>
                  <span>开始: {formatDate(selectedJobDetail.job.startedAt)}</span>
                  <span>完成: {formatDate(selectedJobDetail.job.finishedAt)}</span>
                </div>

                <div className="assets-grid">
                  {selectedJobDetail.assets.map((asset) => (
                    <article
                      key={asset.id}
                      className={`asset-card ${selectedAssetId === asset.id ? "asset-card-focused" : ""}`}
                      onClick={() => focusDebugFromAsset(asset)}
                    >
                      <img src={asset.previewUrl} alt={asset.fileName} loading="lazy" />
                      <div className="asset-meta">
                        <strong>{asset.label}</strong>
                        <span>{asset.kind}{asset.sectionType ? ` · ${asset.sectionType}` : ""}</span>
                        <span>q{asset.quality} · dpr{asset.dpr}</span>
                        <span>{asset.importOk ? "Eagle 导入成功" : `导入失败: ${asset.importError ?? "未知错误"}`}</span>
                      </div>
                    </article>
                  ))}
                  {selectedJobDetail.assets.length === 0 ? <div className="empty-text">暂无产物</div> : null}
                </div>

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
    </div>
  );
}
