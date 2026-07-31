import { Fragment, useEffect, useMemo, useState } from "react";
import { ActionDialog } from "../ActionDialog";
import { ActionToast } from "../ActionToast";
import {
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  Button,
  type ButtonVariant,
} from "../ui/Button";
import { PreviewFrame, SpecSection } from "./SpecSection";
import {
  DESIGN_SYSTEM_SECTIONS,
  type DesignSystemSectionId,
} from "./sectionRegistry";
import "./design-system.css";

const COLOR_TOKENS = [
  { name: "canvas", role: "App background" },
  { name: "panel", role: "Primary panel" },
  { name: "surface", role: "Elevated surface" },
  { name: "surface-soft", role: "Control surface" },
  { name: "text", role: "Primary text" },
  { name: "text-muted", role: "Secondary text" },
  { name: "accent-blue", role: "Selection / focus" },
  { name: "warm-text", role: "Destructive intent" },
] as const;

const CONTROL_TOKENS = [
  { name: "--control-height-sm", value: "34px", role: "Dense action rows" },
  { name: "--control-height-md", value: "38px", role: "Default actions" },
  { name: "--control-height-lg", value: "46px", role: "Primary submit" },
  { name: "--control-radius", value: "999px", role: "Action silhouette" },
] as const;

function useLiveTokens(names: readonly string[]): Record<string, string> {
  const [tokens, setTokens] = useState<Record<string, string>>({});

  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    setTokens(Object.fromEntries(names.map((name) => [name, styles.getPropertyValue(`--${name}`).trim()])));
  }, [names]);

  return tokens;
}

function formatVariantLabel(variant: ButtonVariant): string {
  return variant.charAt(0).toUpperCase() + variant.slice(1);
}

