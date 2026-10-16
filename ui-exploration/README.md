# Current / Proposed exploration

Standalone, local-only comparison. Production source, routes, databases, original images, and existing prototype/ files are not modified.

## Run

From the repository root:

```sh
./node_modules/.bin/vite --config ui-exploration/vite.config.ts
```

Open http://127.0.0.1:5201/?v=2. The strict, loopback-only port is separate from 5173, 8787, and the existing 5199 prototype.

## Comparison

- Current: actual 1920x1080 screenshots captured during the preceding review. Workspace and image-review views are recorded, not interactive replicas.
- Proposed: interactive UI using static copies of 25 actual screenshots from four local jobs, with Loops selected by default.
- The bottom picker and keys 1/2 switch directions. Arrow keys switch outside text fields; image minimap keys retain their own behavior.
- The snapshots are not live data. Runtime reads only local fixtures and image files. There are no API proxies or application write calls.

## Interactive Scope

Task search/filter, Queue/History, undoable history move, selection, grid/list, full-page overview, local folder choice, activity, new-capture and add-page forms, preview, minimap, in-memory crop/restore, single-region annotation, and clipboard feedback.

Import and rescan are explicitly simulated. Capture creates a local queued item, never starts a browser. Crop applies only to a reduced-resolution demo image and is not the production lossless-original pipeline. Refresh or direction switching resets proposed state. No original screenshot, Eagle item, or task record is changed.

The layout tuning button exposes card width and preview height. Values are provisional, not promoted design tokens.

## Materials And Direction

### Visual Revision, 2026-10-15

User feedback: interaction changes are acceptable, but the initial flat visual direction changed the UI style too much. The proposed workflow remains an experiment; its first visual skin is rejected.

`current-skin.css` restores the production palette, canvas, rounded panel geometry, pill actions, soft card shadows, and modal treatment. It is isolated to this preview; the formal app is untouched. The compact Queue and image-first interactions remain. Desktop 1920x1080, 900x900, and 390x844 were checked again; no horizontal overflow, overlapping grid rows, or new console errors. Evidence: /private/tmp/autoscreenshot-proposed-original-style.jpg and /private/tmp/autoscreenshot-original-style-mobile-crop.jpg. Production adoption still requires approval.

### Spacing Revision, 2026-10-15

Proposed only: screenshot cards now have 16px desktop insets, a 16px image-to-description gap, an 8px title-to-folder gap, and a 44px folder field with 12px horizontal content insets. Folder controls retain the same geometry on hover. Queue heading, search, filter, and rows share aligned edges. Inspector section spacing follows a 24px rhythm, with compact mobile overrides. Verified real hover, folder-dialog open/close, equal field heights, grid/list containment, and 900px/390px responsive layouts. No original app files or data changed. Evidence: /private/tmp/autoscreenshot-proposed-spacing-card.jpg and /private/tmp/autoscreenshot-proposed-spacing-desktop.jpg.

### Creation Entry Revision, 2026-10-15

New capture is now a full-width primary button below the sidebar heading and above search, outside the scrollable task list. Desktop header duplication is removed. At narrow widths, the list uses the sidebar button and the detail view uses a compact header fallback: exactly one visible creation entry in each view. Both use the existing local-only form. Verified 1920x1080, 900x900, 390x844; mouse and Enter activation; Escape dismissal and focus return. TypeScript and Vite build passed, with no browser console warnings/errors. Evidence: /private/tmp/autoscreenshot-proposed-new-capture-sidebar.jpg.

### Clarity Revision, 2026-10-15

Proposed only: opaque neutral surfaces, deeper metadata text, explicit hover edges, and a stronger blue task-selection ring. The existing rounded geometry, spacing, shadows, and dark primary buttons remain. Unselected screenshots retain their original colors. Dialog dismissal now requires a press and release outside the dialog bounds, avoiding accidental dismissal when dragging inside it. See [clarity-audit.md](clarity-audit.md) for token changes and acceptance evidence.

Panel boundary follow-up: only the Queue and main workspace shells have a 1px white gradient stroke, bright at the upper left and fading toward the lower right. Layered padding-box/border-box backgrounds own the stroke; the old inset highlight is removed to avoid a double edge. Existing outer shadows and internal controls are unchanged. Checked 1920x1080, 1200x900, 390x844 and desktop scrolling with no horizontal overflow or console errors. Evidence: `/private/tmp/autoscreenshot-proposed-panel-stroke-desktop.jpg` and `/private/tmp/autoscreenshot-proposed-panel-stroke-mobile.jpg`.

### UI Polish Follow-Up, 2026-10-15

