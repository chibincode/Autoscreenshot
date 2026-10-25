# Section Motion Capture

Screenshot previews expose Screenshot / Motion tabs in Classic and New. Motion is a companion MP4, not a replacement image. Eagle import still imports the screenshot only; MP4 can be played or downloaded separately.

## Local Setup

- Install Website Motion Capture next to Autoscreenshot, or set `MOTION_CAPTURE_PROJECT_DIR` to its absolute directory.
- Optional `MOTION_CAPTURE_NODE` selects the Node executable for its CLI. Otherwise the Autoscreenshot server's Node executable is reused.
- `MOTION_STUDIO_URL` and `STUDIO_STATE_DIR` are handled by Motion Capture's existing CLI.
- Use an updated Motion Capture build supporting `--target-json` and `--viewport-height`. Restart its server only after existing jobs finish.
- Credentials remain inside the local CLI; the browser receives no Agent token or filesystem path.

## Recording Contract

- New section screenshots persist selector, detected bounds and viewport in `motionAnchor`.
- Older screenshots recover anchors from the matching manifest's selected detector candidates, in detector order (not sorted by vertical position).
- Scroll mode resolves the CSS selector against the live page and records the section; Stay mode holds that position while time-based animation runs. Missing or ambiguous selectors fail, rather than silently falling back to another section.
- Manual mode accepts an explicit 0-100% page scroll range. Settings allow 5-30 seconds, with 1920 x 1080, 60 fps, high-quality MP4 output.
- Recording is submitted with a durable idempotency key. Motion Capture owns the queue even when the preview closes. Autoscreenshot resumes reconciliation after restart.
- Completed, verified MP4/poster files are copied to `<asset-directory>/.motion/<asset-id>/<recording-id>/`. `state.json` preserves attempts and the latest successful result. Retrying never deletes previous exports or the screenshot.
- Local cleanup is blocked during active recording. Recording submission and cleanup share a job file lock. Normal History cleanup removes companion files along with screenshots.
- MP4 is served through the same-origin API with byte-range support. Only recorded result paths inside Motion Capture's output directory can be copied.

## Verification

`tests/asset-motion.test.ts` covers legacy anchor matching, validation, duplicate submission, persistence/restart, cancellation, service failure, output ownership, and media byte ranges. Existing server API tests protect import and history behavior.

Cross-site motion fidelity is not guaranteed by file verification. Inspect representative frames and browser playback. Inflight's finite entrance animations require the section clock to complete `Animation.finished`; legacy recording paths retain their original clock behavior.

### Local Trial: 2026-10-22

- Screenshot job `Fv9l_QACmsoJ`, feature asset `2130`, source `https://inflight.co/`, selector `#features`.
- Companion recording `aaca6833-43c7-4de9-b70c-6af231f5fe1d`; Motion Capture task `ff544b34-8cff-49f2-9406-5253b8e3b0f7`, export `studio-run-1792646030380-af2366`.
- Verified 10 seconds, 1920 x 1080, 60 fps, 600 frames, 1,155,005 bytes. Live range: approximately y=1600 to y=6108 CSS pixels. No page errors or broken images in preflight.
- Representative frames confirm the sticky demo appears and changes content. Native browser playback and pointer seeking to 5 seconds passed. Classic/New, screenshot switching, and 1920/900/390px preview layouts checked in Codex's in-app browser.
- The initial trial exposed the missing animation-completion callback; both attempts remain preserved. The latest successful attempt is used in the asset preview.
