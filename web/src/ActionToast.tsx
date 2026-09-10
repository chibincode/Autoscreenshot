export type ActionToastTone = "success" | "info";

interface ActionToastProps {
  open: boolean;
  message: string;
  tone?: ActionToastTone;
  actionLabel?: string;
  onAction?: () => void;
}

export function ActionToast({
  open,
  message,
  tone = "success",
  actionLabel,
  onAction,
}: ActionToastProps) {
  if (!open) {
    return null;
  }

  const hasAction = Boolean(actionLabel && onAction);

  return (
    <div
      className={`action-toast-layer${hasAction ? " action-toast-layer-actionable" : ""}`}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className={`action-toast action-toast-${tone}`}>
        <span className="action-toast-dot" aria-hidden="true" />
        <span>{message}</span>
        {actionLabel && onAction ? (
          <button type="button" className="action-toast-action" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
