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

### CR-005 Glide's scroll-activated AI composer repeated in full-page captures

- Context: Core Pages capture of `https://www.glideapps.com/`, job `U7aA3G9cDOGQ`, original asset `#1776`.
- Evidence source: Original and targeted-rerun images, capture logs, and live DOM inspection.
- Symptom: The bottom "Describe what you want to build" composer was pasted into each stitched viewport.
- Evidence: The initial retry asset `#1788` repeated the input across the page. The composer becomes a visible input inside a zero-height `position: sticky; bottom: 0` anchor only after scrolling.
- Cause: Bottom-overlay detection ran only before the first scroll, when the anchor was not yet pinned.
- Decision: Re-scan bottom overlays after each stabilized scroll. Keep normal fixed CTAs only on the final slice, but hide detected sticky composers on every slice.
- Regression: `removes a zero-height sticky AI composer from every stitched slice` in `tests/e2e.capture.test.ts`, alongside the existing fixed-bottom selector and CTA cases.
- Site verification: Targeted homepage rerun produced asset `#1789`, `glideapps_com_20260901_185848_fullpage_full_page_q92_dpr2.jpg`; the repeated composer is absent, and the capture log records `bottom_sticky_composer_hidden count=1`.
- Status: `site-verified`, local changes not yet committed.

### CR-006 General Intelligence Company's anonymous Cookie Banner repeated in stitched slices

- Context: Core Pages capture of `https://www.generalintelligencecompany.com/about`, job `SOjXdE_2J82g`, original asset `#1791`.
- Evidence source: Original and targeted-rerun images, capture logs, and live DOM geometry inspection.
- Symptom: The "A few cookies, so things grow and flow just right" bar was pasted into every stitched viewport.
- Evidence: The banner's outer container has `position: fixed` and a zero-height client rect; the visible card is an absolutely positioned descendant. It also has no cookie-specific id, class, ARIA role, or semantic control at the relevant container level.
- Cause: Consent discovery only considered named or semantic overlay candidates, and its visibility check discarded the zero-height fixed shell before inspecting its visible descendants.
- Decision: Find strong consent text, promote only its fixed, sticky, or modal ancestor, and use the union of visible descendant bounds when that owner has a zero client rect. Remove the owner rather than interacting with the site's consent preference.
- Regression: `removes anonymous fixed cookie banners without semantic hooks` in `tests/e2e.capture.test.ts`.
- Site verification: Targeted `/about` rerun produced asset `#1808`, `generalintelligencecompany_com_20260902_105326_fullpage_full_page_q92_dpr2.jpg`; the Cookie Banner is absent from all five stitched slices. The capture log records one `generic` consent overlay removal before capture.
- Status: `site-verified`, local changes not yet committed.

### CR-007 General Intelligence Company's compact navigation repeated in stitched slices

- Context: Core Pages capture of `https://www.generalintelligencecompany.com/about`, job `SOjXdE_2J82g`, asset `#1808` after consent cleanup.
- Evidence source: Asset `#1808`, live DOM geometry inspection, capture logs, and targeted-rerun image.
- Symptom: The centered top navigation repeated in later stitched viewports.
- Evidence: The fixed semantic `<nav>` is `441px` wide at a `1920px` capture viewport, or about `23%` of page width.
- Cause: Generic top-overlay handling required an overlay to span at least `35%` of the page width. That protects small fixed controls but excludes compact desktop navigation.
- Decision: Allow a top-pinned semantic `<nav>` or `role="navigation"` to qualify from `180px` wide; non-semantic fixed elements retain the existing `35%` width threshold.
- Regression: `keeps a compact semantic navigation only in the first viewport` in `tests/e2e.capture.test.ts`.
- Site verification: Targeted `/about` rerun produced asset `#1809`, `generalintelligencecompany_com_20260902_110531_fullpage_full_page_q92_dpr2.jpg`; the navigation appears once in the first slice, and the log records `top_overlay_hidden_for_tiles count=1`.
- Status: `site-verified`, local changes not yet committed.

### CR-008 Writing routes were not treated as Blog pages

