import { useEffect, useRef, type ReactNode } from "react";
import { LayoutGrid, List, Plus } from "lucide-react";
import type { InterfaceVersion } from "./interface-version.js";

export interface PagePresentation {
  filter: "all" | "selected";
  layout: "grid" | "list";
  overview: boolean;
  onFilterChange: (filter: "all" | "selected") => void;
  onLayoutChange: (layout: "grid" | "list") => void;
  onOverviewChange: (overview: boolean) => void;
}

export function InterfaceVersionSwitch({ value, onChange }: {
  value: InterfaceVersion;
  onChange: (version: InterfaceVersion) => void;
}) {
  return <div className="interface-version-switch" role="group" aria-label="Interface version">
    {(["classic", "new"] as const).map(version => <button
      key={version}
      type="button"
      aria-pressed={value === version}
      onClick={() => onChange(version)}
    >{version === "classic" ? "Classic" : "New"}</button>)}
  </div>;
}

export function NewWorkspaceHeader({ history, onHistoryChange, version, onVersionChange, connected }: {
  history: boolean;
  onHistoryChange: (history: boolean) => void;
  version: InterfaceVersion;
  onVersionChange: (version: InterfaceVersion) => void;
  connected: boolean;
}) {
  return <header className="new-workspace-header">
    <strong>Autoscreenshot</strong>
    <nav aria-label="Task views">
      <button type="button" aria-pressed={!history} onClick={() => onHistoryChange(false)}>Queue</button>
      <button type="button" aria-pressed={history} onClick={() => onHistoryChange(true)}>History</button>
    </nav>
    <span className="new-live-status" data-connected={connected}>{connected ? "Live" : "Offline"}</span>
    <InterfaceVersionSwitch value={version} onChange={onVersionChange} />
  </header>;
}

export function NewPagesToolbar({ presentation, total, selected, children }: {
  presentation: PagePresentation;
  total: number;
  selected: number;
  children?: ReactNode;
}) {
  return <div className="new-pages-toolbar">
    <div className="new-page-filter" role="group" aria-label="Page filter">
      <button type="button" aria-pressed={presentation.filter === "all"} onClick={() => presentation.onFilterChange("all")}>
        All pages <span>{total}</span>
      </button>
      <button type="button" aria-pressed={presentation.filter === "selected"} onClick={() => presentation.onFilterChange("selected")}>
        Selected <span>{selected}</span>
      </button>
    </div>
    <div className="new-page-tools">
      <label><input type="checkbox" checked={presentation.overview} onChange={event => presentation.onOverviewChange(event.target.checked)} />Full-page overview</label>
      <div className="new-view-toggle" role="group" aria-label="Page layout">
        <button type="button" aria-label="Grid view" title="Grid view" aria-pressed={presentation.layout === "grid"} onClick={() => presentation.onLayoutChange("grid")}><LayoutGrid /></button>
        <button type="button" aria-label="List view" title="List view" aria-pressed={presentation.layout === "list"} onClick={() => presentation.onLayoutChange("list")}><List /></button>
      </div>
      {children}
    </div>
  </div>;
}

export function NewCaptureButton({ onClick }: { onClick: () => void }) {
  return <button className="new-capture-button" type="button" onClick={onClick}><Plus />New capture</button>;
}

export function CaptureDialog({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const backdropPress = useRef(false);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    ref.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return () => {
      ref.current?.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  const outside = (event: { clientX: number; clientY: number; currentTarget: HTMLDialogElement }) => {
    const r = event.currentTarget.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  };

  return <dialog ref={ref} className="new-capture-dialog" aria-label="New capture"
    onCancel={event => { event.preventDefault(); closeRef.current(); }}
    onPointerDown={event => { backdropPress.current = event.target === event.currentTarget && outside(event); }}
    onClick={event => {
      if (backdropPress.current && event.target === event.currentTarget && outside(event)) closeRef.current();
      backdropPress.current = false;
    }}
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = Array.from(ref.current!.querySelectorAll<HTMLElement>("button:not(:disabled),textarea,input:not(:disabled),select:not(:disabled),a[href],summary"))
        .filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
  >{children}</dialog>;
}

export function CaptureSurface({ version, open, onClose, children }: {
  version: InterfaceVersion;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return version === "new" ? <CaptureDialog open={open} onClose={onClose}>{children}</CaptureDialog> : <>{children}</>;
}
