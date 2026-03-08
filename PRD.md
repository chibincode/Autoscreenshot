# Autoscreenshot PRD

## 1. Product Summary

Autoscreenshot 是一个本地运行的网页截图工作台。

它的核心价值是：

- 根据自然语言指令自动打开网页并截图
- 自动切分常见 landing page section
- 自动发现官网核心路由并批量输出长图
- 自动导入 Eagle，并按规则分配到对应文件夹

产品形态：

- 本地 Web App
- CLI
- 本地 Playwright + Eagle API + SQLite

当前定位不是通用爬虫，也不是云端截图服务，而是一个给设计、产品、增长、品牌研究场景使用的“网页采集与归档工具”。

## 2. Target Users

主要用户：

- 设计师：收集竞品页面、归档 section 灵感
- 产品经理：快速保存核心页面结构和路由快照
- 品牌/增长团队：批量沉淀官网、博客、定价、FAQ 等页面
- 独立开发者：把网站截图自动归档到 Eagle

## 3. Problems To Solve

当前真实要解决的问题：

1. 手动截图效率低  
2. 同一个网站有很多核心页面，手动点开很耗时  
3. 截图后整理和归档成本高  
4. landing page 的 section 分类容易混乱，后续复用困难  
5. 截图文件技术命名可读性差，导入 Eagle 后浏览体验不好

## 4. Product Goals

当前版本目标：

1. 用一句自然语言快速发起截图任务  
2. 对单页输出：
   - fullPage 长图
   - section 图
3. 对官网输出：
   - 自动发现核心路由
   - 批量抓 fullPage 长图
4. 所有结果可在 Web 控制台查看、筛选、重试  
5. 所有结果可直接进入 Eagle，且文件夹映射稳定  
6. Eagle 中的 fullPage 名称使用网页原始标题，而不是技术文件名

## 5. Non-Goals

当前版本明确不做：

- 云端部署
- 多用户协作
- 批量 CSV 导入
- AI 视觉识别 / OCR
- 自动点击 Eagle 浏览器插件
- 通用站点登录态管理平台

## 6. Core Workflows

### A. Single URL

用户输入一条自然语言指令，例如：

`open https://example.com and capture sections`

系统执行：

1. 解析 URL / quality / dpr / section scope
2. 打开页面并等待加载
3. 输出 fullPage 与 section
4. 写入 manifest
5. 导入 Eagle
6. 在 Web 控制台展示日志、缩略图、调试信息

### B. Core Routes

用户输入官网地址并选择 `core-routes` 模式。

系统执行：

1. 发现同域导航与核心页面链接
2. 按官网模板优先级排序
3. 逐路由输出 fullPage 长图
4. 路由级失败可单独重试
5. 导入 Eagle

## 7. Current Feature Set

### Capture

- JPG only
- 默认质量 `92`
- `dpr=auto`：优先 `2x`，超阈值或异常回退 `1x`
- fullPage 支持长图
- section 固定导出为 `1920x1080`

### Section Detection

当前支持类型：

- hero
- feature
- testimonial
- pricing
- team
- faq
- blog
- cta
- contact
- footer

当前规则特征：

- DOM 结构候选
- 关键词 / 强短语 / 位置 / 几何 / 控件数量
- 冲突消解
- classic 模式 clip 去重
- feature 在 classic 下最多输出 3 张

### Web Console

- 新建任务
- 队列状态
- 历史任务
- 任务详情
- 日志流
- 重试导入
- 重试单一路由
- section debug 联动查看

### Eagle Integration

- 使用 Eagle 本地 API
- 支持 `section` / `fullPage` 文件夹映射
- 失败不丢图，保留本地 manifest
- fullPage 导入名称使用网页原始 `<title>`

## 8. Product Rules And Defaults

- 服务仅监听本机
- 默认队列并发为 `1`
- 默认输出目录为 `./output`
- 默认 section scope 为 `classic`
- classic 默认最多输出 `10` 张
- core-routes 默认最多发现 `12` 条路由
- 不自动创建 Eagle 文件夹，只导入现有 folderId 映射

## 9. Success Criteria

当前阶段判断产品是否成立，主要看：

1. 用户能稳定完成从“输入网址”到“进入 Eagle”的闭环  
2. core-routes 能覆盖大多数官网核心页面  
3. section 分类对常见 landing page 足够可用  
4. 导入后的命名、文件夹、预览体验是可读的  
5. 失败任务可以重试，不需要人工重新做整轮操作

## 10. Current Risks

当前仍然存在的产品风险：

1. section 分类仍是规则引擎，复杂页面会误判  
2. 核心路由发现依赖站内导航质量  
3. 不读视觉内容时，对图像型页面理解有限  
4. Eagle 文件夹映射需要持续维护  
5. 页面标题虽然更易读，但不同站点可能存在重复标题

## 11. Near-Term Roadmap

下一阶段优先级建议：

1. 继续提升 section 准确率  
2. 增强 core-routes 的路由发现质量  
3. 在 Web 控制台中增加更强的结果筛选与对比  
4. 补充产品级文档、规则表、命名规范  
5. 逐步建立截图质量回归样本
