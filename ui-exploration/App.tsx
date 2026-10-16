import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Archive, ArrowLeft, ArrowUpRight, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Copy, Crop, Download, ExternalLink, Folder, FolderInput, Image as ImageIcon, LayoutGrid, List, LoaderCircle, MessageSquare, Plus, RefreshCw, ScanLine, Search, Settings2, SlidersHorizontal, X } from 'lucide-react';
import { ImageMinimap } from '../web/src/ImageMinimap';
import './style.css';
import './current-skin.css';

type Asset = { id: number; path: string; src: string; thumbnail: string; sourceUrl: string; fileName: string; folder: string; folderManual?: boolean; width: number; height: number; capturedAt?: string };
type Job = { id: string; domain: string; status: string; date: string; assets: Asset[]; failed: number; skipped: number; logs: { ts: string; level: string; message: string }[]; history?: boolean; imported?: boolean };
type Variant = 0 | 1;
type Mode = 'preview' | 'crop' | 'annotate';
const names = ['Current', 'Proposed'];
const date = (value: string) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const title = (asset: Asset) => asset.path === '/' ? 'Home' : asset.path.split('/').filter(Boolean).map(word => word.replaceAll('-', ' ')).at(-1)!;
const shortFolder = (path: string) => path.split('/').at(-1)!.replace(/^Page_/, '').replaceAll('_', ' ');
const status = (job: Job) => job.imported ? 'Imported' : job.status === 'partial_success' ? 'Needs review' : job.status === 'queued' ? 'Queued' : 'Ready to import';
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (!!target.closest('input, textarea, select, [contenteditable="true"]'));

function DestinationChoices({ asset, suggested, folders, onSelect }: { asset: Asset; suggested?: string; folders: string[]; onSelect: (folder: string) => void }) {
  const [query, setQuery] = useState('');
  const [recent] = useState<string[]>(() => {
    try { const value = JSON.parse(localStorage.getItem('autoscreenshot.proposed.recentFolders.v1') || '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 6) : []; } catch { return []; }
  });
  const matches = folders.filter(folder => folder.toLowerCase().includes(query.trim().toLowerCase()));
  const recentMatches = recent.filter(folder => matches.includes(folder));
  const choose = (folder: string) => {
    try { localStorage.setItem('autoscreenshot.proposed.recentFolders.v1', JSON.stringify([folder, ...recent.filter(item => item !== folder)].slice(0, 6))); } catch { /* Selection still works when storage is unavailable. */ }
    onSelect(folder);
  };
  const row = (folder: string) => <button key={folder} aria-label={`Use ${shortFolder(folder)}`} aria-pressed={folder === asset.folder} onClick={() => choose(folder)}><Folder /><span className="destination-option-copy"><strong>{shortFolder(folder)}</strong><small>{folder}</small></span><span className="destination-badges">{folder === asset.folder && <span>Current</span>}{folder === suggested && <span>Suggested</span>}{recent.includes(folder) && <span>Recent</span>}</span>{folder === asset.folder ? <Check /> : <ChevronRight />}</button>;
  return <>
    <div className="destination-current"><div><span className="eyebrow">CURRENT DESTINATION</span><span>{asset.folderManual ? 'Manual' : 'Auto'}</span></div><strong>{shortFolder(asset.folder)}</strong><small>{asset.folder}</small></div>
    <label className="search"><Search /><input autoFocus aria-label="Search folders" placeholder="Search folder name or path" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="destination-result-count" aria-live="polite">{matches.length} {matches.length === 1 ? 'folder' : 'folders'}</div>
    <div className="folder-options destination-options">
      {recentMatches.length > 0 && <><h3>Recently used</h3>{recentMatches.map(row)}</>}
      {matches.some(folder => !recentMatches.includes(folder)) && <><h3>{query.trim() ? 'Search results' : 'All folders'}</h3>{matches.filter(folder => !recentMatches.includes(folder)).map(row)}</>}
      {!matches.length && <p>No folders match “{query}”.</p>}
    </div>
  </>;
}

function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" {...props} className={`icon-button ${props.className || ''}`} title={label} aria-label={label}>{children}</button>;
}

function Picker({ value, onChange, position }: { value: Variant; onChange: (value: Variant) => void; position?: 'top' }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const update = () => {
      const button = ref.current?.querySelectorAll<HTMLButtonElement>('.proto-picker-item')[value];
      const highlight = ref.current?.querySelector<HTMLElement>('.proto-picker-highlight');
      if (button && highlight) { highlight.style.width = `${button.offsetWidth}px`; highlight.style.transform = `translateX(${button.offsetLeft}px)`; }
    };
    update(); window.addEventListener('resize', update);
    const frame = requestAnimationFrame(() => ref.current?.setAttribute('data-ready', ''));
    return () => { window.removeEventListener('resize', update); cancelAnimationFrame(frame); };
  }, [value]);
  return <nav className="proto-picker" aria-label="Prototype variants" data-position={position} ref={ref}>
    <span className="proto-picker-highlight" aria-hidden="true" />
    {names.map((name, index) => <button key={name} className="proto-picker-item" data-active={value === index ? '' : undefined} aria-current={value === index ? 'true' : undefined} onClick={() => onChange(index as Variant)}>{name}</button>)}
  </nav>;
}

