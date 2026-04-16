import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";
import { buildConsoleAssetUrl, buildConsoleJobUrl } from "./links";
import { DEFAULT_SERVICE_BASE_URL, readServiceBaseUrl, writeServiceBaseUrl } from "./storage";

type JobMode = "single" | "core-routes";
type DprOption = "auto" | 1 | 2;
type SectionScope = "classic" | "all-top-level" | "manual";
type JobStatus =
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "success"
  | "partial_success"
  | "failed"
  | "cancelled";

interface PluginContextResponse {
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
    recentJobs: Array<{ id: string; status: JobStatus; createdAt: string; mode: JobMode; assetCount: number }>;
  };
  eagle: {
    available: boolean;
    hitCount: number;
    recentItems: Array<{
      id: string;
      name: string;
      url: string;
      mtime: number | null;
      jobId?: string;
      assetId?: number;
      clickable: boolean;
    }>;
  };
  defaults: {
    quality: number;
    dpr: DprOption;
    sectionScope: SectionScope;
    classicMaxSections: number;
    mode: JobMode;
    maxRoutes: number;
    outputDir: string;
  };
}

declare const chrome: {
  tabs?: {
    query: (
      queryInfo: { active: boolean; currentWindow: boolean },
      callback: (tabs: Array<{ id?: number; url?: string }>) => void,
    ) => void;
    create?: (createProperties: { url: string }) => void;
  };
};

function isHttpUrl(value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function readActiveTabUrl(): Promise<string | null> {
  if (!chrome.tabs) {
    return null;
  }

  return new Promise((resolve) => {
    chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
      const candidate = tabs[0]?.url;
      resolve(isHttpUrl(candidate) ? candidate : null);
    });
  });
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function formatDate(input: string | number | null): string {
  if (input === null) {
    return "—";
  }
  return new Date(input).toLocaleString();
}

