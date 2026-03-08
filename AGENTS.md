# AGENTS.md

## UI Verification Rules

- For web UI work, always open the browser at a desktop viewport of `1920x1080` before evaluating layout.
- After any UI or styling change, verify the result in a real browser instead of relying on code inspection alone.
- Capture at least one screenshot during verification and visually inspect it before concluding the task.
- Do not finalize a web UI change if the desktop `1920px` width layout has not been checked.
- If a change is intended to affect responsive behavior, check both `1920px` desktop width and at least one narrower viewport.