Approved Proposed-only refinements: card outer radius remains 20px; thumbnail radius now follows outer radius minus the actual inset (grid: 4px desktop / 8px mobile, list: 10px). Screenshot frames use one inset 1px pure-black 10% outline, without altering image files. Command buttons use scale .96 with a 150ms ease-out transition; task rows, image triggers, tabs, folder fields/options, and segmented modes remain static. Reduced-motion mode disables the press scale. Existing color/hover transitions remain 130ms. The temporary Current/Proposed picker, including its mobile overlap, is deliberately unchanged at the user's request.

Checked grid/list rendering, 1920x1080, 900x900 and 390x844 layouts, file-folder open/close, and keyboard activation of New capture. No screenshot data or formal app source was changed. Browser animation-frame inspection was unavailable; held-press visual capture and 10%-speed replay are not verified. Evidence: `/private/tmp/autoscreenshot-proposed-polish-desktop.jpg`, `/private/tmp/autoscreenshot-proposed-polish-list.jpg`, and `/private/tmp/autoscreenshot-proposed-polish-mobile.jpg`.

### Emil Visual Detail Pass, 2026-10-15

Using Emil UI Polish and Surfaces under the existing Designer Boyce direction: page filters now have a persistent white active pill; their 225.38x40px footprint stays unchanged when switching. The view toggle uses concentric pill geometry. Image select/rescan controls share 40px desktop / 44px mobile targets, a neutral shadow, and consistent centering. Primary icons are 16px with a 2px stroke. Card shadows have restrained crisp/ambient layers and a 150ms shadow-only hover transition. Counters and crop values use tabular numerals; 44px crop inputs and their unit suffixes share the same vertical center.

Existing colors, main panel white strokes, card insets/radii, navigation, native scrollbars, task data and temporary comparison chrome are retained. No new capture, crop application or import was performed. Grid/list, active page filters, hover, 1920x1080, 900x900 and 390x844, and mobile crop actions were inspected. Sampled text contrast remained above 4.5:1 in the checked list view. Evidence: `/private/tmp/autoscreenshot-emil-desktop.jpg`, `/private/tmp/autoscreenshot-emil-list.jpg`, `/private/tmp/autoscreenshot-emil-mobile.jpg`, and `/private/tmp/autoscreenshot-emil-crop-mobile.jpg`. Slow-motion/held-press replay remains outside verified coverage.

- Designer Boyce owns hierarchy and review boundaries; Emil prototype/foundations guidance supplies the isolated comparison and craft checks.
- Current axis: persistent creation rail, large Queue cards, expanded task status, technical inspector.
- Proposed axis: on-demand creation, compact task navigation, image-first review, progressive technical details.
- Keeps the existing native macOS font stack, neutral surfaces, blue selection, green success, and the production ImageMinimap component (read-only import).
- Tradeoff: fewer metadata fields visible at once, and an extra action to open creation or technical details.
- No direction has been accepted for production. No permanent taste or memory record is written.

## Fixture Preparation

`prepare.mjs` uses GET requests only against the running 8787 API and reads original screenshot paths to generate local resized copies. It also copies the recorded review screenshots from /private/tmp. Generated fixtures, screenshots, and dist output are ignored by Git.

```sh
node ui-exploration/prepare.mjs
```

## Verification

- Standalone strict TypeScript check and Vite build passed.
- Six production minimap unit tests passed. Fresh final-browser load, preview open/close, and focus wrap produced no console warnings or errors.
- Real Codex in-app browser inspected at 1920x1080, 900x900, and 390x844. Grid rows do not overlap; no horizontal page overflow; narrow task details begin near the viewport top instead of after the entire Queue.
- Exercised direction switching; selected count; task/folder search; folder assignment; grid/list and overview; layout-tuning controls; image review; minimap End; modal focus wrapping; in-memory remove-section crop (14386 -> 11508 px) and restore; region drag and feedback entry; simulated import; history move/undo; invalid and valid capture URLs; queued-task cancel; same-domain add-page validation.
- The Current image view is a recorded desktop baseline, not a responsive version. Proposed is the responsive interaction candidate.
- Clipboard permission/grant and operating-system clipboard content were not verified. No real capture, Eagle import, or file deletion was performed.
- Acceptance images: /private/tmp/autoscreenshot-comparison-current.jpg, /private/tmp/autoscreenshot-proposed-desktop.jpg, /private/tmp/autoscreenshot-proposed-preview.jpg, /private/tmp/autoscreenshot-proposed-narrow.jpg, /private/tmp/autoscreenshot-proposed-mobile-crop.jpg.
