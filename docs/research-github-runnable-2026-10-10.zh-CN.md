# GitHub 成品选型：先完成小范围本地闭环

核查日期：2026-10-10。目标是复用已经实现功能、有真实启动入口的产品，接受部分功能覆盖；本地 Mac + Codex 优先，数据库仍用 Supabase，云端仅做方案研究。

## 结论

**有可用成品。发布管理优先试 Postiz，视频制作优先试 MoneyPrinterTurbo；新闻采集考虑 Miniflux/RSSHub。** 它们能分别提供完整的发布工作台、视频生成工具和采集工具，不必从零重写这些环节。AiToEarn 的整体产品最接近需求，但 MongoDB 和部分平台实现差异使它不适合直接替换当前 Supabase 底座。

这里的“已实现”经过官方代码、运行入口、部署文件、稳定版本或实际调用路径核查。本轮没有安装这些项目，没有在本机运行端到端，没有绑定账号或发布。**上游存在可运行产品、本机部署成功、实际渠道接通、平台确认发表是四个不同结果。** GitHub 星数不作为跑通证据。

未确认任何一个已审查项目能开箱满足“用户定时 prompt → 每次最多 20 个热点问题 → 原件 → 独立平台版本 → 原件更新保留各平台手改 → Web 指令精调 → 独立手动视频 → 全平台历史”。这些差异仍由 Content Studio 实现。

## 适合复用的成品

