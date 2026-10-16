# Classic / New Interfaces

## Behavior

- The formal web app has a Classic / New switch. Classic is the default for a fresh browser or an invalid/unavailable preference.
- An explicit choice is remembered in `localStorage` under `autoscreenshot.interfaceVersion.v1`, separately for each browser origin. No task or server configuration is stored in this preference.
- Both interfaces render the same App instance, current selection, task data, live events, and action handlers. Switching does not create, rerun, import, clean, archive, crop, or delete anything.
- Task and asset deep links are unchanged. Switching inside an image preview keeps the selected asset and unsaved crop/annotation state.
- New capture uses the existing controlled creation form in a native modal. Draft inputs survive closing the modal and switching interfaces. Escape closes the modal and restores focus.
- New provides a two-column workspace, Queue / History navigation, page selection filters, grid/list layout, and a full-page overview. Narrow screens use Back to tasks navigation rather than squeezing both columns.
- Capture, import, folder selection, retry, add-page, history, logs, manifest, crop, annotation, and minimap actions reuse their original implementation and server-side restrictions.
- The isolated `ui-exploration` comparison is not the formal New interface and is unchanged by this integration.

## Boundaries

Interface code lives in `web/src/WorkspaceChrome.tsx`, `web/src/interface-version.ts`, and scoped `web/src/workspace-versions.css`. Classic retains the original styles. New styles are scoped under `.layout-new`; only the version switch is shared chrome.

No database schema, screenshot pipeline, import pipeline, API contract, or existing task files are migrated by the interface switch. Do not key App or PreviewModal by interface version: that would reset their state.

## Verification

- Unit coverage: safe defaults, preference persistence/storage failures, controlled version buttons, real page counts, and lossless route-asset metadata lookup.
- Existing server API tests use temporary data and mocked capture/import services, not the real user's jobs.
- In-app browser checks: 1920 x 1080 desktop, 900px tablet, and 390px mobile; Classic default; preference after reload; selected job and asset URL preservation; unsaved crop coordinates and new-capture draft preservation; folder picker; Section/Core Pages; History; list/grid/overview; responsive containment.
- Do not apply a crop, import to Eagle, rescan, or clean a real task merely to test presentation parity. Verify destructive/write paths using isolated server tests.
- Existing strict App type diagnostics predate this integration. The new UI modules and the server TypeScript build are checked independently; the web build remains the production bundling check.
