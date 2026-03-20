# AGENTS.md

## UI Verification Rules

- For web UI work, always open the browser at a desktop viewport of `1920x1080` before evaluating layout.
- After any UI or styling change, verify the result in a real browser instead of relying on code inspection alone.
- Capture at least one screenshot during verification and visually inspect it before concluding the task.
- Do not finalize a web UI change if the desktop `1920px` width layout has not been checked.
- If a change is intended to affect responsive behavior, check both `1920px` desktop width and at least one narrower viewport.

## Error Explanation Rules

- Every time an error happens, explain the reason in plain language before or alongside the technical diagnosis.
- Keep the explanation concise, but make it clear what actually failed, why it failed, and what category the problem belongs to.
- Prefer explanations that help build product and engineering intuition, so the user can better understand how to work with AI on R&D tasks.
