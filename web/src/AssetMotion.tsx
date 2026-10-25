import { useEffect, useState } from "react";
import { AlertCircle, Clapperboard, Download, Loader2, Play, RotateCcw, Square, Video } from "lucide-react";
import "./asset-motion.css";

export interface MotionSummary {
  status?: string;
  stage?: string;
  progress?: number | null;
  error?: string;
  videoUrl?: string;
  posterUrl?: string;
  result?: { duration: number; width: number; height: number; warnings: string[] };
  options?: { mode: string; selector: string; duration: number; from: number; to: number };
}
type Anchor = { selector: string; bbox: { y: number; height: number }; viewport: { width: number; height: number } };
const isActive = (motion: MotionSummary) => ["submitting", "queued", "running"].includes(motion.status ?? "");

export function useAssetMotion(assetId: number, initial?: MotionSummary) {
  const [motion, setMotion] = useState<MotionSummary>(initial ?? {});
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(`/api/assets/${assetId}/motion`, { signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw Error(payload.error || "Unable to load motion recording.");
        if (disposed) return;
        setMotion(payload.motion); setAnchor(payload.anchor); setError("");
        if (isActive(payload.motion)) timer = setTimeout(poll, 3000);
      } catch (error) {
        if (!disposed) { setError(error instanceof Error ? error.message : "Unable to reach Motion Capture."); timer = setTimeout(poll, 8000); }
      } finally { if (!disposed) setLoading(false); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [assetId, refresh]);
  const request = async (body?: unknown, cancel = false) => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/assets/${assetId}/motion${cancel ? "/cancel" : ""}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
      });
      const payload = await response.json();
      if (!response.ok) throw Error(payload.error || "Recording request failed.");
      setMotion(payload.motion); setRefresh(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : "Recording request failed."); setRefresh(value => value + 1); }
    finally { setBusy(false); }
  };
  return { motion, anchor, error, loading, busy, active: isActive(motion), request };
}
export type AssetMotionController = ReturnType<typeof useAssetMotion>;

export function MotionViewer({ controller, poster }: { controller: AssetMotionController; poster: string }) {
  const { motion, active } = controller;
  return <div className="motion-viewer">
    {motion.videoUrl ? <video key={motion.videoUrl} src={motion.videoUrl} poster={motion.posterUrl} controls playsInline preload="metadata" aria-label="Recorded section motion" /> :
      <div className="motion-preview-placeholder">
        <img src={poster} alt="Section selected for recording" />
        <span>{active ? <Loader2 className="motion-spinner" size={22} /> : <Clapperboard size={24} />}
          {active ? "Recording motion" : "No recording yet"}</span>
      </div>}
  </div>;
}

export function MotionControls({ controller, disabled }: { controller: AssetMotionController; disabled: boolean }) {
  const { motion, anchor, error, loading, busy, active, request } = controller;
  const [mode, setMode] = useState("scroll");
  const [selector, setSelector] = useState("");
  const [duration, setDuration] = useState(10);
  const [from, setFrom] = useState(0), [to, setTo] = useState(100);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setSelector(motion.options?.selector ?? anchor?.selector ?? "");
    setMode(motion.options?.mode ?? (anchor ? "scroll" : "manual"));
    setDuration(motion.options?.duration ?? 10);
    setFrom(motion.options?.from ?? 0); setTo(motion.options?.to ?? 100);
  }, [anchor?.selector]);
  const showSettings = !motion.videoUrl || editing;
  return <section className="motion-controls" aria-label="Motion recording settings">
    <div className="motion-controls-heading"><Video size={16} /><strong>Motion Capture</strong>
      {motion.result ? <span>{motion.result.duration}s · 60 fps</span> : null}</div>
    {active || busy ? <div className="motion-progress" role="status">
      <div><Loader2 size={15} className="motion-spinner" />{busy && !active ? "Starting recording" : motion.status === "queued" ? "Queued" : motion.stage === "encoding" ? "Encoding" : motion.stage === "verifying" ? "Verifying" : ["reading", "loading"].includes(motion.stage ?? "") ? "Preparing page" : "Recording"}
        {!busy && typeof motion.progress === "number" ? <span>{Math.round(motion.progress * 100)}%</span> : null}</div>
      <progress max="1" value={busy ? undefined : motion.progress ?? undefined} />
      <button type="button" disabled={busy} onClick={() => void request(undefined, true)}><Square size={13} /> Cancel recording</button>
    </div> : showSettings ? <>
      <label>Capture mode<select value={mode} disabled={loading || busy} onChange={event => setMode(event.target.value)}>
        <option value="scroll">Scroll through section</option><option value="hold">Stay on section</option><option value="manual">Manual page range</option>
      </select></label>
      {mode !== "manual" ? <details className="motion-target"><summary>Section target <code>{selector.startsWith("#") ? selector : "CSS selector"}</code></summary><label>Section selector<textarea rows={2} value={selector} spellCheck={false} onChange={event => setSelector(event.target.value)} /></label></details> :
        <div className="motion-field-pair"><label>From %<input type="number" min="0" max="99" value={from} onChange={event => setFrom(Number(event.target.value))} /></label>
          <label>To %<input type="number" min="1" max="100" value={to} onChange={event => setTo(Number(event.target.value))} /></label></div>}
      <div className="motion-field-pair"><label>Duration<select value={duration} onChange={event => setDuration(Number(event.target.value))}>
        {[5, 6, 8, 10, 12, 15, 20, 30].map(seconds => <option key={seconds} value={seconds}>{seconds} seconds</option>)}</select></label>
        <div className="motion-format"><span>Output</span><strong>1920 × 1080</strong><span>60 fps · MP4</span></div></div>
      <button type="button" className="motion-record-button" disabled={disabled || loading || busy || (mode !== "manual" && !selector.trim()) || (mode === "manual" && to - from < 1)}
        onClick={() => { void request({ mode, selector, duration, from, to }); setEditing(false); }}>
        {busy ? <Loader2 size={16} className="motion-spinner" /> : <Play size={16} />}{motion.videoUrl ? "Record again" : "Record motion"}</button>
      {editing ? <button type="button" onClick={() => setEditing(false)}>Keep current recording</button> : null}
    </> : <button type="button" onClick={() => setEditing(true)}><RotateCcw size={15} /> Record again</button>}
    {error || motion.error ? <p className="motion-error" role="alert"><AlertCircle size={15} />{error || motion.error}</p> : null}
    {motion.status === "cancelled" ? <p className="motion-note">Recording cancelled.</p> : null}
    {motion.videoUrl ? <a className="motion-download" href={motion.videoUrl} download="section-motion.mp4"><Download size={14} />Download MP4</a> : null}
  </section>;
}
