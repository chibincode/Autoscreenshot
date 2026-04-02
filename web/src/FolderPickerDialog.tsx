import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { EagleFolderOption, RankedEagleFolderOption } from "./folder-picker";

interface FolderPickerDialogProps {
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

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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
        className="folder-picker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="folder-picker-modal-header">
          <div className="folder-picker-modal-copy">
            <strong id={titleId}>选择目标文件夹</strong>
            <p id={descriptionId}>
              {assetLabel} · {assetKind}
              {assetSectionType ? ` · ${assetSectionType}` : ""}
            </p>
          </div>
          <button type="button" className="folder-picker-close" onClick={onClose} disabled={pending}>
            关闭
          </button>
        </div>

        <div className="folder-picker-context">
          {currentPath ? (
            <div className="folder-picker-context-row">
              <span>当前</span>
              <strong title={currentPath}>{currentPath}</strong>
            </div>
          ) : null}
          {suggestedPath && suggestedPath !== currentPath ? (
            <div className="folder-picker-context-row">
              <span>建议</span>
              <strong title={suggestedPath}>{suggestedPath}</strong>
            </div>
          ) : null}
        </div>

        <div className="folder-picker-search-shell">
          <input
            ref={inputRef}
            type="search"
            className="folder-picker-search"
            placeholder="搜索文件夹名称或完整路径"
            value={query}
            disabled={pending}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <span className="folder-picker-search-status">{pending ? "保存中..." : `${results.length} 个结果`}</span>
        </div>

        <div className="folder-picker-results" role="listbox" aria-label="Eagle folder options">
          {results.length > 0 ? (
            results.map((option, index) => {
              const isActive = index === activeIndex;
              return (
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
                    option.isSuggested ? "folder-picker-option-suggested" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={pending}
                  onMouseEnter={() => onActiveIndexChange(index)}
                  onFocus={() => onActiveIndexChange(index)}
                  onClick={() => onSelectFolder(option.folder)}
                >
                  <div className="folder-picker-option-copy">
                    <strong>{option.folder.name}</strong>
                    <span title={option.folder.path}>{option.folder.path}</span>
                  </div>
                  <div className="folder-picker-option-tags">
                    {option.isCurrent ? <span className="folder-picker-tag folder-picker-tag-current">当前</span> : null}
                    {option.isSuggested ? (
                      <span className="folder-picker-tag folder-picker-tag-suggested">建议</span>
                    ) : null}
                  </div>
                </button>
              );
            })
          ) : (
            <div className="folder-picker-empty">
              <strong>没有匹配到文件夹</strong>
              <span>试试更短的关键词，或者改搜路径里的父级目录。</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
