import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { minimapDrag, minimapGeometry, minimapJump, type MinimapMetrics } from "./image-minimap";
import "./image-minimap.css";

export function ImageMinimap({ scrollRef, contentRef, src, width, height }: {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  src: string;
  width: number;
  height: number;
}) {
  const [metrics, setMetrics] = useState<MinimapMetrics | null>(null);
  const [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; y: number; scrollTop: number; mapHeight: number; metrics: MinimapMetrics } | null>(null);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const image = content.querySelector("img");
      if (!image?.complete || !image.naturalWidth) { setMetrics(null); return; }
      const box = content.getBoundingClientRect();
      const viewport = scroll.getBoundingClientRect();
      setMetrics({ scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight,
        viewportHeight: scroll.clientHeight, imageHeight: box.height,
        imageTop: box.top - viewport.top - scroll.clientTop + scroll.scrollTop });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    observer.observe(content);
    scroll.addEventListener("scroll", schedule, { passive: true });
    content.addEventListener("load", schedule, true);
    content.addEventListener("error", schedule, true);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", schedule);
      content.removeEventListener("load", schedule, true);
      content.removeEventListener("error", schedule, true);
    };
  }, [scrollRef, contentRef, src]);

  const geometry = metrics && minimapGeometry(metrics, width, height);
  if (!metrics || !geometry) return null;
  const maxScroll = Math.max(0, metrics.scrollHeight - metrics.viewportHeight);
  const scrollTo = (top: number) => scrollRef.current?.scrollTo({ top, behavior: "auto" });

  return <div className={`image-minimap${dragging ? " is-dragging" : ""}`}
    style={{ width: geometry.width, height: geometry.height, visibility: ready ? "visible" : "hidden" }}
    role="slider" tabIndex={ready ? 0 : -1} aria-label="Screenshot overview" aria-orientation="vertical"
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(metrics.scrollTop / maxScroll * 100)}
    title="Screenshot overview"
    onPointerDown={(event) => {
      if (event.button !== 0 || !ready) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      const rect = event.currentTarget.getBoundingClientRect();
      const y = event.clientY - rect.top;
      const inIndicator = y >= geometry.indicatorTop && y <= geometry.indicatorTop + geometry.indicatorHeight;
      const top = inIndicator ? (scrollRef.current?.scrollTop ?? metrics.scrollTop) : minimapJump(y, rect.height, metrics);
      scrollTo(top);
      drag.current = { id: event.pointerId, y: event.clientY, scrollTop: top, mapHeight: rect.height, metrics };
      setDragging(true);
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (start?.id !== event.pointerId) return;
      scrollTo(minimapDrag(event.clientY - start.y, start.scrollTop, start.mapHeight, start.metrics));
    }}
    onPointerUp={(event) => {
      if (drag.current?.id !== event.pointerId) return;
      drag.current = null;
      setDragging(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
    onPointerCancel={() => { drag.current = null; setDragging(false); }}
    onKeyDown={(event) => {
      const top = scrollRef.current?.scrollTop ?? metrics.scrollTop;
      const targets: Record<string, number> = { ArrowUp: top - metrics.viewportHeight * 0.15,
        ArrowDown: top + metrics.viewportHeight * 0.15, PageUp: top - metrics.viewportHeight * 0.9,
        PageDown: top + metrics.viewportHeight * 0.9, Home: 0, End: maxScroll };
      if (!(event.key in targets)) return;
      event.preventDefault();
      event.stopPropagation();
      scrollTo(Math.max(0, Math.min(maxScroll, targets[event.key])));
    }}>
    <img src={src} alt="" aria-hidden="true" draggable={false}
      onLoad={() => setReady(true)} onError={() => setReady(false)} />
    <div className="image-minimap-viewport" aria-hidden="true"
      style={{ top: geometry.indicatorTop, height: geometry.indicatorHeight }} />
  </div>;
}