function Dialog({ children, label, onClose, className = '' }: { children: React.ReactNode; label: string; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => { ref.current?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const trapFocus = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return;
    const controls = Array.from(ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(element => element.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const isOutside = (event: React.MouseEvent<HTMLDialogElement> | React.PointerEvent<HTMLDialogElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  return <dialog ref={ref} className={className} aria-label={label} onKeyDown={trapFocus}
    onCancel={(event) => { event.preventDefault(); closeRef.current(); }}
    onPointerDown={event => { backdropPress.current = event.target === event.currentTarget && isOutside(event); }}
    onClick={event => {
      if (event.target === event.currentTarget && backdropPress.current && isOutside(event)) closeRef.current();
      backdropPress.current = false;
    }}>{children}</dialog>;
}

function Review({ asset, selected, toggle, onClose, onApply, onRestore, variant, onVariant, onDestination }: { asset: Asset; selected: boolean; toggle: () => void; onClose: () => void; onApply: (src: string, height: number) => void; onRestore?: () => void; variant: Variant; onVariant: (v: Variant) => void; onDestination?: () => void }) {
  const [mode, setMode] = useState<Mode>('preview');
  const [cropType, setCropType] = useState('band');
  const [start, setStart] = useState(Math.round(asset.height * .4));
  const [end, setEnd] = useState(Math.round(asset.height * .6));
  const [region, setRegion] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [feedback, setFeedback] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tech, setTech] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number; target: string; start: number; end: number } | null>(null);
  const canApply = start >= 0 && end <= asset.height && end > start && end - start < asset.height;
  const naturalY = (clientY: number) => { const rect = stageRef.current!.getBoundingClientRect(); return Math.max(0, Math.min(asset.height, (clientY - rect.top) / rect.height * asset.height)); };
  const openMode = (next: Mode) => {
    setMode(next); setError('');
  };
  useEffect(() => {
    if (mode !== 'crop') return;
    const frame = requestAnimationFrame(() => {
      const wrap = scrollRef.current; const stage = stageRef.current;
      if (wrap && stage) wrap.scrollTo({ top: stage.offsetHeight * ((start + end) / 2 / asset.height) - wrap.clientHeight / 2 });
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, cropType]);
  const begin = (e: React.PointerEvent<HTMLDivElement>, target: string) => {
    if (mode !== 'annotate' && mode !== 'crop') return;
    if (mode === 'crop' && target === 'annotation') return;
    e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
    const rect = stageRef.current!.getBoundingClientRect();
    pointer.current = { x: Math.max(0, (e.clientX - rect.left) / rect.width * asset.width), y: naturalY(e.clientY), target, start, end };
    if (mode === 'annotate') setRegion(null);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const anchor = pointer.current; if (!anchor) return;
    const y = naturalY(e.clientY);
    if (mode === 'annotate') {
      const rect = stageRef.current!.getBoundingClientRect(); const x = Math.max(0, Math.min(asset.width, (e.clientX - rect.left) / rect.width * asset.width));
      setRegion({ x: Math.round(Math.min(x, anchor.x)), y: Math.round(Math.min(y, anchor.y)), w: Math.round(Math.abs(x - anchor.x)), h: Math.round(Math.abs(y - anchor.y)) });
    } else if (anchor.target === 'start') setStart(Math.round(Math.min(y, end - 1)));
    else if (anchor.target === 'end') setEnd(Math.round(Math.max(y, start + 1)));
    else { const height = anchor.end - anchor.start; const top = Math.max(0, Math.min(asset.height - height, anchor.start + y - anchor.y)); setStart(Math.round(top)); setEnd(Math.round(top + height)); }
  };
  const apply = async () => {
    setBusy(true); setError('');
    try {
      const image = new window.Image(); image.src = asset.src; await image.decode();
      const scale = image.naturalWidth / asset.width;
      const top = Math.round(start * scale), bottom = Math.round(end * scale);
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight - (bottom - top);
      if (!canvas.height || bottom <= top) throw new Error('Choose a larger section to remove.');
      const context = canvas.getContext('2d')!;
      if (top > 0) context.drawImage(image, 0, 0, image.naturalWidth, top, 0, 0, image.naturalWidth, top);
      if (bottom < image.naturalHeight) context.drawImage(image, 0, bottom, image.naturalWidth, image.naturalHeight - bottom, 0, top, image.naturalWidth, image.naturalHeight - bottom);
      onApply(canvas.toDataURL('image/jpeg', .92), asset.height - (end - start)); setMode('preview');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not crop the demo image.'); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(`Demo feedback (not sent)\nasset_id=${asset.id}\nsource_url=${asset.sourceUrl}\n${region ? `Region x=${region.x}, y=${region.y}, width=${region.w}, height=${region.h}\n` : ''}${feedback}`); setCopied(true); }
    catch { setError('Clipboard unavailable. Select and copy your comment manually.'); }
  };
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);
  return <Dialog label={`${title(asset)} image review`} className="review-dialog" onClose={onClose}>
    <header className="review-header"><div><strong>{title(asset)}</strong><span>{new URL(asset.sourceUrl).hostname} <span className="header-dot">/</span> {asset.path}</span></div><div className="review-header-tools"><span className="capture-status"><CheckCircle2 /> Captured</span><IconButton label="Close image review" onClick={onClose}><X /></IconButton></div></header>
    <div className="review-body">
      <div className="review-canvas">
        <div ref={scrollRef} className="review-scroll"><div ref={stageRef} className={`review-stage ${mode === 'annotate' ? 'is-annotating' : ''}`} onPointerDown={e => begin(e, 'annotation')} onPointerMove={move} onPointerUp={() => pointer.current = null} onPointerCancel={() => pointer.current = null}>
          <img src={asset.src} width={asset.width} height={asset.height} alt={`${title(asset)} full-page screenshot`} draggable={false} />
          {mode === 'crop' && <><div className="crop-mask" style={{ top: `${start / asset.height * 100}%`, height: `${(end - start) / asset.height * 100}%` }} onPointerDown={e => begin(e, 'band')}><span>Remove {(end - start).toLocaleString()} px</span></div><div role="separator" aria-label="Top crop boundary" className="crop-line" style={{ top: `${start / asset.height * 100}%` }} onPointerDown={e => begin(e, 'start')} /><div role="separator" aria-label="Bottom crop boundary" className="crop-line" style={{ top: `${end / asset.height * 100}%` }} onPointerDown={e => begin(e, 'end')} /></>}
          {mode === 'annotate' && region && <div className="annotation-region" style={{ left: `${region.x / asset.width * 100}%`, top: `${region.y / asset.height * 100}%`, width: `${region.w / asset.width * 100}%`, height: `${region.h / asset.height * 100}%` }}><span>1</span></div>}
        </div></div>
        <ImageMinimap scrollRef={scrollRef} contentRef={stageRef} src={asset.src} width={asset.width} height={asset.height} />
      </div>
      <aside className="review-sidebar">
        {mode === 'preview' ? <>
          <label className="import-select"><input type="checkbox" checked={selected} onChange={toggle} /> Selected for import</label>
          <div className="review-actions"><button className="primary" onClick={() => openMode('crop')}><Crop /> Crop image</button><button onClick={() => openMode('annotate')}><ScanLine /> Annotate</button><div className="action-pair"><a className="button" href={asset.sourceUrl} target="_blank" rel="noreferrer">Visit original <ArrowUpRight /></a><button onClick={copy}>{copied ? <Check className="green" /> : <Copy />}<span>{copied ? 'Copied' : 'Copy feedback'}</span></button></div></div>
          {onRestore && <button className="technical-toggle" onClick={onRestore}><RefreshCw /> Restore original</button>}
          <div className="sidebar-section destination-section"><span className="eyebrow">DESTINATION</span><button className="folder-display destination-edit" disabled={!onDestination} onClick={onDestination} aria-label="Edit destination folder"><Folder /><span><strong>{shortFolder(asset.folder)}</strong><small>{asset.folder}</small></span>{onDestination && <ChevronDown />}</button><span className="auto-match"><Check /> {asset.folderManual ? 'Manually selected' : 'Automatically matched'}{!onDestination ? ' · Imported' : ''}</span></div>
          <div className="sidebar-section"><span className="eyebrow">IMAGE</span><dl className="compact-facts"><div><dt>Dimensions</dt><dd>{asset.width.toLocaleString()} × {asset.height.toLocaleString()}</dd></div><div><dt>Format</dt><dd>JPEG · Quality 92</dd></div><div><dt>Import</dt><dd>{selected ? 'Pending confirmation' : 'Not selected'}</dd></div></dl></div>
          <button className="technical-toggle" aria-expanded={tech} onClick={() => setTech(!tech)}>Technical details <ChevronDown className={tech ? 'rotated' : ''} /></button>
          {tech && <div className="technical-details"><span>Asset #{asset.id}</span><span>{asset.fileName}</span><a href={asset.sourceUrl} target="_blank" rel="noreferrer">{asset.sourceUrl}</a><span>Original capture · DPR 2</span></div>}
        </> : <>
          <div className="tool-heading"><IconButton label="Back to image" onClick={() => setMode('preview')}><ArrowLeft /></IconButton><strong>{mode === 'crop' ? 'Crop image' : 'Annotate'}</strong></div>
          {mode === 'crop' ? <><div className="segmented"><button aria-pressed={cropType === 'bottom'} onClick={() => { setCropType('bottom'); setStart(Math.round(asset.height * .9)); setEnd(asset.height); }}>Crop bottom</button><button aria-pressed={cropType === 'band'} onClick={() => { setCropType('band'); setStart(Math.round(asset.height * .4)); setEnd(Math.round(asset.height * .6)); }}>Remove section</button></div><div className="crop-fields"><label>Start <input type="number" min={0} max={asset.height - 1} value={start} onChange={e => setStart(Number(e.target.value))} /><span>px</span></label><label>End <input type="number" min={1} max={asset.height} value={end} disabled={cropType === 'bottom'} onChange={e => setEnd(Number(e.target.value))} /><span>px</span></label></div><dl className="compact-facts crop-summary"><div><dt>Remove</dt><dd>{Math.max(0, end - start).toLocaleString()} px</dd></div><div><dt>New height</dt><dd>{Math.max(0, asset.height - end + start).toLocaleString()} px</dd></div></dl><div className="tool-bottom"><button className="primary" disabled={!canApply || busy} onClick={apply}>{busy ? <LoaderCircle className="spin" /> : <Check />} Apply crop</button><button onClick={() => setMode('preview')}>Cancel</button></div></> : <><div className="annotation-label"><span>1</span><strong>Region feedback</strong>{region && <IconButton label="Clear region" onClick={() => setRegion(null)}><X /></IconButton>}</div><textarea autoFocus aria-label="Region feedback" placeholder="What needs to be fixed?" value={feedback} onChange={e => setFeedback(e.target.value)} /><div className="muted region-coordinates">{region ? `${region.x}, ${region.y} · ${region.w} × ${region.h} px` : 'No region selected'}</div><div className="tool-bottom"><button className="primary" disabled={!region || !feedback.trim()} onClick={copy}>{copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy feedback'}</button></div></>}
        </>}
        {error && <p role="alert" className="error-text">{error}</p>}
        <div className="sidebar-footnote">Local preview · No original files changed</div>
      </aside>
    </div>
    <Picker value={variant} onChange={onVariant} position="top" />
  </Dialog>;
}

function Proposed({ initialJobs, variant, onVariant, onModal, initialPreview }: { initialJobs: Job[]; variant: Variant; onVariant: (v: Variant) => void; onModal: (open: boolean) => void; initialPreview: number | null }) {
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [active, setActive] = useState(initialJobs[0].id);
  const [search, setSearch] = useState('');
  const [queueFilter, setQueueFilter] = useState('all');
  const [history, setHistory] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(true);
  const [selected, setSelected] = useState(new Set(initialJobs.flatMap(job => job.assets.map(asset => asset.id))));
  const [pageFilter, setPageFilter] = useState('all');
  const [layout, setLayout] = useState('grid');
  const [overview, setOverview] = useState(false);
  const [preview, setPreview] = useState<number | null>(initialPreview);
  const [modal, setModal] = useState<'capture' | 'page' | 'import' | 'folder' | null>(null);
  const [folderAsset, setFolderAsset] = useState<number | null>(null);
  const [folderSearch, setFolderSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [undoId, setUndoId] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [formError, setFormError] = useState('');
  const [captureMode, setCaptureMode] = useState('Core Pages');
  const [advanced, setAdvanced] = useState(false);
  const [logs, setLogs] = useState(false);
  const [tuning, setTuning] = useState(false);
  const [cardWidth, setCardWidth] = useState(300);
  const [imageHeight, setImageHeight] = useState(270);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [queuedPages, setQueuedPages] = useState<{ jobId: string; path: string }[]>([]);
  const job = jobs.find(job => job.id === active)!;
  const asset = job.assets.find(asset => asset.id === preview);
  const count = job.assets.filter(asset => selected.has(asset.id)).length;
  const visibleJobs = jobs.filter(job => !!job.history === history && job.domain.includes(search.toLowerCase()) && (queueFilter === 'all' || job.status === queueFilter));
  const visibleAssets = job.assets.filter(asset => pageFilter === 'all' || selected.has(asset.id));
  const original = initialJobs.flatMap(job => job.assets).find(item => item.id === asset?.id);
  useEffect(() => { onModal(!!modal || !!asset); return () => onModal(false); }, [modal, asset?.id]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => { setNotice(''); setUndoId(null); }, 5000); return () => clearTimeout(timer); }, [notice]);
  const toggle = (id: number) => setSelected(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const updateAsset = (id: number, patch: Partial<Asset>) => setJobs(jobs => jobs.map(job => ({ ...job, assets: job.assets.map(asset => asset.id === id ? { ...asset, ...patch } : asset) })));
  const moveHistory = () => { setJobs(jobs => jobs.map(item => item.id === job.id ? { ...item, history: !item.history } : item)); setUndoId(job.id); setNotice(history ? 'Restored to Queue' : 'Moved to History. Original files are unchanged in this demo.'); const next = jobs.find(item => item.id !== job.id && !!item.history === history); if (next) setActive(next.id); };
  const submit = (event: React.FormEvent) => {
    event.preventDefault(); setFormError('');
    let target: URL; try { target = new URL(url); if (!['http:', 'https:'].includes(target.protocol)) throw new Error(); } catch { setFormError('Enter a complete website URL, starting with https://.'); return; }
    if (modal === 'page') { if (target.hostname.replace(/^www\./, '') !== job.domain) { setFormError(`Use a page on ${job.domain}.`); return; } setQueuedPages(pages => [...pages, { jobId: job.id, path: target.pathname }]); setNotice('Page queued in this demo. No live capture was started.'); }
    else { const id = `demo-${Date.now()}`; const newJob = { id, domain: target.hostname, status: 'queued', date: new Date().toISOString(), assets: [], failed: 0, skipped: 0, logs: [] }; setJobs(jobs => [newJob, ...jobs]); setActive(id); setHistory(false); setMobileDetail(true); setNotice(`${captureMode} capture queued in demo only.`); }
    setModal(null); setUrl('');
  };
  const openCapture = () => { setUrl(''); setFormError(''); setModal('capture'); };
  const folders = Array.from(new Set(initialJobs.flatMap(job => job.assets.map(asset => asset.folder)))).filter(folder => folder.toLowerCase().includes(folderSearch.toLowerCase()));
  return <div className={`proposed ${mobileDetail ? 'show-detail' : 'show-queue'}`} style={{ '--card-min': `${cardWidth}px`, '--image-height': `${imageHeight}px` } as React.CSSProperties}>
    <header className="app-header">
      <div className="brand"><div className="brand-symbol"><ScanLine /></div><strong>Autoscreenshot</strong></div>
      <nav className="main-nav" aria-label="Task views">
        <button className={!history ? 'active' : ''} onClick={() => { setHistory(false); const next = jobs.find(item => !item.history); if (next) setActive(next.id); setMobileDetail(false); }}>Queue <span>{jobs.filter(job => !job.history).length}</span></button>
        <button className={history ? 'active' : ''} onClick={() => { setHistory(true); const next = jobs.find(item => item.history); if (next) setActive(next.id); setMobileDetail(false); }}>History <span>{jobs.filter(job => job.history).length}</span></button>
      </nav>
      <div className="header-actions">
        <span className="connection">Local preview</span>
        <button className="new-capture-compact" onClick={openCapture}><Plus /> New capture</button>
        <IconButton label="Tune preview layout" aria-expanded={tuning} onClick={() => setTuning(!tuning)}><Settings2 /></IconButton>
      </div>
    </header>
    <div className="workspace">
      <aside className="queue-sidebar">
        <div className="queue-heading"><h2>{history ? 'History' : 'Queue'}</h2><span>{visibleJobs.length} tasks</span></div>
        <button className="queue-new-capture primary" onClick={openCapture}><Plus /> New capture</button>
        <label className="search"><Search /><input aria-label="Search tasks" placeholder="Search websites" value={search} onChange={e => setSearch(e.target.value)} /></label>
        <select aria-label="Filter tasks" className="queue-filter" value={queueFilter} onChange={e => setQueueFilter(e.target.value)}><option value="all">All tasks</option><option value="partial_success">Needs review</option><option value="awaiting_confirmation">Ready to import</option><option value="queued">Queued</option></select>
        <div className="queue-rows">{visibleJobs.length ? visibleJobs.map(item => <button key={item.id} className={`queue-row ${item.id === active ? 'selected' : ''}`} aria-pressed={item.id === active} onClick={() => { setActive(item.id); setPageFilter('all'); setMobileDetail(true); }}><div className={`site-letter ${item.domain === 'loops.so' ? 'loops' : ''}`}>{item.domain[0].toUpperCase()}</div><div className="queue-row-content"><div className="queue-domain"><strong>{item.domain}</strong><span>{date(item.date)}</span></div><div className="queue-row-meta"><span>Core Pages</span><span>{item.assets.length} pages</span></div><div className={`queue-state ${item.imported ? 'green' : item.status === 'partial_success' ? 'review' : ''}`}><i />{status(item)}{item.failed > 0 && <span> · {item.failed} failed</span>}</div></div></button>) : <div className="queue-empty"><Archive /><strong>{search ? 'No matching tasks' : history ? 'History is empty' : 'No tasks here'}</strong><button onClick={() => { setSearch(''); setQueueFilter('all'); setHistory(false); }}>Back to Queue</button></div>}</div>
        <div className="queue-footer"><span>Local library</span><span>{jobs.reduce((sum, job) => sum + job.assets.length, 0)} captures</span></div>
      </aside>
      <main className="main-workspace">
        {!!job.history !== history ? <div className="pages-empty"><Archive /><h2>{history ? 'History is empty' : 'No task selected'}</h2><p>{history ? 'Move a completed task here to clear your Queue.' : 'Choose a task from the list.'}</p><button onClick={() => { setHistory(false); setMobileDetail(false); }}>Back to Queue</button></div> : <>
        <header className="job-header"><div className="job-identity"><IconButton className="mobile-back" label="Back to task list" onClick={() => setMobileDetail(false)}><ArrowLeft /></IconButton><div className={`site-letter large ${job.domain === 'loops.so' ? 'loops' : ''}`}>{job.domain[0].toUpperCase()}</div><div><div className="job-title"><h1>{job.domain === 'loops.so' ? 'Loops' : job.domain}</h1><span className="mode-label">Core Pages</span></div><a href={`https://${job.domain}`} target="_blank" rel="noreferrer">{job.domain}<ArrowUpRight /></a></div></div><div className="job-actions"><IconButton label={history ? 'Restore to Queue' : 'Move to History'} onClick={moveHistory}><Archive /></IconButton><IconButton label="Rescan core pages" onClick={() => setNotice('Rescan queued in demo only. Your real task is unchanged.')}><RefreshCw /></IconButton><button className="primary" disabled={!count || !!job.imported} onClick={() => setModal('import')}><FolderInput /> {job.imported ? 'Imported' : `Import ${count} selected`}</button></div></header>
        <div className="job-summary"><span className={job.failed ? 'warning-summary' : 'green'}>{job.failed ? <MessageSquare /> : <CheckCircle2 />}{job.failed ? `${job.assets.length} captured · ${job.failed} failed` : `${job.assets.length} pages captured`}</span><span>{job.imported ? 'Imported to Eagle' : `${count} selected for import`}</span><span>{date(job.date)} <span className="summary-time">· JPEG 92 · DPR 2</span></span><button onClick={() => setLogs(!logs)}>Activity <ChevronDown className={logs ? 'rotated' : ''} /></button></div>
        {logs && <section className="activity-panel" aria-label="Capture activity"><div><strong>Capture activity</strong><IconButton label="Close activity" onClick={() => setLogs(false)}><X /></IconButton></div>{job.logs.length ? job.logs.map((log, index) => <p key={index}><time>{new Date(log.ts).toLocaleTimeString('en-US', { hour12: false })}</time><span>{log.message}</span></p>) : <p>No capture activity yet.</p>}</section>}
        <div className="pages-toolbar"><div className="page-tabs" aria-label="Page filter"><button className={pageFilter === 'all' ? 'active' : ''} onClick={() => setPageFilter('all')}>All pages <span>{job.assets.length}</span></button><button className={pageFilter === 'selected' ? 'active' : ''} onClick={() => setPageFilter('selected')}>Selected <span>{count}</span></button></div><div className="page-tools"><label className="overview-toggle"><input type="checkbox" checked={overview} onChange={e => setOverview(e.target.checked)} />Full-page overview</label><div className="view-toggle"><IconButton label="Grid view" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><LayoutGrid /></IconButton><IconButton label="List view" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List /></IconButton></div><button className="quiet" onClick={() => { setUrl(`https://${job.domain}/`); setFormError(''); setModal('page'); }}><Plus /> Add page</button></div></div>
        <section className={`asset-area ${layout === 'list' ? 'list-layout' : ''}`} aria-label="Captured pages">
          {visibleAssets.map(item => <article className={`asset-card ${selected.has(item.id) ? '' : 'unselected'}`} key={item.id}><div className={`thumbnail ${overview ? 'overview' : ''}`}><button className="image-open" onClick={() => setPreview(item.id)} aria-label={`Review ${item.path}`}><img src={item.src.startsWith('data:') ? item.src : item.thumbnail} alt={`${title(item)} screenshot`} width={item.width} height={item.height} loading="lazy" /></button><label className="thumbnail-select" title="Select for import"><input type="checkbox" aria-label={`Select ${item.path} for import`} checked={selected.has(item.id)} onChange={() => toggle(item.id)} /></label><IconButton className="thumbnail-rescan" label={`Rescan ${item.path}`} disabled={busyId === item.id} onClick={() => { setBusyId(item.id); setNotice('Rescan simulated locally. No real capture started.'); setTimeout(() => setBusyId(null), 1000); }}>{busyId === item.id ? <LoaderCircle className="spin" /> : <RefreshCw />}</IconButton><span className="thumbnail-size"><ImageIcon /> {item.width.toLocaleString()} × {item.height.toLocaleString()}</span></div><div className="card-description"><div className="card-title"><button onClick={() => setPreview(item.id)} title={item.path}>{item.path === '/' ? 'Home' : item.path}</button><CheckCircle2 className="green" aria-label="Captured successfully" /></div><button className="card-folder" disabled={job.imported} title={item.folder} onClick={() => { setFolderAsset(item.id); setFolderSearch(''); setModal('folder'); }}><Folder /><span>{shortFolder(item.folder)}</span><ChevronDown /></button></div></article>)}
          {queuedPages.filter(page => page.jobId === job.id).map((page, index) => <article className="queued-card" key={index}><LoaderCircle /><strong>{page.path}</strong><span>Queued · Demo only</span><button onClick={() => setQueuedPages(pages => pages.filter(item => item !== page))}>Cancel</button></article>)}
          {!visibleAssets.length && !queuedPages.some(page => page.jobId === job.id) && <div className="pages-empty"><ImageIcon /><h2>{job.assets.length ? 'No pages selected' : 'Waiting for capture'}</h2><p>{job.assets.length ? 'Select pages from All pages to prepare your import.' : 'This task is queued in the local demo.'}</p><button onClick={() => { if (job.assets.length) setPageFilter('all'); else { setJobs(items => items.filter(item => item.id !== job.id)); setActive(initialJobs[0].id); setNotice('Demo capture cancelled. No live task was affected.'); } }}>{job.assets.length ? 'View all pages' : 'Cancel demo capture'}</button></div>}
        </section>
        <footer className="workspace-footer"><span>{job.assets.length} captures <span className="footer-separator">/</span> {count} selected</span><span>Original files preserved</span></footer>
        </>}
      </main>
    </div>
    {tuning && <aside className="tuning-panel"><div><strong>Layout tuning</strong><IconButton label="Close layout tuning" onClick={() => setTuning(false)}><X /></IconButton></div><label>Card width <output>{cardWidth}px</output><input aria-label="Card width" type="range" min={240} max={420} step={20} value={cardWidth} onChange={e => setCardWidth(Number(e.target.value))} /></label><label>Preview height <output>{imageHeight}px</output><input aria-label="Preview height" type="range" min={200} max={400} step={10} value={imageHeight} onChange={e => setImageHeight(Number(e.target.value))} /></label><button onClick={() => { setCardWidth(300); setImageHeight(270); }}>Reset values</button></aside>}
    {notice && <div className="toast" role="status"><CheckCircle2 /><span>{notice}</span>{undoId && <button onClick={() => { setJobs(jobs => jobs.map(job => job.id === undoId ? { ...job, history: !job.history } : job)); setActive(undoId); setUndoId(null); setNotice('Move undone.'); }}>Undo</button>}<IconButton label="Dismiss notification" onClick={() => setNotice('')}><X /></IconButton></div>}
    {asset && <Review key={asset.id + ':' + asset.height} asset={asset} selected={selected.has(asset.id)} toggle={() => toggle(asset.id)} onClose={() => setPreview(null)} onApply={(src, height) => { updateAsset(asset.id, { src, thumbnail: src, height }); setNotice('Crop applied to the demo copy only.'); }} onRestore={original && asset.src !== original.src ? () => { updateAsset(asset.id, original); setNotice('Demo image restored.'); } : undefined} variant={variant} onVariant={onVariant} onDestination={job.imported ? undefined : () => { setFolderAsset(asset.id); setFolderSearch(''); setModal('folder'); }} />}
    {modal && <Dialog label={modal === 'folder' ? 'Choose destination folder' : modal === 'import' ? 'Confirm demo import' : modal === 'page' ? 'Add page' : 'New capture'} onClose={() => setModal(null)} className={`small-dialog ${modal === 'folder' ? 'destination-dialog' : ''}`}><header><h2>{modal === 'folder' ? 'Choose destination' : modal === 'import' ? 'Import to Eagle' : modal === 'page' ? 'Add page' : 'New capture'}</h2><IconButton label="Close dialog" onClick={() => setModal(null)}><X /></IconButton></header>
      {modal === 'folder' && folderAsset !== null && <DestinationChoices asset={jobs.flatMap(item => item.assets).find(item => item.id === folderAsset)!} suggested={initialJobs.flatMap(item => item.assets).find(item => item.id === folderAsset)?.folder} folders={folders} onSelect={folder => { if (jobs.some(item => item.imported && item.assets.some(asset => asset.id === folderAsset))) return; updateAsset(folderAsset, { folder, folderManual: true }); setModal(null); }} />}
      {modal === 'folder' ? null : modal === 'import' ? <><p>{count} selected screenshots from <strong>{job.domain}</strong>.</p><p className="muted">Preview only. Nothing will be sent to Eagle.</p><div className="dialog-actions"><button onClick={() => setModal(null)}>Cancel</button><button className="primary" onClick={() => { setJobs(jobs => jobs.map(item => item.id === active ? { ...item, imported: true } : item)); setModal(null); setNotice('Demo import complete. Nothing was sent to Eagle.'); }}><FolderInput /> Simulate import</button></div></> : <form onSubmit={submit}><label className="form-field">{modal === 'page' ? 'Page URL' : 'Website URL'}<input autoFocus type="text" inputMode="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com" required /></label>{modal === 'capture' && <><label className="form-field">Capture mode<select value={captureMode} onChange={e => setCaptureMode(e.target.value)}><option>Core Pages</option><option>Section</option></select></label><button className="technical-toggle" type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>Advanced <ChevronDown /></button>{advanced && <div className="advanced-grid"><label>Max pages<input type="number" defaultValue={12} min={1} max={50} /></label><label>Quality<input type="number" defaultValue={92} min={1} max={100} /></label></div>}</>}{formError && <p role="alert" className="error-text">{formError}</p>}<div className="dialog-actions"><button type="button" onClick={() => setModal(null)}>Cancel</button><button className="primary" type="submit"><Plus /> {modal === 'page' ? 'Add page' : 'Start capture'}</button></div><p className="demo-caption">Demo only · No live task will be created</p></form>}
    </Dialog>}
  </div>;
}

export default function App() {
  const [variant, setVariant] = useState<Variant>(() => new URLSearchParams(location.search).get('v') === '2' ? 1 : 0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState('');
  const [currentScreen, setCurrentScreen] = useState('workspace');
  const [modalOpen, setModalOpen] = useState(false);
  const changeVariant = (next: Variant) => { if (modalOpen && next === 0) setCurrentScreen('preview'); setVariant(next); setModalOpen(false); const url = new URL(location.href); url.searchParams.set('v', String(next + 1)); history.replaceState(null, '', url); };
  useEffect(() => { fetch('/fixtures.json').then(response => { if (!response.ok) throw new Error('Snapshot unavailable.'); return response.json(); }).then(setJobs).catch(error => setError(error.message)); }, []);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === '1' || event.key === '2') changeVariant(Number(event.key) - 1 as Variant);
      else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); changeVariant(variant === 0 ? 1 : 0); }
    };
    document.addEventListener('keydown', handle); return () => document.removeEventListener('keydown', handle);
  }, [variant, modalOpen]);
  return <><div className="exploration-bar"><span><SlidersHorizontal /> Design exploration <span className="exploration-divider">/</span> {names[variant]}</span><span className="exploration-safety">Isolated demo · Original tasks unchanged</span>{variant === 0 && <div className="baseline-tabs"><button aria-pressed={currentScreen === 'workspace'} onClick={() => setCurrentScreen('workspace')}>Workspace</button><button aria-pressed={currentScreen === 'preview'} onClick={() => setCurrentScreen('preview')}>Image review</button></div>}</div><div className="exploration-stage">{variant === 0 ? <div className="current-baseline"><img src={`/current-${currentScreen}.jpg`} width={1920} height={1080} alt={`Current ${currentScreen} interface, unmodified screenshot at 1920 by 1080`} /><span className="baseline-label">Current · Recorded interface</span></div> : jobs.length ? <Proposed key={variant} initialJobs={jobs} variant={variant} onVariant={changeVariant} onModal={setModalOpen} initialPreview={currentScreen === 'preview' ? 1998 : null} /> : <div className="loading" role="status">{error || 'Loading local snapshot...'}</div>}</div>{!modalOpen && <Picker value={variant} onChange={changeVariant} />}</>;
}

