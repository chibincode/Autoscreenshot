import { useEffect, useId } from "react";

export type ActionDialogTone = "default" | "danger";

interface ActionDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ActionDialogTone;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ActionDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "再想想",
  tone = "default",
  pending = false,
  onConfirm,
  onCancel,
}: ActionDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, open, pending]);

  if (!open) {
    return null;
  }

  return (
    <div className="confirm-modal-backdrop" onClick={pending ? undefined : onCancel}>
      <div
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm-modal-copy">
          <strong id={titleId}>{title}</strong>
          <p id={descriptionId}>{description}</p>
        </div>
        <div className="confirm-modal-actions">
          <button type="button" className="confirm-secondary-button" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === "danger" ? "confirm-danger-button" : "confirm-primary-button"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "处理中..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