function openInTab(url: string): void {
  if (chrome.tabs?.create) {
    chrome.tabs.create({ url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function statusBadgeLabel(status: JobStatus): string {
  if (status === "partial_success") {
    return "partial";
  }
  if (status === "awaiting_confirmation") {
    return "awaiting";
  }
  return status;
}

function App(): JSX.Element {
  const [serviceBaseUrl, setServiceBaseUrl] = useState(DEFAULT_SERVICE_BASE_URL);
  const [serviceDraft, setServiceDraft] = useState(DEFAULT_SERVICE_BASE_URL);
  const [activeTabUrl, setActiveTabUrl] = useState<string | null>(null);
  const [context, setContext] = useState<PluginContextResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submittingMode, setSubmittingMode] = useState<JobMode | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [jobResult, setJobResult] = useState<{ jobId: string; status: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const storedServiceBaseUrl = await readServiceBaseUrl();
      const tabUrl = await readActiveTabUrl();
      setServiceBaseUrl(storedServiceBaseUrl);
      setServiceDraft(storedServiceBaseUrl);
      setActiveTabUrl(tabUrl);

      if (!tabUrl) {
        setErrorText("当前页面不是普通网页地址，问题属于输入不支持。");
        setLoading(false);
        return;
      }

      try {
        const nextContext = await apiFetch<PluginContextResponse>(
          `${storedServiceBaseUrl}/api/plugin/context?url=${encodeURIComponent(tabUrl)}`,
        );
        setContext(nextContext);
      } catch (error) {
        setErrorText(
          error instanceof Error
            ? `本地服务没连上，问题属于本地服务不可用。${error.message}`
            : "本地服务没连上，问题属于本地服务不可用。",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const warnings = useMemo(() => {
    const nextWarnings: string[] = [];
    if (context && context.history.hitCount > 0) {
      nextWarnings.push(`本地历史已命中 ${context.history.hitCount} 次，重复截图只会提示，不会阻止继续执行。`);
    }
    if (context && context.eagle.hitCount > 0) {
      nextWarnings.push(`Eagle 已命中 ${context.eagle.hitCount} 条同 URL 记录，重复截图只会提示，不会阻止继续执行。`);
    }
    if (context && !context.eagle.available) {
      nextWarnings.push("截图仍可继续，但 Eagle 查重暂时不可用，问题属于本地依赖不可用。");
    }
    return nextWarnings;
  }, [context]);

  async function saveServiceUrl(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextValue = serviceDraft.trim() || DEFAULT_SERVICE_BASE_URL;
    setServiceBaseUrl(nextValue);
    await writeServiceBaseUrl(nextValue);
    window.location.reload();
  }

  async function submitJob(mode: JobMode): Promise<void> {
    if (!context || !activeTabUrl) {
      return;
    }

    setSubmittingMode(mode);
    setErrorText(null);
    setJobResult(null);

    const instruction =
      mode === "core-routes"
        ? `open ${activeTabUrl} and map core routes`
        : `open ${activeTabUrl} only section`;

    try {
      const result = await apiFetch<{ jobId: string; status: string }>(`${serviceBaseUrl}/api/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          instruction,
          quality: context.defaults.quality,
          dpr: context.defaults.dpr,
          sectionScope: mode === "single" ? "classic" : context.defaults.sectionScope,
          classicMaxSections: context.defaults.classicMaxSections,
          mode,
          maxRoutes: context.defaults.maxRoutes,
          outputDir: context.defaults.outputDir,
        }),
      });
      setJobResult(result);
    } catch (error) {
      setErrorText(
        error instanceof Error
          ? `任务创建失败，问题属于本地任务接口不可用。${error.message}`
          : "任务创建失败，问题属于本地任务接口不可用。",
      );
    } finally {
      setSubmittingMode(null);
    }
  }

  return (
    <div className="popup-shell">
      <div className="popup-card">
        <div className="popup-header">
          <div>
            <h1 className="popup-title">Autoscreenshot</h1>
            <p className="popup-subtitle">一键抓当前页面的 sections 或核心路由，并先做 URL 去重校验。</p>
          </div>
          <span className={`status-pill ${errorText ? "status-pill-warn" : "status-pill-ok"}`}>
            {errorText ? "Needs attention" : "Ready"}
          </span>
        </div>

        <div className="popup-section">
          <div className="meta-grid">
            <div className="meta-label">Current URL</div>
            <div className="meta-value">{activeTabUrl ?? "Not a normal page"}</div>
            <div className="meta-label">Normalized</div>
            <div className="meta-value">{context?.normalizedUrl ?? "—"}</div>
          </div>
        </div>

        <div className="popup-section">
          <form className="service-form" onSubmit={(event) => void saveServiceUrl(event)}>
            <label className="meta-label" htmlFor="serviceBaseUrl">Local service</label>
            <input
              id="serviceBaseUrl"
              className="service-input"
              value={serviceDraft}
              onChange={(event) => setServiceDraft(event.target.value)}
            />
            <button className="ghost-button" type="submit">Save and reload</button>
            <div className="service-note">默认本地服务地址是 `http://127.0.0.1:8787`。</div>
          </form>
        </div>

        <div className="popup-section">
          <ul className="runtime-list">
            <li className="runtime-row">
              <strong>Autoscreenshot</strong>
              <span>{errorText ? "Unavailable" : "Reachable"}</span>
            </li>
            <li className="runtime-row">
              <strong>Playwright</strong>
              <span>{context?.runtime.playwrightHealthy ? "Healthy" : "Needs repair"}</span>
            </li>
            <li className="runtime-row">
              <strong>Eagle</strong>
              <span>{context?.runtime.eagleHealthy ? "Healthy" : "Unavailable"}</span>
            </li>
          </ul>
        </div>

        {context?.runtime.messages.length ? (
          <div className="popup-section">
            <ul className="warning-list">
              {context.runtime.messages.map((message) => (
                <li className="warning-item" key={message}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {warnings.length ? (
          <div className="popup-section">
            <ul className="warning-list">
              {warnings.map((warning) => (
                <li className="warning-item" key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="popup-section">
          <div className="meta-label">History hits</div>
          {context?.history.recentJobs.length ? (
            <ul className="hit-list">
              {context.history.recentJobs.map((job) => (
                <li key={job.id}>
                  <button
                    type="button"
                    className="hit-card"
                    onClick={() => openInTab(buildConsoleJobUrl(serviceBaseUrl, job.id))}
                  >
                    <div className="hit-title-row">
                      <div className="hit-title">{job.id}</div>
                      <span className="hit-badge">{statusBadgeLabel(job.status)}</span>
                    </div>
                    <div className="hit-meta">{job.mode} · {formatDate(job.createdAt)} · {job.assetCount} assets</div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state">本地历史里还没有同 URL 命中。</div>
          )}
        </div>

        <div className="popup-section">
          <div className="meta-label">Eagle hits</div>
          {context?.eagle.recentItems.length ? (
            <ul className="hit-list">
              {context.eagle.recentItems.map((item) => {
                const disabled = !item.clickable || !item.jobId || typeof item.assetId !== "number";
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`hit-card ${disabled ? "hit-card-disabled" : ""}`}
                      disabled={disabled}
                      onClick={() => {
                        if (disabled || !item.jobId || typeof item.assetId !== "number") {
                          return;
                        }
                        openInTab(buildConsoleAssetUrl(serviceBaseUrl, { jobId: item.jobId, assetId: item.assetId }));
                      }}
                    >
                      <div className="hit-title-row">
                        <div className="hit-title">{item.name}</div>
                        <span className="hit-badge">{disabled ? "view only" : "linked"}</span>
                      </div>
                      <div className="hit-meta">{item.url} · {formatDate(item.mtime)}</div>
                      {disabled ? (
                        <div className="click-hint">仅本地导入记录可跳转。</div>
                      ) : (
                        <div className="click-hint">点击后会打开 Web 控制台并定位到对应资产预览。</div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="empty-state">Eagle 里还没有同 URL 命中。</div>
          )}
        </div>

        <div className="actions">
          <button
            className="primary-button"
            type="button"
            disabled={loading || Boolean(errorText) || !context || submittingMode !== null}
            onClick={() => void submitJob("single")}
          >
            {submittingMode === "single" ? "Submitting..." : "Sections"}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={loading || Boolean(errorText) || !context || submittingMode !== null}
            onClick={() => void submitJob("core-routes")}
          >
            {submittingMode === "core-routes" ? "Submitting..." : "Core Routes"}
          </button>
        </div>

        {jobResult ? (
          <div className="popup-section">
            <div className="job-result">
              <strong>{jobResult.jobId}</strong> · {jobResult.status}
            </div>
            <button
              className="ghost-button"
              type="button"
              onClick={() => openInTab(buildConsoleJobUrl(serviceBaseUrl, jobResult.jobId))}
            >
              Open Console
            </button>
          </div>
        ) : null}

        {errorText ? (
          <div className="popup-section">
            <div className="warning-item">{errorText}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Popup root container missing");
}

createRoot(root).render(<App />);