- Context: Core Pages capture of `https://www.generalintelligencecompany.com/writing`, job `sR37-QAKbDPw`, asset `#1813`.
- Evidence: `/writing` is the site's content index and article URLs are direct children of that path, but the shipped folder rules only recognized `/blog`.
- Cause: Core-route scoring and full-page classification treated `writing` as a generic path, so it could neither receive blog coverage priority nor resolve to the Blog List and Blog Detail folders.
- Decision: Recognize the bounded `/writing` alias: the root plus pagination/tag paths are Blog List, while a direct child is Blog Detail. Give the alias the same discovery priority as `/blog`; do not infer broader aliases such as `/learn` or `/resources` without separate evidence.
- Regression: `treats writing as a blog list and its direct entries as blog details` in `tests/fullpage-classifier.test.ts` and `plans writing as one blog list and one blog detail family` in `tests/core-routes-service.test.ts`.
- Status: `covered`, awaiting a fresh Core Pages run.

### CR-009 General Intelligence Company's sticky Hero card shifted upward

- Context: Core Pages capture of `https://www.generalintelligencecompany.com/about`, job `sR37-QAKbDPw`, asset `#1811`.
- Evidence: At the `1920 x 1080` capture viewport, the live sticky owner has `top: 400px` and renders at `400px`, while its natural layout offset is `320px`. Asset `#1811` renders it near the natural position instead.
- Cause: Full-page capture changed every sticky element to `position: relative` and cleared its inset before the first slice, preventing repetition but discarding any active sticky offset.
- Decision: Snapshot each sticky element's current viewport coordinates, normalize it to relative positioning, then preserve the resulting x/y difference as a relative visual offset. Process parents before nested sticky children so offsets are not doubled.
- Regression: `preserves a sticky hero card's initial visual position without repeating it` in `tests/e2e.capture.test.ts`.
- Site verification: Targeted `/about` rerun produced asset `#1839`, `generalintelligencecompany_com_20260904_141238_fullpage_full_page_q92_dpr2.jpg`; at `1920 x 1080`, the mission card matches the live `top: 400px` composition and appears only once. The capture log records `sticky_elements_normalized_for_fullpage count=1 positionPreserved=1`.
- Status: `site-verified`, local changes not yet committed.

### CR-010 Calendly's delayed fixed navigation repeated in stitched slices

- Context: Core Pages capture of `https://calendly.com/customers`, job `cCG3A394GqxW`, asset `#1852`.
- Evidence source: Asset `#1852`, live DOM geometry at `1920 x 1080`, and the route manifest.
- Symptom: The desktop navigation appears again in multiple later stitched viewports.
- Evidence: Calendly keeps a fixed navigation clone at `top: -48px; opacity: 0` near the first scroll boundary, then reveals it at `top: 24px; opacity: 1` after deeper scrolling.
- Cause: Top-overlay detection returned a no-op restore function when the first scrolled slice contained no visible candidate. The stitcher treated that as completed detection and never scanned later slices.
- Decision: Return `null` when no top overlay is found so subsequent slices continue scanning; once a visible overlay is found, hide it for all remaining slices.
- Regression: `keeps scanning until a delayed fixed navigation becomes visible` in `tests/e2e.capture.test.ts`.
- Site verification: Targeted `/customers` rerun produced asset `#1858`, `calendly_com_20260904_173013_fullpage_full_page_q92_dpr2.jpg`; the navigation appears only at the page top, with no copies across the customer grid or CTA section. The capture log records `top_overlay_hidden_for_tiles count=1`.
- Status: `site-verified`, local changes not yet committed.

## Existing executable coverage

The current E2E suite already protects these capture families:

| Family | Protected behavior | Representative reports |
| --- | --- | --- |
| Fixed top chrome | Full-width and compact semantic navigation, announcements, reading progress, and table-of-contents controls appear once | CoreWeave, Incident.io, Giga, Daniel Sun, General Intelligence Company |
| Fixed bottom chrome | Region selectors and compact CTAs appear only at the page bottom; sticky AI composers are excluded from every slice | Samsara, ianneo, Glide |
| Fixed side badges | Narrow side badges appear once | Khasiyev / Awwwards badge |
| Consent overlays | Banners, launchers, inline cards, delayed modals, and anonymous zero-height fixed shells are removed | Jarsy, General Intelligence Company, and other cookie controls |
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
