import React, {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

export const BUTTON_VARIANTS = ["primary", "secondary", "danger", "ghost"] as const;
export const BUTTON_SIZES = ["sm", "md", "lg"] as const;

export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];
export type ButtonSize = (typeof BUTTON_SIZES)[number];

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
  block?: boolean;
  children: ReactNode;
}

function joinClasses(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    loadingLabel = "Working…",
    block = false,
    className,
    disabled,
    type = "button",
    children,
    ...props
  },
  ref,
) {
  const unavailable = disabled || loading;

  return (
    <button
      ref={ref}
      type={type}
      className={joinClasses(
        "ui-button",
        `ui-button--${variant}`,
        `ui-button--${size}`,
        block && "ui-button--block",
        className,
      )}
      disabled={unavailable}
      aria-busy={loading || undefined}
      data-loading={loading ? "true" : undefined}
      {...props}
    >
      <span className="ui-button__content">
        <span className="ui-button__label" aria-hidden={loading || undefined}>
          {children}
        </span>
        <span className="ui-button__loading-label" aria-hidden={!loading}>
          <span className="ui-button__spinner" aria-hidden="true" />
          {loadingLabel}
        </span>
      </span>
    </button>
  );
});
