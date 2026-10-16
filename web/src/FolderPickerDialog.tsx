import { Fragment, useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Folder, Check, X } from "lucide-react";
import type { EagleFolderOption, RankedEagleFolderOption } from "./folder-picker";

interface FolderPickerDialogProps {
  newAppearance?: boolean;
  selectionSource?: string;
  open: boolean;
  assetLabel: string;
  assetKind: "fullPage" | "section";
  assetSectionType: string | null;
  currentPath: string | null;
  suggestedPath: string | null;
  query: string;
  results: RankedEagleFolderOption[];
  activeIndex: number;
  pending: boolean;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onActiveIndexChange: (index: number) => void;
  onSelectFolder: (folder: EagleFolderOption) => void;
}

export function FolderPickerDialog({
  newAppearance = false,
  selectionSource = "auto",
  open,
  assetLabel,
  assetKind,
  assetSectionType,
  currentPath,
  suggestedPath,
  query,
  results,
  activeIndex,
  pending,
  onClose,
  onQueryChange,
  onActiveIndexChange,
  onSelectFolder,
}: FolderPickerDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousFocus = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [onClose, open, pending]);

  useEffect(() => {
    if (!open || results.length === 0) {
      return;
    }
    optionRefs.current[activeIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [activeIndex, open, results]);

  if (!open) {
    return null;
  }

  const activeOption = results[activeIndex] ?? null;

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (results.length > 0) {
        onActiveIndexChange(Math.min(activeIndex + 1, results.length - 1));
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length > 0) {
        onActiveIndexChange(Math.max(activeIndex - 1, 0));
      }
      return;
    }

    if (event.key === "Enter" && activeOption && !pending) {
      event.preventDefault();
      onSelectFolder(activeOption.folder);
    }
  };

  return (
    <div className="folder-picker-modal-backdrop" onClick={pending ? undefined : onClose}>
      <div
        ref={dialogRef}
        className={`folder-picker-modal${newAppearance ? " folder-picker-new" : ""}`}
        onKeyDown={event => {
          if (event.key !== "Tab") return;
          const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []);
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="folder-picker-modal-header">
          <div className="folder-picker-modal-copy">
            <strong id={titleId}>{newAppearance ? "Choose destination" : "选择目标文件夹"}</strong>
            <p id={descriptionId}>
              {assetLabel} · {assetKind}
              {assetSectionType ? ` · ${assetSectionType}` : ""}
            </p>
          </div>
          <button type="button" className="folder-picker-close" aria-label={newAppearance ? "Close folder picker" : "关闭"} onClick={onClose} disabled={pending}>
            {newAppearance ? <X size={16} /> : "关闭"}
          </button>
        </div>

        <div className="folder-picker-context">
          {currentPath ? (
            <div className="folder-picker-context-row">
              <span>{newAppearance ? `Current destination · ${selectionSource === "manual" ? "Manual" : selectionSource === "auto" ? "Auto" : "Pending"}` : "当前"}</span>
              <strong title={currentPath}>{currentPath}</strong>
            </div>
          ) : null}
          {suggestedPath && suggestedPath !== currentPath ? (
            <div className="folder-picker-context-row">
              <span>{newAppearance ? "Suggested" : "建议"}</span>
              <strong title={suggestedPath}>{suggestedPath}</strong>
            </div>
          ) : null}
        </div>

        <div className="folder-picker-search-shell">
          <input
            ref={inputRef}
            type="search"
            className="folder-picker-search"
            aria-label={newAppearance ? "Search folders" : "搜索文件夹"}
            placeholder={newAppearance ? "Search folder name or path" : "搜索文件夹名称或完整路径"}
            value={query}
            disabled={pending}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <span className="folder-picker-search-status" role="status">{newAppearance ? pending ? "Saving..." : `${results.length} folders` : pending ? "保存中..." : `${results.length} 个结果`}</span>
        </div>

        <div className="folder-picker-results" role="listbox" aria-label="Eagle folder options">
          {results.length > 0 ? (
            results.map((option, index) => {
              const isActive = index === activeIndex;
              const group = option.isCurrent ? "Current" : option.isRecent ? "Recently used" : "All folders";
              const previous = results[index - 1];
              const previousGroup = previous?.isCurrent ? "Current" : previous?.isRecent ? "Recently used" : "All folders";
              return <Fragment key={option.folder.id}>
                {newAppearance && !query.trim() && (index === 0 || group !== previousGroup) ? <div className="folder-picker-group" role="presentation">{group}</div> : null}
                {(
                <button
                  key={option.folder.id}
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  className={[
                    "folder-picker-option",
                    isActive ? "folder-picker-option-active" : "",
                    option.isCurrent ? "folder-picker-option-current" : "",
                    option.isRecent ? "folder-picker-option-recent" : "",
                    option.isSuggested ? "folder-picker-option-suggested" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={pending}
                  onMouseEnter={() => onActiveIndexChange(index)}
                  onFocus={() => onActiveIndexChange(index)}
                  onClick={() => onSelectFolder(option.folder)}
                >
                  {newAppearance ? <Folder size={16} aria-hidden="true" /> : null}
                  <div className="folder-picker-option-copy">
                    <strong>{option.folder.name}</strong>
                    <span title={option.folder.path}>{option.folder.path}</span>
                  </div>
                  <div className="folder-picker-option-tags">
                    {option.isCurrent ? <span className="folder-picker-tag folder-picker-tag-current">{newAppearance ? "Current" : "当前"}</span> : null}
                    {option.isRecent ? (
                      <span className="folder-picker-tag folder-picker-tag-recent">{newAppearance ? "Recent" : "最近"}</span>
                    ) : null}
                    {option.isSuggested ? (
                      <span className="folder-picker-tag folder-picker-tag-suggested">{newAppearance ? "Suggested" : "建议"}</span>
                    ) : null}
                  </div>
                  {newAppearance && option.isCurrent ? <Check size={16} aria-hidden="true" /> : null}
                </button>
              )}</Fragment>;
            })
          ) : (
            <div className="folder-picker-empty">
              <strong>{newAppearance ? "No matching folders" : "没有匹配到文件夹"}</strong>
              <span>{newAppearance ? "Try a shorter name or part of the folder path." : "试试更短的关键词，或者改搜路径里的父级目录。"}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