| 项目 | 已有完整子功能 | 可以省掉的开发 | 当前要求下的缺口 | 建议 |
|---|---|---|---|---|
| [Postiz](https://github.com/gitroomhq/postiz-app) | Web 编稿、图片/视频上传、按渠道编辑、日历、定时发布、历史/失败状态、公开 API | 发布后台与多渠道 API 适配 | 有 YouTube/X/Reddit，未见小红书；需要各平台开发者/OAuth 权限；Supabase 与 Temporal 需配置验证 | **发布管理首选试跑** |
| [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) | Web/API：自定义脚本、本地图片/视频、配音、字幕、MP4、预览下载、任务历史 | 手动视频制作流水线 | 不提供文章原稿联动；默认任务状态不是完整持久队列；发布依赖外部 Upload-Post | **视频功能首选试跑** |
| [Miniflux](https://github.com/miniflux/v2) | RSS 来源 Web 管理、后台定时刷新、全文获取、阅读历史、REST API | 新闻来源管理与持续采集 | PostgreSQL 可接本地 Supabase，但迁移需隔离验证；没有 AI 热点排名、任务 prompt 或文章发布 | **采集成品候选** |
| [RSSHub](https://github.com/DIYgod/RSSHub) | 可运行的多来源 RSS 服务，支持内存缓存 | 特定公开来源的采集适配 | 是来源服务，没有编辑/发布工作台；每条路线仍需验证权限和稳定性 | **按需添加来源** |
| [TrendRadar](https://github.com/sansan0/TrendRadar) | 定时热点/RSS 采集、过滤、AI 简报、HTML 报告、通知、MCP | 热点监测与简报 | 默认 SQLite，与本项目约束冲突；没有完整稿件/发布 CMS | 借鉴调度/筛选，暂不直接落地原栈 |
| [AiToEarn](https://github.com/yikart/AiToEarn) | 完整 Web 素材、图文/视频生成、草稿箱、账号、发布日历/队列 | 最接近整套 AI 内容产品 | MongoDB；部分授权/模型依赖 Relay；未见 Reddit；小红书接口不能证明创建新笔记 | 作为产品参照和外部 API 候选 |

稳定版本核查：[Postiz v2.25.0](https://github.com/gitroomhq/postiz-app/releases/tag/v2.25.0)，[MoneyPrinterTurbo v1.3.8](https://github.com/harry0703/MoneyPrinterTurbo/releases/tag/v1.3.8)，[Miniflux 2.3.3](https://github.com/miniflux/v2/releases/tag/2.3.3)，[AiToEarn v2.5.0](https://github.com/yikart/AiToEarn/releases/tag/v2.5.0)。Postiz/AiToEarn 的当前主分支源码和稳定发布分别检查；未把主分支所有新功能默认归入旧发布制品。安装时固定 tag/commit 和镜像 digest，再验证实际功能。

## 1. Postiz：最值得先验证的发布工作台

官方已有“登录 → 连接渠道 → 写稿/上传素材 → 保存草稿或排期 → 查看结果”的完整 Web 工作流。当前公开 provider 包含 YouTube、X、Reddit，实际调用平台接口；YouTube provider 还有上传及远端状态对账代码。这是成品应用，不是只给界面的模板。[官方快速入门](https://github.com/gitroomhq/postiz-docs/blob/main/general/quickstart.mdx)、[渠道源码](https://github.com/gitroomhq/postiz-app/tree/main/libraries/nestjs-libraries/src/integrations/social)、[YouTube provider](https://github.com/gitroomhq/postiz-app/blob/main/libraries/nestjs-libraries/src/integrations/social/youtube.provider.ts)。

默认部署并不轻：官方 Compose 包含应用、Redis、应用 PostgreSQL、Temporal、Temporal PostgreSQL、Elasticsearch 及管理工具。不能照抄默认栈后说已遵守“数据库用 Supabase”。[官方 Compose](https://github.com/gitroomhq/postiz-docker-compose/blob/main/docker-compose.yaml)。

### 同一个本地 Supabase PostgreSQL 实例的可行配置

Postiz 用 PostgreSQL `DATABASE_URL`；Temporal 支持指定 PostgreSQL host、port、default/visibility 数据库，并可以用 SQL visibility 替代 Elasticsearch。因此，**在同一个本地 Supabase PostgreSQL 实例内预建隔离的逻辑数据库，通过配置连接 Postiz/Temporal，是可行的试验方案；不必额外部署 PostgreSQL 服务，也不必重写发布业务代码。** 这是从上游配置得出的架构推断，尚未实测。逻辑库和服务实例是不同概念。不要将其表述为上游已经提供 Supabase 一键安装。[Prisma 配置](https://github.com/gitroomhq/postiz-app/blob/main/libraries/nestjs-libraries/src/database/prisma/schema.prisma)、[Temporal 1.28.1 配置](https://github.com/temporalio/temporal/blob/v1.28.1/docker/config_template.yaml)、[预建数据库配置](https://github.com/temporalio/docker-builds/blob/main/docker-readme/auto-setup.md)。

需验证：逻辑库创建/owner 权限、容器网络、数据库版本、Temporal schema setup、工作流查询属性、排期和重启恢复；备份也要包含这些逻辑库，不能假定 Content Studio 自身的 Supabase 备份会自动覆盖它们。Postiz 官方 GHCR 提供 v2.25.0 ARM64 制品；Temporal 1.28.1 ARM64 manifest 本轮未确认，其余服务镜像、整体资源占用与 Mac 实测仍需验收。Postiz 默认固定的 Temporal auto-setup 1.28.1 与上游后续版本弃用该镜像的升级路线也需分别记录。[官方镜像](https://github.com/gitroomhq/postiz-app/pkgs/container/postiz-app/)。

这套本地逻辑库方案不能直接推导出 hosted Supabase 一键迁移能力。后续云端须另行选择受支持的数据库布局、继续自托管 Supabase，或外部工作流服务；本轮不启动云端建设。

### 最小验证范围

先验证 Web 媒体上传、草稿修改、日历、历史和一次排期恢复。渠道测试先用已获授权的 YouTube，但 Postiz 的 Web OAuth 客户端/回调需要独立配置，不能认为已有 Desktop OAuth 自动通用。X/Reddit 保留实际权限及内容政策检查，小红书不计入 Postiz 支持。[自托管渠道配置](https://github.com/gitroomhq/postiz-docs/blob/main/self-host/providers/overview.mdx)。

集成后由 Content Studio 保存原件、平台版本、证据与审批快照，通过 Postiz API 发送确定的稿件。每次投稿只能有一个调度所有者，避免两个后台同时发同一内容。若允许在 Postiz 再改正文，需回读成新版本或重新审批；不能继续沿用旧内容的批准。现有 Postiz 适配器的覆盖范围不因本报告扩大。

## 2. MoneyPrinterTurbo：最快验证独立手动视频功能

v1.3.8 已有 Streamlit WebUI 和 FastAPI，支持用户脚本、本地图片/视频、上传旁白、字幕、成片预览/下载与历史。其真实 `task.py` 流水线支持不依赖模型 API key 的小试输入：提供 `video_script`、选本地素材、上传旁白、先关闭字幕、不调用云端音乐服务；这些输入跳过 LLM、素材搜索和 TTS。**可行性已经按该稳定版本源码核查，实际 MP4 渲染尚未在本机测试。** [稳定版 README](https://github.com/harry0703/MoneyPrinterTurbo/blob/v1.3.8/README-en.md)、[输入模型](https://github.com/harry0703/MoneyPrinterTurbo/blob/v1.3.8/app/models/schema.py)、[流水线](https://github.com/harry0703/MoneyPrinterTurbo/blob/v1.3.8/app/services/task.py)。

第一步可以由 Codex 生成经过审核的脚本，再用其现成 Web 页面上传图片/视频和旁白，手动生成视频。后续 Content Studio 调用渲染 API，Supabase 保存输入版本、素材引用、任务及产物。它没有已确认的原生 Codex CLI provider；不能把支持模型 API 当作可直接复用 Codex 订阅。HTTP 上传文件有目录校验，不能直接提交任意 Mac 绝对路径。

默认可不启用 Redis、无需新增业务数据库，但本地文件和进程状态不等于重启后任务恢复。应由 Content Studio 承担持久任务/产物对账。素材、音频和编码实际通过后，再单独验证字幕模型与多语言效果。[配置](https://github.com/harry0703/MoneyPrinterTurbo/blob/v1.3.8/config.example.toml)。

它宣传的发布功能有实现，但调用的是外部 **Upload-Post API**，需要该服务账号、API key 和关联平台；不是直接各平台 OAuth。默认自动发布关闭，其跨平台发布队列重启不恢复。本项目首轮只复用制作/导出，发布仍走明确授权的发布器。[Upload-Post 实现](https://github.com/harry0703/MoneyPrinterTurbo/blob/v1.3.8/app/services/upload_post.py)。

## 3. Miniflux / RSSHub：采集也有成品，但不等于自动选题

Miniflux 已提供来源管理、后台刷新、全文、历史和 REST API。它通过真正的 PostgreSQL `DATABASE_URL` 连接，不是 Supabase HTTP 地址；Mac/ARM64 有运行路径。接本地 Supabase 是合理候选，不需要另建 PostgreSQL 服务。[配置](https://miniflux.app/docs/configuration.html)、[API](https://miniflux.app/docs/api.html)、[Docker](https://miniflux.app/docs/docker.html)。

迁移必须先审查：2.3.3 仍有 `DROP EXTENSION IF EXISTS hstore`，这是数据库范围操作，独立 schema 不能隔离。不能为了跑迁移而随意授予管理员权限。若共享数据库已有相关依赖，须保留它并做最小兼容修改，或采用同实例的隔离逻辑库，再完整验证迁移、权限、备份与后续迁移路线。[固定版本迁移](https://github.com/miniflux/v2/blob/2.3.3/internal/database/migrations.go)。

RSSHub 可以按需部署为内存缓存的来源服务，减少自写采集适配器。官方默认 Compose 还带 Redis/browserless；小试不应无差别启用所有路线。只选经过验证的公开来源，并保留原 URL/时间。[缓存配置](https://github.com/DIYgod/RSSHub/blob/master/lib/config.ts)、[部署配置](https://github.com/DIYgod/RSSHub/blob/master/docker-compose.yml)。

以上采集器不能代替用户任务中的 prompt、指定执行时间、最多 20 个问题、事件合并和独立事实核查。这部分由 Content Studio 消费 feed/API 后执行。常规来源刷新、热榜排序、全球热点判断是不同功能。

## 其他项目为何暂不作为首选

- **AiToEarn**：确有素材 CRUD、生成队列和发布调度，不是空壳；但当前 MongoDB 使用深入数据模型，替换 Supabase 不是换一个连接地址。其 `RedNotePublishProvider.publish()` 要求已有 `workLink` 并读取该作品信息，不能证明创建新笔记；公众号配置标为 `coming_soon`，没有 Reddit provider。整体宣传覆盖不能当作四平台实测覆盖。[部署](https://github.com/yikart/AiToEarn/blob/main/docker-compose.yml)、[小红书源码](https://github.com/yikart/AiToEarn/blob/main/project/aitoearn-backend/apps/aitoearn-server/src/core/channels/platforms/rednote/rednote-publish.provider.ts)、[配置](https://github.com/yikart/AiToEarn/blob/main/project/aitoearn-backend/apps/aitoearn-server/config/config.yaml)。
- **LangChain social-media-agent**：URL 研究、真实模型生成、Agent Inbox 人工编辑/自然语言反馈、定时提交 X/LinkedIn 都有实现；适合参考 Web 指令和人工审核。但同一稿用于两个渠道，发布错误捕获后缺少逐渠道远端 ID/URL 账本，未确认原件联动与手改保护；需要模型/研究 API，不是直接调用本地 Codex。[项目](https://github.com/langchain-ai/social-media-agent)、[人工节点](https://github.com/langchain-ai/social-media-agent/blob/main/src/agents/shared/nodes/generate-post/human-node.ts)、[提交节点](https://github.com/langchain-ai/social-media-agent/blob/main/src/agents/upload-post/index.ts)。
- **Wechatsync**：公开掘金/公众号适配器确实处理图片并保存文章草稿，可用于小范围中文草稿分发。但公开项目包含私有平台适配器子模块，未见公开小红书 adapter，不能把宣传的全部平台当可源码自建。草稿同步也不是公开发表。[项目](https://github.com/wechatsync/Wechatsync)、[子模块](https://github.com/wechatsync/Wechatsync/blob/v2/.gitmodules)、[掘金实现](https://github.com/wechatsync/Wechatsync/blob/v2/packages/core/src/adapters/platforms/juejin.ts)。
- **NewsNow**：已有完整热点 Web 界面，v0.0.42 可审查；默认 Nitro 使用 `better-sqlite3`，`getCacheTable()` 在关闭缓存判断前调用 `useDatabase()`，SQL 也包含 SQLite 专有语句。只设置 `ENABLE_CACHE=false` 不能当作无数据库验收。需要无状态改造或 Supabase 适配；当前 README 还提示停止接受该版本贡献。[项目](https://github.com/newsnext/newsnow)、[固定版本配置](https://github.com/newsnext/newsnow/blob/v0.0.42/nitro.config.ts)、[缓存实现](https://github.com/newsnext/newsnow/blob/v0.0.42/server/database/cache.ts)。
- **Mixpost**：GitHub 为 Lite，完整窄范围编辑/排期可用，但免费源码的渠道是 Twitter/Meta/Mastodon，不能把商业 Pro 的 YouTube/AI 能力算进免费仓库；默认 MySQL，适配收益较低。[项目](https://github.com/inovector/mixpost)、[免费渠道](https://github.com/inovector/mixpost/tree/main/src/SocialProviders)。
- **social-auto-upload**：作者明确 CLI 为主，Web 非主线、不保证同步可运行；不满足本轮现成完整 Web 的优先标准。浏览器检测规避不能证明持续稳定，也不能替代平台授权。[README](https://github.com/dreammis/social-auto-upload)。
- **Short Video Maker**：已有 Web/API/MCP 视频流水线，但当前仅英语配音且不支持上传自己的图片/视频，弱于 MoneyPrinterTurbo 对本需求的匹配度。[项目](https://github.com/gyoridavid/short-video-maker)。

当前许可证：Postiz/RSSHub 为 AGPL-3.0；TrendRadar/Wechatsync 为 GPL-3.0；MoneyPrinterTurbo/AiToEarn/social-media-agent/Mixpost Lite/NewsNow 为 MIT；Miniflux 为 Apache-2.0。复用服务 API、复制代码、修改后提供服务、发行扩展的许可处理不同；产品化时以固定版本 LICENSE 和依赖条款为准。没有把“开源”默认理解成所有服务免费或可以任意闭源分发。

## 推荐的小范围建设顺序

1. **发布管理独立小试**：Postiz + 同一本地 Supabase PostgreSQL + Redis + Temporal SQL visibility。验收 Web 上传、编稿、草稿、日历、一次排期、历史及重启；官方渠道授权接通后再验证远端 ID/URL/目标账号。不要运行冲突的默认双 PostgreSQL 栈。
2. **手动视频独立小试**：MoneyPrinterTurbo v1.3.8，Codex 审核脚本 + 本地素材 + 上传旁白 → 可播放 MP4，自动发布保持关闭。先验证原生 Web 成品，再接 Content Studio API。
3. **采集小试**：根据已有来源覆盖，先使用原生公开 RSS；需要来源管理时评估 Miniflux，需要补来源时添加 RSSHub。不要同时部署所有采集系统。
4. **接回统一工作台**：以小型 API adapter 连接经过验收的组件；原件、平台稿、修改冲突、任务 prompt、素材引用、视频稿和发布快照由 Supabase 中的产品数据模型统一管理。当前没有已经整合好的组合，不能报告整套系统完成。

第 1、2 项可以独立开展，不必等全功能自研平台结束。若目标只是最快看到一个完整制作工具，第 2 项依赖更少；若目标是最快拥有发布管理 Web，第 1 项收益更大。小试通过并不自动缩减原来的阶段一总验收范围，云端仍不建设。

所有浏览器/授权验收使用 Chrome profile `radarxai@gmail.com`。已有平台登录不代表获得 API 权限；账号/平台缺口仍记录到项目账号文档。只在有明确授权且符合当前渠道政策的内容上做真实发布验证。

## “跑通”证据要求

- 固定版本/制品、启动入口可用，实际 Web/API 健康，Chrome 页面可操作。
- 完成至少一次真实输入到产物/草稿的流程；上传的素材确实被使用，修改能保存。
- 重启后检查历史、定时状态、产物与失败恢复，不用截图代替持久性验证。
- 发布单独验收目标账号、远端 ID、URL 和可见状态；排队、上传成功或草稿创建不能算已公开发表。
- 日志和记录不含密钥、OAuth token、Cookie、浏览器 profile 或原始 Codex 会话。

本报告完成的是成品选型与源码可行性研究，尚未满足上述本机运行验收。
