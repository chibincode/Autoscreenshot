# Capture Regression Field Log

This log turns real capture feedback into durable product coverage. It is an index of user moments, evidence, decisions, and executable regressions; it is not a changelog and does not replace tests.

## Status vocabulary

- `reported`: A real screenshot problem was reported, but the cause is not yet proven.
- `reproduced`: The failure mechanism has been confirmed with image, DOM, log, or geometry evidence.
- `covered`: A deterministic local regression fixture protects the behavior.
- `site-verified`: The affected live route was recaptured and visually checked.
- `released`: The verified change is committed and present on the target remote branch.

Never promote `queued` or route `success` to `site-verified` without inspecting the new output.

## Current verified cases

Evidence may be either currently reproducible from local artifacts or historical verification from the recent task record. When `Clean Files` has removed captures, the entry must say so and must not imply that the image is still available locally.

### CR-001 Granola homepage was truncated after the second section

- Context: Core Pages capture of `https://www.granola.ai/`, job `1SwrjagqIS5D`, original asset `#1763`.
- Evidence source: Current local manifest plus both the original and targeted-rerun images.
- Symptom: The homepage looked complete at the top but most middle sections were missing.
- Evidence: The document was about `14,015 CSS px` tall, while scroll-scene post-processing treated the whole page as one scene and reduced it to two frames. The original image was `3840 x 6330`.
- Cause: The sticky hero's direct owner was only two viewports tall, but the detector required a 2.5x height ratio and climbed to a page-level ancestor.
- Decision: Accept a near-full-viewport sticky scene when its direct owner is at least two sticky frames tall; keep the scene boundary local.
- Regression: `keeps later page content when a full-viewport sticky scene only owns two viewports` in `tests/e2e.capture.test.ts`.
- Site verification: Targeted homepage rerun produced asset `#1775`, `granola_ai_20260828_160732_fullpage_full_page_q92_dpr2.jpg`, at `3840 x 29992`, including the later feature sections and footer.
- Status: `site-verified`, local changes not yet committed.

### CR-002 Fruitful pricing scroll scene lost normal page content

- Context: Core Pages capture of `https://www.fruitful.com/pricing`, job `rSDl6q_Mp0_u`, original asset `#1706`.
- Evidence source: Recent verified task record. The job record remains, but `Clean Files` removed its manifest and captures on `2026-08-28`.
- Symptom: The scroll-animation page could not be represented cleanly as a full-page still.
- Evidence: A sticky footer-like layout was eligible for scroll-scene replacement even though it was ordinary page/footer structure.
- Cause: Footer ownership and scroll-scene detection used separate selector logic.
- Decision: Share one footer-like selector and exclude footer-owned sticky elements before scroll-scene classification.
- Regression: `keeps page content intact when a full-width footer is sticky` in `tests/e2e.capture.test.ts`.
- Site verification: Before cleanup, the targeted rerun produced asset `#1727` at `3840 x 4508`; the retained content and footer were visually checked.
- Status: `site-verified`, local changes not yet committed.

### CR-003 Daniel Sun project navigation repeated in stitched screenshots

- Context: Core Pages capture of `https://danielsun.space/ruby`, job `1D-D-Kqcx8vV`, original asset `#1720`.
- Evidence source: Recent verified task record. The job record remains, but `Clean Files` removed its manifest and captures on `2026-08-28`.
- Symptom: The top navigation repeated at viewport seams on project detail pages, while the homepage was unaffected.
- Evidence: The navigation used generated Framer classes and was directly `fixed`, so semantic selectors did not identify it.
- Cause: Top-overlay discovery depended too heavily on recognizable tags and class names.
- Decision: Inspect all body descendants for direct `fixed` or `sticky` positioning, then retain the existing geometry and visibility guards.
- Regression: `keeps a generic fixed Framer navigation only in the first viewport` in `tests/e2e.capture.test.ts`.
- Site verification: Targeted `/ruby` rerun produced asset `#1728`; repeated navigation was absent.
- Status: `site-verified`, local changes not yet committed.

### CR-004 Flat portfolio routes were not classified as project details

- Context: Core Pages capture of `https://danielsun.space/dibsy`, job `6vsUHI-R0E2H`, asset `#1734`.
- Evidence source: Recent verified API and test record. The job record remains, but `Clean Files` removed its manifest and captures on `2026-08-28`.
- Symptom: A visually obvious project detail page fell back to the general page folder because `/dibsy` has no structural URL prefix.
- Evidence: The page title contains strong project signals, while the path alone is ambiguous.
- Cause: Full-page classification only used URL patterns for unmatched flat routes.
- Decision: Use page-title evidence as a bounded fallback for single-segment paths, while excluding generic service, platform, branding, and solution pages.
- Regression: Positive and negative flat-route cases in `tests/fullpage-classifier.test.ts`.
- Site verification: `/dibsy` and the other detected Daniel Sun project routes resolve to `作品包装/网站/Page_Project Detail` in the local API.
- Status: `site-verified`, local changes not yet committed.

