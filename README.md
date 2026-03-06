# Autoscreenshot Web App

本项目现在同时支持两种使用方式：

- Web 控制台（本地 `localhost`）：任务提交、队列、历史筛选、详情、日志、重试导入
- CLI：`autosnap "<instruction>"` 与 `autosnap retry-import <manifestPath>`

截图能力仍基于 Playwright，导入能力仍基于 Eagle 本地 API。

## 技术栈

- Backend: Node.js + TypeScript + Fastify
- Queue: 进程内异步队列（默认并发 `1`）
- Storage: SQLite (`./data/autoscreenshot.db`)
- Frontend: React + Vite + TypeScript
- Capture: Playwright (JPG only)

## 快速开始

```bash
npm install
npx playwright install chromium
```

开发模式（前后端同时启动）：

```bash
npm run dev
```

打开：

- Web 控制台: `http://127.0.0.1:5173`（Vite 开发服务器）
- API 服务: `http://127.0.0.1:8787`

生产构建并运行：

```bash
npm run build
npm start
```

打开：

- `http://127.0.0.1:8787`

## 核心特性

- 默认截图输出 `JPG`，可配置质量（默认 `92`）
- `dpr=auto`：优先 `2x`，超阈值或异常自动回退 `1x`
- section 混合切割：`hero, feature, testimonial, pricing, team, faq, blog, cta, contact, footer`
- `classic` 模式支持多 feature 输出（默认最多 3 张），其它类别默认每类最多 1 张
- section 导出窗口固定为 `1920x1080`（`dpr=2` 时产物为 `3840x2160`）
- 执行时统一强制 viewport 为 `1920x1080`（非 1920 输入会自动修正并记录日志）
- `classic` 模式默认最多输出 `10` 张，可通过任务参数覆盖
- 新增 `core-routes` 模式：自动发现同域核心路由并输出 fullPage 长图（默认最多 12 路由）
- `core-routes` 路由截图默认先尝试 `2x`，遇到可重试错误时自动降为 `1x` 再试一次
- 支持路由级重试：`POST /api/jobs/:jobId/retry-route`（只重跑单一路由，不重跑整任务）
- Debug 联动：在任务详情点击 `section` 图片可聚焦到对应 Debug 记录（fullPage 显示整页提示）
- 每次任务生成 `manifest.json`，并记录 Eagle 导入结果
- 支持任务级 `retry-import`
- Eagle 导入仅复用已有文件夹，不自动创建新文件夹
- 支持 `section` 与 `fullPage` 的 `folderId` 全局映射配置（`data/eagle-folder-rules.json`）

## API (v1)

- `GET /api/config`
- `POST /api/jobs`
- `GET /api/jobs`
- `GET /api/jobs/:jobId`
- `GET /api/jobs/:jobId/events` (SSE)
- `POST /api/jobs/:jobId/retry-import`
- `POST /api/jobs/:jobId/retry-route`
- `GET /api/assets/:assetId/file`

## CLI

```bash
npm run autosnap -- "打开 https://example.com 抓 full page 和 section 图"
npm run autosnap -- "open https://example.com only section, hero and footer" --section-scope manual --quality 95
npm run autosnap -- "open https://example.com and capture sections" --max-sections 8
npm run autosnap -- "open https://example.com and map core routes" --mode core-routes --max-routes 12
npm run autosnap -- retry-import ./output/<run_id>/manifest.json
```

## 配置

复制 `.env.example` 到 `.env`，可设置：

- `HOST`（默认 `127.0.0.1`）
- `PORT`（默认 `8787`）
- `EAGLE_API_BASE_URL`（默认 `http://localhost:41595`）
- `EAGLE_API_TOKEN`（可选）
- `OPENAI_API_KEY`（可选，用于 LLM 指令解析）
- `OPENAI_BASE_URL`（可选）
- `OPENAI_MODEL`（可选）
- `NOTION_API_KEY`（rules 同步到 Notion 必填）
- `NOTION_RULES_DATABASE_ID`（已存在库时填写）
- `NOTION_RULES_PARENT_PAGE_ID`（无库时用于自动创建数据库）
- `NOTION_RULES_DATABASE_TITLE`（默认 `Autoscreenshot Rules Registry`）
- `NOTION_RULES_OWNER_USER_ID`（可选）
- `NOTION_RULES_JSON_PATH`（默认 `./output/rules/rules-registry.json`）

Eagle 文件夹映射配置：

- 文件：`data/eagle-folder-rules.json`
- 映射目标使用 `folderId`（稳定，不受改名影响）
- 若映射缺失、歧义或未命中：自动导入 Eagle 根目录

## Rules Registry（统一规则表）

本项目支持把三层规则导出并同步到 Notion 单数据库：

- `section_classifier`：`src/browser/section-detector.ts`
- `fullpage_classifier`：`src/core/fullpage-classifier.ts`
- `eagle_mapping`：`data/eagle-folder-rules.json`

命令：

```bash
npm run rules:export
npm run rules:sync:notion
npm run rules:refresh
```

输出文件：

- `output/rules/rules-registry.json`
- `output/rules/rules-registry.csv`

同步策略：

- 以 `Rule ID` 为唯一键 upsert（存在则更新，不存在则创建）
- 不自动删除 Notion 数据
- 本地缺失但远端存在的规则会标记为 `deprecated`

## 测试

```bash
npm test
```

启用截图 E2E：

```bash
RUN_E2E_CAPTURE=1 npm test
```
