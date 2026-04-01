export type ActionToastTone = "success" | "info";

interface ActionToastProps {
  open: boolean;
  message: string;
  tone?: ActionToastTone;
}

export function ActionToast({ open, message, tone = "success" }: ActionToastProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="action-toast-layer" aria-live="polite" aria-atomic="true">
      <div className={`action-toast action-toast-${tone}`}>
        <span className="action-toast-dot" aria-hidden="true" />
        <span>{message}</span>
      </div>
    </div>
  );
}
