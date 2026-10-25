import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function OverlayScrollArea({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const id = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; top: number } | null>(null);
  const [position, setPosition] = useState({ top: 0, max: 0, height: 0 });
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    if (!enabled) return;
    const element = viewport.current;
    const inner = content.current;
    if (!element || !inner) return;
    const measure = () => setPosition({ top: element.scrollTop, max: Math.max(0, element.scrollHeight - element.clientHeight), height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(inner);
    element.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => { observer.disconnect(); element.removeEventListener("scroll", measure); };
  }, [enabled]);

  if (!enabled) return <>{children}</>;

  const trackHeight = Math.max(0, position.height - 8);
  const thumbHeight = Math.min(trackHeight, Math.max(28, trackHeight * position.height / (position.max + position.height || 1)));
  const travel = trackHeight - thumbHeight;
  const scrollTo = (value: number) => { viewport.current?.scrollTo({ top: Math.max(0, Math.min(position.max, value)) }); };

  return <div className="new-jobs-scroll-shell">
    <div ref={viewport} id={id} className="new-jobs-scroll-viewport" tabIndex={0} role="region" aria-label="Task list">
      <div ref={content}>{children}</div>
    </div>
    {position.max > 0 && <div ref={track} className="new-jobs-scrollbar" role="scrollbar" aria-label="Scroll task list" aria-controls={id} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={Math.round(position.max)} aria-valuenow={Math.round(position.top)} tabIndex={0} data-dragging={dragging || undefined}
      onKeyDown={event => {
        const amount = event.key === "ArrowDown" ? 40 : event.key === "ArrowUp" ? -40 : event.key === "PageDown" ? position.height : event.key === "PageUp" ? -position.height : null;
        if (amount !== null) { event.preventDefault(); scrollTo(position.top + amount); }
        else if (event.key === "Home" || event.key === "End") { event.preventDefault(); scrollTo(event.key === "Home" ? 0 : position.max); }
      }}
      onPointerDown={event => {
        if (event.button !== 0 || !track.current || !travel) return;
        event.preventDefault();
        const thumbTop = position.top / position.max * travel;
        const y = event.clientY - track.current.getBoundingClientRect().top;
        const top = y >= thumbTop && y <= thumbTop + thumbHeight ? position.top : (y - thumbHeight / 2) / travel * position.max;
        scrollTo(top);
        drag.current = { y: event.clientY, top: Math.max(0, Math.min(position.max, top)) };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => { if (drag.current && travel) scrollTo(drag.current.top + (event.clientY - drag.current.y) / travel * position.max); }}
      onPointerUp={() => { drag.current = null; setDragging(false); }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}>
      <span style={{ height: thumbHeight, transform: `translateY(${position.max ? position.top / position.max * travel : 0}px)` }} />
    </div>}
  </div>;
}
