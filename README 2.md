# Autoscreenshot

AI-driven browser screenshot assistant that captures `full page + classic sections` as JPG and imports them into Eagle through local API.

## Features

- Natural-language CLI: `autosnap "<instruction>"`
- Output format is always JPG (`type: jpeg`)
- Default quality `92` with override via `--quality`
- Default DPR policy `auto` (prefer `2x`, fallback to `1x` by pixel threshold or retry)
- Section segmentation for classic blocks: `hero, feature, testimonial, pricing, faq, blog, footer`
- Eagle local API import with `manifest.json` persistence and `retry-import`

## Requirements

- Node.js `>=18`
- Eagle app running locally with API enabled (default `http://localhost:41595`)
- Chromium runtime for Playwright:

```bash
npx playwright install chromium
```

## Install

```bash
npm install
npm run build
```

You can run directly in dev mode:

```bash
npm run autosnap -- "打开 https://example.com 抓 full page 和 section 图"
```

Or install globally in this repo:

```bash
npm link
autosnap "open https://example.com full page + hero + testimonial"
```

## Usage

```bash
autosnap "<instruction>" [options]
autosnap retry-import <manifestPath>
```

Options:

- `--quality <1-100>`: JPG quality, default `92`
- `--dpr <auto|1|2>`: default `auto`
- `--section-scope <classic|all-top-level|manual>`: default `classic`
- `--output-dir <path>`: default `./output`

### Examples

```bash
autosnap "打开 https://stripe.com，抓 full page 和 hero、testimonial，标签: marketing,landing"
autosnap "open https://example.com only section, hero and footer" --section-scope manual --quality 95
autosnap retry-import ./output/example_com_20260301_190000/manifest.json
```

## Output

Each run writes to:

- `output/<domain>_<timestamp>/`
- Images:
  - `{domain}_{yyyyMMdd_HHmmss}_fullpage_full_page_q{quality}_dpr{dpr}.jpg`
  - `{domain}_{yyyyMMdd_HHmmss}_section_{label}_q{quality}_dpr{dpr}.jpg`
- `manifest.json` with import status per file

## Environment

Copy `.env.example` to `.env` if needed:

- `EAGLE_API_BASE_URL` (default `http://localhost:41595`)
- `EAGLE_API_TOKEN` (optional)
- `OPENAI_API_KEY` (optional, for LLM parsing fallback to rule parser if absent)
- `OPENAI_BASE_URL` (optional)
- `OPENAI_MODEL` (optional)

## Tests

```bash
npm test
```

Optional browser E2E tests:

```bash
RUN_E2E_CAPTURE=1 npm test
```

## Notes

- First version supports JPG only.
- The tool does not automate clicking Eagle browser extension UI. It captures with Playwright and imports via Eagle API.