## Existing executable coverage

The current E2E suite already protects these capture families:

| Family | Protected behavior | Representative reports |
| --- | --- | --- |
| Fixed top chrome | Navigation, announcements, reading progress, and table-of-contents controls appear once | CoreWeave, Incident.io, Giga, Daniel Sun |
| Fixed bottom chrome | Region selectors and compact CTAs appear only at the page bottom | Samsara, ianneo |
| Fixed side badges | Narrow side badges appear once | Khasiyev / Awwwards badge |
| Consent overlays | Banners, launchers, inline cards, and delayed modals are removed | Jarsy and other cookie controls |
| Render readiness | Delayed hero images, lazy backgrounds, viewport media, and WebGL are settled before capture | Aave, Bevel, Incident.io |
| Scroll scenes | Standalone and split sticky scenes unfold without deleting adjacent or later content | Fruitful, Granola |
| Footer reveals | Transformed and sticky footers keep their final visual state without replacing page content | Vercel/footer reports and Fruitful |

Full local verification on 2026-08-28: `32 passed`, `7 skipped` in `tests/e2e.capture.test.ts`; server TypeScript build and `git diff --check` passed.

## Evidence backlog

These reports are visible in recent product use, but this log does not yet claim a current live-site revalidation for each one.

| Case | Evidence anchor | Classification | Next proof needed |
| --- | --- | --- | --- |
| Aave hero illustration missing | job `wR0PIfzqhehR`, asset `#958` | render readiness | Recheck current output against the live hero after the readiness fixture passes |
| Bevel careers YouTube poster gray | job `8OnB88aYsHPN`, asset `#898` | video/embed readiness | Confirm poster or thumbnail fallback on a targeted rerun |
| Incident.io careers lower page incomplete | job `2TK62CytjZXS`, asset `#1369` | render readiness / page height | Compare live document height and final image height |
| CoreWeave navigation repeated | job `asDCPGw8lU3-`, asset `#1075` | fixed top chrome | Revalidate with current generic fixed-navigation rule |
| Samsara region selector repeated | job `wm2G0zdTxrUM`, asset `#1392` | fixed bottom chrome | Revalidate the final slice only |
| Jarsy cookie launcher repeated | job `cRK858kX2Z-t`, asset `#1420` | consent overlay | Revalidate CookieScript launcher removal |
| Khasiyev Awwwards badge repeated | job `ElIVE9YccM2U`, asset `#1438` | fixed side badge | Revalidate the first-slice-only result |
| Giga navigation and progress chrome repeated | jobs `bFtaticbBFbf` / `fPBYjAshDEVv`, assets `#1499` / `#1509` | fixed top / reading chrome | Revalidate both list and detail layouts |
| ianneo bottom navigation repeated | job `JfYbqqYU9OBA`, asset `#1569` | fixed bottom chrome | Revalidate bottom-navigation geometry |
| Aave `/brand` routed to a general page | job `CPaUpRco9GAZ`, asset `#957` | full-page classification | Confirm Brand Kit folder resolution |
| CoreWeave `/case-studies` routed generically | job `gTZ5dnKwPut4`, asset `#1167` | full-page classification | Confirm Customer List resolution |
| Feldar `/download` routed generically | job `F4zfRfPDXf8t`, asset `#1144` | full-page classification | Confirm Download page resolution |
| Legal pages included in Core Pages | job `d8FUoAAqz3SI`, asset `#1224` | route discovery | Confirm legal-route exclusion without hiding valid policy/design references elsewhere |

## Entry contract

Every future capture fix should add or update one case with:

- Context: route, job, and asset.
- Symptom: the user's visible problem.
- Evidence: image dimensions, DOM geometry, logs, or network/media state.
- Cause: confirmed mechanism, not the first plausible guess.
- Decision: the narrow rule and its boundary.
- Regression: a deterministic test name.
- Site verification: the new asset and visual result.
- Status: one of the vocabulary states above.

## Next action slice

1. Link each future user report to an existing case or create a new case before changing heuristics.
2. Require the targeted regression plus the full capture E2E suite before promotion to `site-verified`.
3. Backfill the evidence backlog through targeted reruns, starting with render-readiness cases because missing content has the highest output risk.