export function DesignSystemPage() {
  const [activeId, setActiveId] = useState<DesignSystemSectionId>("colors");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dangerDialogOpen, setDangerDialogOpen] = useState(false);
  const [toastOpen, setToastOpen] = useState(false);
  const tokenNames = useMemo(() => COLOR_TOKENS.map((token) => token.name), []);
  const liveTokens = useLiveTokens(tokenNames);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          setActiveId(visible[0].target.id as DesignSystemSectionId);
        }
      },
      { rootMargin: "-72px 0px -64% 0px", threshold: 0 },
    );

    DESIGN_SYSTEM_SECTIONS.forEach((section) => {
      const element = document.getElementById(section.id);
      if (element) {
        observer.observe(element);
      }
    });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!toastOpen) {
      return undefined;
    }
    const timer = window.setTimeout(() => setToastOpen(false), 2400);
    return () => window.clearTimeout(timer);
  }, [toastOpen]);

  const groupedSections = useMemo(() => {
    return DESIGN_SYSTEM_SECTIONS.reduce<Record<string, typeof DESIGN_SYSTEM_SECTIONS[number][]>>(
      (groups, section) => {
        (groups[section.group] ??= []).push(section);
        return groups;
      },
      {},
    );
  }, []);

  return (
    <div className="design-system-page">
      <header className="ds-header">
        <a className="ds-header__back" href="/" aria-label="Back to Autoscreenshot Console">
          <span aria-hidden="true">←</span>
          <span>Autoscreenshot</span>
        </a>
        <span className="ds-header__badge">Internal · Design System</span>
        <div className="ds-header__status">
          <span className="ds-live-dot" aria-hidden="true" />
          Production-backed
        </div>
      </header>

      <div className="ds-shell">
        <aside className="ds-sidebar" aria-label="Design System sections">
          <div className="ds-sidebar__intro">
            <span>Action System</span>
            <strong>Version 1.0</strong>
          </div>
          <nav className="ds-nav">
            {Object.entries(groupedSections).map(([group, sections]) => (
              <div className="ds-nav__group" key={group}>
                <span className="ds-nav__group-label">{group}</span>
                {sections.map((section) => (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    className={activeId === section.id ? "active" : undefined}
                    aria-current={activeId === section.id ? "location" : undefined}
                  >
                    {section.label}
                  </a>
                ))}
              </div>
            ))}
          </nav>
          <div className="ds-sidebar__rule">
            <span>Rule 01</span>
            <p>Catalog examples must render production components.</p>
          </div>
        </aside>

        <main className="ds-main">
          <section className="ds-hero" aria-labelledby="ds-title">
            <div>
              <span className="ds-kicker">Foundational framework</span>
              <h1 id="ds-title">Action System v1</h1>
              <p>
                A production-backed reference for Autoscreenshot controls, feedback, and action recipes.
                Promoted decisions flow into the Console through shared components and tokens.
              </p>
            </div>
            <div className="ds-hero__contract">
              <span>Source contract</span>
              <strong>One primitive</strong>
              <p>Console and catalog consume the same Button implementation.</p>
            </div>
          </section>

          <div className="ds-principles" aria-label="System principles">
            <div><span>01</span><strong>Semantic</strong><p>Choose by intent, not color.</p></div>
            <div><span>02</span><strong>State complete</strong><p>Loading and disabled are first-class.</p></div>
            <div><span>03</span><strong>Production-backed</strong><p>No duplicate showcase markup.</p></div>
          </div>

          <SpecSection
            id="colors"
            title="Semantic colors"
            description="Live values read from the Console root tokens. Product components should consume roles, not raw hex values."
          >
            <div className="ds-color-grid">
              {COLOR_TOKENS.map((token) => (
                <div className="ds-color-token" key={token.name}>
                  <div className="ds-color-token__swatch" style={{ background: `var(--${token.name})` }} />
                  <strong>{token.role}</strong>
                  <code>--{token.name}</code>
                  <span>{liveTokens[token.name] || "Live CSS value"}</span>
                </div>
              ))}
            </div>
          </SpecSection>

          <SpecSection
            id="typography"
            title="Typography"
            description="The system keeps the native macOS stack and uses weight, scale, and spacing to establish hierarchy."
          >
            <div className="ds-type-specimens">
              <div className="ds-type-row ds-type-row--display"><span>Display</span><strong>Fast capture, calm review.</strong><code>32 / 1.12 · 650</code></div>
              <div className="ds-type-row ds-type-row--title"><span>Title</span><strong>Core Pages</strong><code>22 / 1.25 · 650</code></div>
              <div className="ds-type-row ds-type-row--body"><span>Body</span><strong>All pages processed and ready for review.</strong><code>14 / 1.5 · 400</code></div>
              <div className="ds-type-row ds-type-row--label"><span>Label</span><strong>PRODUCTION COMPONENT</strong><code>11 / 1.2 · 700</code></div>
            </div>
          </SpecSection>

          <SpecSection
            id="control-scale"
            title="Control scale"
            description="Three deliberate heights replace the accidental 30–46px spread. Pill radius is reserved for actions."
          >
            <div className="ds-control-scale">
              {CONTROL_TOKENS.map((token) => (
                <div className="ds-control-token" key={token.name}>
                  <div className="ds-control-token__measure" style={{ minHeight: token.name.includes("height") ? token.value : "38px" }}>
                    {token.value}
                  </div>
                  <div><strong>{token.role}</strong><code>{token.name}</code></div>
                </div>
              ))}
            </div>
          </SpecSection>

          <SpecSection
            id="buttons"
            title="Buttons"
            description="The shared production primitive. Variants encode intent; sizes encode density; loading preserves the final-label footprint."
          >
            <div className="ds-component-contract">
              <div><span>Source</span><code>web/src/ui/Button.tsx</code></div>
              <div><span>Variants</span><strong>{BUTTON_VARIANTS.length}</strong></div>
              <div><span>Sizes</span><strong>{BUTTON_SIZES.length}</strong></div>
              <div><span>Keyboard</span><strong>Native button</strong></div>
            </div>

            <div className="ds-button-matrix" role="table" aria-label="Button variants and sizes">
              <div className="ds-button-matrix__corner" />
              {BUTTON_SIZES.map((size) => <span className="ds-button-matrix__heading" key={size}>{size}</span>)}
              {BUTTON_VARIANTS.map((variant) => (
                <Fragment key={variant}>
                  <div className="ds-button-matrix__label">
                    <strong>{formatVariantLabel(variant)}</strong>
                    <code>variant=&quot;{variant}&quot;</code>
                  </div>
                  {BUTTON_SIZES.map((size) => (
                    <div className="ds-button-matrix__cell" key={`${variant}-${size}`}>
                      <Button variant={variant} size={size}>{formatVariantLabel(variant)}</Button>
                    </div>
                  ))}
                </Fragment>
              ))}
            </div>

            <PreviewFrame label="State matrix" note="Hover, press, and Tab through the live controls.">
              <div className="ds-button-states">
                <div><span>Default</span><Button variant="primary">Import selected</Button></div>
                <div><span>Disabled</span><Button variant="primary" disabled>Import selected</Button></div>
                <div><span>Loading</span><Button variant="primary" loading loadingLabel="Queueing…">Import selected</Button></div>
                <div><span>Blocked</span><Button variant="primary" data-blocked="true">Fix folders</Button></div>
              </div>
            </PreviewFrame>

            <div className="ds-usage-grid">
              <div className="ds-usage ds-usage--do"><span>Do</span><p>Use one primary action per decision area.</p></div>
              <div className="ds-usage ds-usage--avoid"><span>Avoid</span><p>Do not use danger styling for reversible navigation.</p></div>
            </div>
          </SpecSection>

          <SpecSection
            id="feedback"
            title="Dialog & toast"
            description="These scenarios mount the same ActionDialog and ActionToast used by the Console, with local illustrative data only."
          >
            <div className="ds-feedback-grid">
              <PreviewFrame label="Confirmation" note="Shared production dialog">
                <div className="ds-feedback-demo">
                  <span className="ds-feedback-demo__icon">?</span>
                  <div><strong>Protect irreversible actions</strong><p>Confirm before restoring or removing user work.</p></div>
                  <Button size="sm" onClick={() => setDialogOpen(true)}>Open dialog</Button>
                </div>
              </PreviewFrame>
              <PreviewFrame label="Destructive confirmation" note="Danger tone is explicit">
                <div className="ds-feedback-demo">
                  <span className="ds-feedback-demo__icon ds-feedback-demo__icon--warm">!</span>
                  <div><strong>State the consequence</strong><p>The confirm action uses the danger variant.</p></div>
                  <Button variant="danger" size="sm" onClick={() => setDangerDialogOpen(true)}>Preview danger</Button>
                </div>
              </PreviewFrame>
              <PreviewFrame label="Toast" note="Shared production feedback">
                <div className="ds-feedback-demo">
                  <span className="ds-feedback-demo__icon ds-feedback-demo__icon--success">✓</span>
                  <div><strong>Confirm background results</strong><p>Brief, non-blocking, and announced politely.</p></div>
                  <Button size="sm" onClick={() => setToastOpen(true)}>Show toast</Button>
                </div>
              </PreviewFrame>
            </div>
          </SpecSection>

          <SpecSection
            id="job-actions"
            title="Job detail actions"
            description="Production recipe: order actions by task priority, keep status facts outside the button group, and use one primary action."
          >
            <PreviewFrame label="Production recipe" note="The Console consumes these same Button variants.">
              <div className="ds-job-recipe">
                <div className="ds-job-recipe__summary">
                  <div><span>Job</span><strong>incident.io · Core Pages</strong></div>
                  <span className="ds-status-pill ds-status-pill--review">Needs review</span>
                </div>
                <div className="ds-job-recipe__actions">
                  <Button variant="primary" size="sm">Import selected</Button>
                  <Button size="sm">Rescan Core Pages</Button>
                  <Button size="sm">Archive</Button>
                  <Button variant="danger" size="sm">Clean files</Button>
                  <span className="ds-job-recipe__facts">Pending 11 · Imported 0 · Failed 0</span>
                </div>
              </div>
            </PreviewFrame>
          </SpecSection>

          <SpecSection
            id="asset-toolbar"
            title="Asset toolbar"
            description="Production recipe: keep page-level recovery next to the asset import control so scope and consequence are visible together."
          >
            <PreviewFrame label="Production recipe" note="Core page card toolbar">
              <div className="ds-asset-recipe">
                <div className="ds-asset-recipe__header">
                  <div><span className="ds-status-pill ds-status-pill--success">Success</span><strong>Home</strong></div>
                  <code>/ · fullPage</code>
                </div>
                <div className="ds-asset-recipe__toolbar">
                  <label><input type="checkbox" defaultChecked /> Import</label>
                  <Button size="sm">Rescan page</Button>
                </div>
                <div className="ds-asset-recipe__media" aria-hidden="true">
                  <div /><div /><div />
                </div>
              </div>
            </PreviewFrame>
          </SpecSection>

          <SpecSection
            id="boundaries"
            title="System boundaries"
            description="A foundation stays useful when it says what is shared now and what remains a separate product surface."
            eyebrow="Governance"
          >
            <div className="ds-boundary-list">
              <div className="ds-boundary-row">
                <div><strong>Web Console</strong><p>Queue, detail, asset review, dialog, and toast.</p></div>
                <span className="ds-maturity ds-maturity--promoted">Promoted</span>
                <code>Action System v1</code>
              </div>
              <div className="ds-boundary-row">
                <div><strong>Browser Extension</strong><p>Popup controls keep their own runtime and density requirements.</p></div>
                <span className="ds-maturity ds-maturity--planned">Phase 2</span>
                <code>Audit before sharing</code>
              </div>
              <div className="ds-boundary-row">
                <div><strong>Media & crop controls</strong><p>Preview triggers and crop handles are not generic buttons.</p></div>
                <span className="ds-maturity ds-maturity--separate">Separate primitive</span>
                <code>Do not coerce</code>
              </div>
            </div>
          </SpecSection>

          <footer className="ds-footer">
            <strong>Action System v1</strong>
            <span>Built from Autoscreenshot production tokens and components.</span>
          </footer>
        </main>
      </div>

      <ActionDialog
        open={dialogOpen}
        title="Restore the original image?"
        description="This removes the current crop and cannot be undone."
        confirmLabel="Restore original"
        cancelLabel="Keep crop"
        onCancel={() => setDialogOpen(false)}
        onConfirm={() => setDialogOpen(false)}
      />
      <ActionDialog
        open={dangerDialogOpen}
        title="Clean local files?"
        description="The job history remains, but local captures will be removed."
        confirmLabel="Clean files"
        cancelLabel="Cancel"
        tone="danger"
        onCancel={() => setDangerDialogOpen(false)}
        onConfirm={() => setDangerDialogOpen(false)}
      />
      <ActionToast open={toastOpen} message="Page queued for rescan" tone="success" />
    </div>
  );
}
