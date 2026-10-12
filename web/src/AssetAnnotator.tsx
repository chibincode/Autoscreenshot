import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { ArrowLeft, Check, Copy, Download, SquareDashed, Trash2 } from "lucide-react";
import { Button } from "./ui/Button";
import {
  annotationFeedbackText,
  imagePoint,
  readAnnotationDraft,
  regionBetween,
  renderAnnotationFeedback,
  type ImageAnnotation,
  type ImagePoint,
  type ImageRegion,
} from "./image-annotations";
import "./asset-annotations.css";

export function AssetAnnotator({ src, fileName, width, height, context, draftKey, onDone }: {
  src: string;
  fileName: string;
  width: number;
  height: number;
  context: string;
  draftKey: string;
  onDone: () => void;
}) {
  const [annotations, setAnnotations] = useState<ImageAnnotation[]>(() => {
    try { return readAnnotationDraft(localStorage.getItem(draftKey), width, height); }
    catch { return []; }
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ImageRegion | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<{ pointerId: number; start: ImagePoint } | null>(null);
  const ready = loaded && annotations.length > 0 && annotations.every((annotation) => annotation.comment.trim());

  useEffect(() => {
    try {
      if (annotations.length) localStorage.setItem(draftKey, JSON.stringify(annotations));
      else localStorage.removeItem(draftKey);
    } catch { /* Drafts remain usable when browser storage is unavailable. */ }
    setCopied(false);
  }, [annotations, draftKey]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (selectedId) editorRef.current?.focus({ preventScroll: true });
  }, [selectedId]);

  const naturalPoint = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return imagePoint({ x: event.clientX, y: event.clientY }, bounds, width, height);
  };
  const regionStyle = (region: ImageRegion): CSSProperties => ({
    left: `${region.x / width * 100}%`, top: `${region.y / height * 100}%`,
    width: `${region.width / width * 100}%`, height: `${region.height / height * 100}%`,
  });
  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const region = regionBetween(drag.current.start, naturalPoint(event));
    drag.current = null;
    setDraft(null);
    const bounds = event.currentTarget.getBoundingClientRect();
    if (region.width / width * bounds.width < 6 || region.height / height * bounds.height < 6) return;
    const annotation = { id: crypto.randomUUID(), region, comment: "" };
    setAnnotations((current) => [...current, annotation]);
    setSelectedId(annotation.id);
    setError(null);
  };

  const exportImage = async () => {
    const image = imageRef.current;
    if (!image || !image.complete || !image.naturalWidth) throw new Error("The screenshot is not loaded yet.");
    await image.decode();
    if (image.naturalWidth !== width || image.naturalHeight !== height) {
      throw new Error("The screenshot dimensions have changed. Close and reopen the preview.");
    }
    return renderAnnotationFeedback(image, context, annotations);
  };
  const copy = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("Image clipboard is unavailable. Download the feedback image instead.");
      }
      // Start the clipboard write in the click gesture; image generation can finish asynchronously.
      const png = exportImage();
      void png.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({
        "image/png": png,
        "text/plain": new Blob([annotationFeedbackText(context, annotations, width, height)], { type: "text/plain" }),
      })]);
      setCopied(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Copy failed. Download the feedback image instead.");
    } finally { setBusy(false); }
  };
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = URL.createObjectURL(await exportImage());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${fileName.replace(/\.[^.]+$/, "")}_feedback.png`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Export failed."); }
    finally { setBusy(false); }
  };

  return (
    <div className="asset-preview-modal-body annotation-body" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (draft) { drag.current = null; setDraft(null); }
        else onDone();
      }
    }}>
      <div className="asset-preview-image-wrap">
        <div className="annotation-stage" ref={stageRef}
          onPointerDown={(event) => {
            if (event.button !== 0 || !loaded || busy || annotations.length >= 20) return;
            if ((event.target as HTMLElement).closest("button")) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const start = naturalPoint(event);
            drag.current = { pointerId: event.pointerId, start };
            setDraft(regionBetween(start, start));
          }}
          onPointerMove={(event) => {
            if (drag.current?.pointerId === event.pointerId) setDraft(regionBetween(drag.current.start, naturalPoint(event)));
          }}
          onPointerUp={finishDrag}
          onPointerCancel={() => { drag.current = null; setDraft(null); }}>
          <img ref={imageRef} src={src} alt={fileName} className="asset-preview-image" draggable={false}
            onLoad={() => setLoaded(true)} onError={() => { setLoaded(false); setError("Could not load the screenshot. Reopen the preview and retry."); }} />
          {annotations.map((annotation, index) => (
            <button key={annotation.id} type="button" className={`annotation-region${selectedId === annotation.id ? " is-selected" : ""}`}
              style={regionStyle(annotation.region)} aria-label={`Edit annotation ${index + 1}`} aria-pressed={selectedId === annotation.id}
              onClick={() => setSelectedId(annotation.id)}>
              <span>{index + 1}</span>
            </button>
          ))}
          {draft && <div className="annotation-region annotation-region-draft" style={regionStyle(draft)} />}
        </div>
      </div>
      <aside className="asset-preview-sidebar annotation-sidebar">
        <div className="annotation-toolbar">
          <Button variant="ghost" size="sm" onClick={onDone} className="annotation-back" aria-label="Back to image preview" title="Back to image preview"><ArrowLeft size={16} /></Button>
          <strong>Annotate</strong>
          <span className="annotation-count">{annotations.length} / 20</span>
        </div>
        <div className="annotation-list">
          {annotations.length === 0 && <div className="annotation-empty"><SquareDashed size={28} aria-hidden="true" /><span>No annotations yet</span></div>}
          {annotations.map((annotation, index) => (
            <div className={`annotation-item${annotation.id === selectedId ? " is-selected" : ""}`} key={annotation.id}>
              <div className="annotation-item-header">
                <button type="button" className="annotation-item-select" onClick={() => {
                  setSelectedId(annotation.id);
                  const stage = stageRef.current;
                  const wrap = stage?.parentElement;
                  if (stage && wrap) wrap.scrollTo({ top: Math.max(0, stage.offsetHeight * annotation.region.y / height - 80), behavior: "smooth" });
                }}><span className="annotation-number">{index + 1}</span> Region {index + 1}</button>
                <Button variant="ghost" size="sm" className="annotation-icon-button" title="Delete annotation" aria-label={`Delete annotation ${index + 1}`} disabled={busy}
                  onClick={() => { setAnnotations((current) => current.filter((item) => item.id !== annotation.id)); if (selectedId === annotation.id) setSelectedId(null); }}><Trash2 size={16} /></Button>
              </div>
              {selectedId === annotation.id ? (
                <textarea ref={editorRef} aria-label={`Feedback for region ${index + 1}`} placeholder="What needs to change?" maxLength={2000} rows={4} value={annotation.comment} disabled={busy}
                  onChange={(event) => setAnnotations((current) => current.map((item) => item.id === annotation.id ? { ...item, comment: event.target.value } : item))} />
              ) : <button type="button" className="annotation-comment" onClick={() => setSelectedId(annotation.id)}>{annotation.comment || "Add feedback"}</button>}
              <span className="annotation-coordinates">x {annotation.region.x} · y {annotation.region.y} · {annotation.region.width} × {annotation.region.height} px</span>
            </div>
          ))}
        </div>
        <div className="annotation-export">
          <Button variant="primary" block className="annotation-copy" onClick={() => void copy()} disabled={!ready || busy} aria-label={copied ? "Feedback copied" : "Copy annotated feedback"} title={copied ? "Feedback copied" : "Copy feedback"}>
            {copied ? <Check size={18} /> : <><Copy size={16} /><span>{busy ? "Preparing…" : "Copy feedback"}</span></>}
          </Button>
          <Button variant="secondary" block onClick={() => void download()} disabled={!ready || busy}><Download size={16} /> Download feedback</Button>
          <span className="annotation-status" role="status">{copied ? "" : error}</span>
        </div>
      </aside>
    </div>
  );
}
