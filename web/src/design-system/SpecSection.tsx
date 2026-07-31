import type { ReactNode } from "react";

interface SpecSectionProps {
  id: string;
  title: string;
  description: string;
  eyebrow?: string;
  children: ReactNode;
}

export function SpecSection({
  id,
  title,
  description,
  eyebrow = "Promoted",
  children,
}: SpecSectionProps) {
  return (
    <section id={id} className="ds-section">
      <div className="ds-section__heading">
        <div>
          <span className="ds-section__eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
        </div>
        <p>{description}</p>
      </div>
      <div className="ds-section__surface">{children}</div>
    </section>
  );
}

interface PreviewFrameProps {
  label: string;
  note?: string;
  children: ReactNode;
  className?: string;
}

export function PreviewFrame({ label, note, children, className }: PreviewFrameProps) {
  return (
    <div className={["ds-preview", className].filter(Boolean).join(" ")}>
      <div className="ds-preview__meta">
        <strong>{label}</strong>
        {note ? <span>{note}</span> : null}
      </div>
      <div className="ds-preview__stage">{children}</div>
    </div>
  );
}
