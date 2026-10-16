# Proposed Clarity Audit

Date: 2026-10-15. Scope: the isolated 5201 preview, not the formal application.

## Diagnosis

Several metadata roles measured about 3.3-4.5:1 against their rendered surfaces. Similar translucent panel, card, and hover backgrounds weakened grouping. Unselected screenshots were also desaturated, making selection state look like poor screenshot quality.

## Color Changes

Declarations live in `current-skin.css`. Neutral hue/chroma remain restrained; text lightness carries most of the correction.

| Role | Before | After |
| --- | --- | --- |
| Panel | `rgba(248,250,252,.94)` | `oklch(.984 .003 247.9)` |
| Card | `rgba(255,255,255,.88)` | `oklch(1 0 0)` |
| Quiet control | `rgba(239,242,246,.9)` | `oklch(.960 .006 255.5)` |
| Hover fill | Various barely different grays | `oklch(.925 .006 255.5)` |
| Secondary text | `#69707a` and hard-coded variants | `oklch(.430 .018 257.2)` |
| Subtle text | Hard-coded pale gray variants | `oklch(.500 .022 257.5)` |
| Disabled text | `#828994` | `oklch(.520 .018 259.4)` |
| Disabled surface | `#e6e9ee` | `oklch(.933 .007 260.7)` |
| Control edge | White inner highlight | `oklch(.325 .045 255.2 / .12)` |
| Hover edge | Inconsistent | `oklch(.325 .045 255.2 / .28)` |
| Success text | `#258049` | `oklch(.460 .120 152.6)` |
| Warning text | `#836423` | `oklch(.450 .090 82.6)` |
| Error text | `#b53e46` | `oklch(.470 .154 20.2)` |
| Selected task | 1px blue ring at .24 alpha | 2px ring at .65, .85 on hover |

Canvas `#e6eaf0`, main text `#17191d`, and primary dark gradients are retained. Generic hover rules exclude primary, selected, and active controls. Primary hover keeps white text on a dark gradient. Disabled states use explicit colors rather than reducing opacity. Small inspector captions were raised to 12px.

## Acceptance

- Real Codex in-app browser: 1920x1080, 900x900, 390x844. No horizontal document overflow in the checked Proposed views.
- Inspected Queue, selected/unselected cards, folder fields, page actions, History empty state, Activity, layout tuning, import confirmation, new-capture advanced/error state, image preview, crop, and annotation.
- Exercised real mouse hover on primary/secondary actions, folder options, and task rows. Checked selected versus unselected controls, disabled import/crop actions, and invalid URL validation without creating a task.
- Sampled enabled text pairs were at least about 5.7:1 after the change; secondary roles were about 7.2-7.7:1. Primary hover measured about 10.5:1 at the lighter gradient stop. No sampled text pair in the checked views was below 4.5:1.
- Contrast sampling composites rendered ancestor backgrounds; it is not a full accessibility certification or an audit of screenshot image content. Disabled controls and the separate comparison picker are excluded from the text sample.
- Internal dialog drag no longer dismisses; outside backdrop click still dismisses. Escape was exercised. No original screenshot, task record, or Eagle item was changed.
- Strict standalone TypeScript check and Vite build passed.

Screenshots:

- `/private/tmp/autoscreenshot-clarity-desktop.jpg`
- `/private/tmp/autoscreenshot-clarity-preview.jpg`
- `/private/tmp/autoscreenshot-clarity-folder-hover.jpg`
- `/private/tmp/autoscreenshot-clarity-narrow.jpg`
- `/private/tmp/autoscreenshot-clarity-mobile.jpg`
- `/private/tmp/autoscreenshot-clarity-mobile-preview.jpg`
- `/private/tmp/autoscreenshot-clarity-mobile-crop.jpg`

The comparison is still a static-data experiment. Production integration requires separate approval.
