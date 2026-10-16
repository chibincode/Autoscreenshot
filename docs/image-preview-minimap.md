# Screenshot overview navigation

## Behavior

- Reference: UIBook's `src/components/WebsiteDetailModal.tsx` page overview interaction.
- Long screenshots show an always-visible, proportional overview at the image pane's bottom-right, with a highlighted visible region. Short images that fit the pane omit it.
- Clicking centers that image location. Dragging preserves the grab offset, captures the pointer outside the overview, and clamps at the first/last image position.
- Main-image scrolling and resizing update the viewport indicator. Measurements include image-pane padding, not just the image's nominal dimensions.
- The same component works in preview, crop, and annotation modes. Navigation changes neither crop coordinates nor annotation data.
- Keyboard: arrows, Page Up/Down, Home and End. The control exposes a vertical slider and scroll percentage to assistive technology.
- Overview size is bounded by the pane height; the full screenshot is contained without distortion. Image dimensions reserve layout during loading. No screenshot file or Eagle import changes are involved.

## Verification (2026-10-14)

- Six geometry tests cover proportional sizing, scroll/padding alignment, click centering, drag boundaries, short images and extreme aspect ratios.
- Existing annotation/feedback/button tests also pass: 21 related tests in total.
- In-app browser: Linktree job `H98pAKfmo9C7`, asset `#2045`, checked at `1920 x 1080` and `900 x 900`; narrower annotation geometry checked at `600 x 900`.
- Verified click, drag beyond the map, keyboard start/end, wheel synchronization, crop range preservation, and annotation-mode navigation without added marks. Asset `#2052` confirms short-image hiding. No browser console warnings/errors at final desktop inspection.
- Evidence: `/private/tmp/autoscreenshot-minimap-desktop.jpg`, `/private/tmp/autoscreenshot-minimap-narrow.jpg`, `/private/tmp/autoscreenshot-minimap-annotation.jpg`.
- During QA, old agent-created local tabs retained EventSource connections and original-image loading queued. Closing those old QA tabs restored loading; user tabs were retained.
