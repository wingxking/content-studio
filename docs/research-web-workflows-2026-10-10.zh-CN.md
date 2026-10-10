# 多平台内容工作台：官方产品调研与选型

调研日期：2026-10-10。以下依据供应商官方帮助中心、官方产品页、官方 API 文档和官方代码库。页面所述功能是供应商公开能力，不等于我们已测试该供应商，也不等于本项目已实现。没有证据可以把一家平台认定为所有场景的“全球最佳”。本项目最适合组合成熟交互模式，再实现自身的原稿与派生稿版本关系。

交付范围：本轮为调研和设计，新增产品能力未实现。再次复核后的 [本地优先建设基线](local-first-build-review.zh-CN.md) 将第一阶段明确为本机 Supabase 全栈，并补充可安装、可恢复和逐渠道验收；云端只保留可行性与迁移方案。详细落地见 [Web 功能设计](web-product-design.zh-CN.md) 与 [本地/生产技术架构](web-technical-architecture.zh-CN.md)。

## 产品能力与借鉴矩阵

| 产品 | 官方可确认的能力 | 对本项目最有价值的借鉴 | 需要自己补充的部分 |
|---|---|---|---|
| Feedly AI / Market Intelligence | AI Feeds 支持概念、AND/OR/NOT、来源范围、标题/全文匹配；可持续调整查询，接 Private RSS/API、Boards 和自动简报。 | 发现任务应保存查询、来源与过滤策略；结果先进入可筛选的候选箱。 | 面向创作的“热点问题”、每次最多20条、自定执行时间和原稿创作链。 |
| Buffer | Composer 先选择渠道和共同文案，再 Customize for each network；AI Assistant 支持提示词、重写、缩短、扩写、语气调整，并有渠道字数意识。 | 用户容易理解的“共同内容 → 平台标签页 → 单独微调”；编辑器旁边的 AI 面板。 | 持续的热点研究；原稿修订后保留平台微调的安全合并；AI 与来源材料之间的追踪。 |
| Planable | Sync ON 将内容复制到选中页面，Sync OFF 可分别编辑；分组可拆分。保存有版本检查点与恢复；素材库支持复用、文件夹、筛选、用量与预览。 | 平台稿分组、真实预览、版本差异与恢复、素材选择器。 | 原稿变化触发 AI 重新适配后，保留手工覆盖的合并规则。Sync ON/OFF 是复制/编辑控制，不能直接等同于该规则。 |
| StoryChief | Company Knowledge 包含受众、品牌声音、写作/视觉风格、知识文件；可把笔记、URL、已有文章作为内容上下文，生成文章与社交内容，在正文选区使用自定义 prompt。 | 以原稿/来源为内容中心，把品牌、受众、风格和知识作为持久配置；局部 AI 编辑。 | 同一原稿多个平台稿的明确版本血缘、自动刷新与冲突保护。 |
| ContentStudio | Publisher 合并 Compose、Planner、Automations、AI Library；AI 批量生成可选文字/图片、平台、语言、参考图片，再审核、编辑、存草稿和排程。当前文档写明批量生成每轮面向一个平台。 | 每个异步阶段都有可检查结果；图片作为参考上下文；生成结果先选择再排程。 | 多平台同源稿件与编辑继承；scheduler 发现结果与内容生产对象的统一追踪。 |
| Hootsuite | Composer 会为社交网络复制共同内容，再分别定制。当前 Wisdom（原 OwlyGPT）结合品牌上下文及实时 social listening，支持趋势、起草和分析；Perch/Lumen/Nest MCP 分工覆盖发布、洞察、收件箱。 | 研究、内容、发布、分析分成专业能力，但共享工作区上下文；AI 能通过有权限的工具操作业务对象。 | 用户指定时间生成候选问题和精细的原稿继承机制。 |
| Postiz | Public API/OAuth 可接渠道、上传素材、管理帖子与平台特定 settings；MCP/CLI 可供 agent 调用；有独立视频生成 API。 | 优先复用海外渠道发布适配，而不是为每个平台重写鉴权和排程。 | 内容主库、原稿关系、热点发现和编辑器不能交给发布服务替代；当前 API 平台列表未列出小红书。 |

来源：

- [Feedly AI Feeds 的配置与下游集成](https://docs.feedly.com/article/699-guide-to-ai-feeds-market-intel)
- [Buffer：多渠道编辑和排程](https://support.buffer.com/en-us/articles/getting-started-with-buffers-publishing-features-adhqleECyT)
- [Buffer：AI Assistant](https://support.buffer.com/en-us/articles/using-buffers-ai-assistant-qbBulfw9sn)
- [Planable：Sync ON / OFF](https://help.planable.io/hc/en-us/articles/21715379593756-Sync-ON-OFF)
- [Planable：版本检查点与审批](https://planable.io/guides/content-approvals-in-planable/)
- [Planable：素材库](https://help.planable.io/hc/en-us/articles/21715263417884-Media-library)
- [StoryChief：AI 与品牌/知识上下文](https://help.storychief.io/en/articles/6967220-getting-started-with-ai-assistant)
- [ContentStudio：Publisher](https://docs.contentstudio.io/articles/new-publisher-your-central-hub-for-content-planning-scheduling-and-automation-2b698b1a)
- [ContentStudio：Bulk Schedule Via AI](https://docs.contentstudio.io/articles/bulk-schedule-via-ai-cd68b702)
- [Hootsuite：Composer 多平台定制](https://help.hootsuite.com/s/article/create-publish)
- [Hootsuite：当前 Wisdom](https://help.hootsuite.com/s/article/get-started-owlygpt)
- [Hootsuite：MCP 分工](https://www.hootsuite.com/integrations/mcp)
- [Postiz：API 与平台 settings](https://docs.postiz.com/public-api/introduction)

## 特别容易被旧资料误导的地方

1. ContentStudio 当前 Publisher 文档明确写明旧的 Articles to Social Media 和 Videos to Social Media automations 已停用，只让以前启用的自动化保留访问。不能沿用旧评测，把它描述为现在可新建的端到端新闻转载自动化。
2. “AI 写稿”不等于“实时新闻获取”。Buffer 的 AI 帮助文档列明 URL 不能直接读取、知识不是实时；本项目必须由研究阶段实际获取来源文本和时间，再交给模型，不应仅把 URL 粘进提示词。
3. 发布排程与热点研究排程是两个对象。行业常见 Calendar 主要解决帖子何时发布；用户这次的 scheduler 则是“何时采集并提出候选问题”。二者可以共用运行设施，但必须有不同状态、失败说明和权限。
4. “每次最多20个热点问题”是本项目的产品限制，不是本次官方资料确认的行业标准。没有足够证据时允许返回少于20个，不能为凑数生成假热点。
5. 原稿发生修订后，无损保留各平台手工微调，没有在已阅读官方文档中得到完整的实现保证；这不是可以声称行业已解决后直接照抄的功能。

## 本项目应形成的核心差异（设计建议）

### 以内容包作为中心对象

一个内容包串联：研究任务的某次运行 → 候选问题与来源快照 → 原稿修订 → 各平台稿修订 → 可选视频项目 → 发布计划与实际回执。共享题材与事实，但每个子对象独立版本化。素材不是正文中的本地文件路径，而是有ID、文件版本、摘要和引用关系的工作区资产。

### 先原稿、后适配，手工修改受保护

原稿正文保存会建立新 revision。平台稿记录 `baseMasterRevision`、上次自动生成稿、当前编辑稿、平台规则版本和平台专用 prompt。

- 没有手工修改的未发布平台稿：自动重新适配原稿，成功后保存新平台 revision。
- 有手工修改的平台稿：以“旧自动稿 / 当前手工稿 / 新自动稿”作三方比较；未冲突部分可自动合并，冲突区域保留手工稿并出现“需要合并”。不能让 AI 静默覆盖。
- 用户可以固定标题、开头、结尾、标签或图片配置，并明确“保持这个编辑意图”；事实变更涉及固定区域时标记待核对，不能因字段锁定隐藏过时事实。
- 已发布的文本与附件保留快照；原稿变化只创建新的草稿，不改写历史发布记录。已批准待发布稿如果变化，旧批准失效并暂停该发布计划，用户审核新版后继续。
- AI 在生成时用户继续编辑：用 expected revision 检查并发；旧任务不能覆盖新编辑。可保留为候选建议供比较。

这些是我们针对用户需求提出的设计，不是上述供应商已确认的行为。

### 统一 AI 指令入口，但操作对象清楚

编辑器右侧“AI / Codex”面板先选作用域：原稿、当前平台、所有平台、视频脚本、选区。选图与附件可在同一面板完成。显示执行中、输入范围、结果差异、应用/拒绝/再调整，而不是在聊天里让用户复制粘贴正文。

全局品牌/禁用语、任务研究 prompt、原稿生成 prompt、平台适配 prompt 和一次性编辑指令分层保存并版本化。编辑命令成功的标准是业务对象形成有效新 revision，不是模型聊天已回复。

### 视频单独建项目

用户按“创建视频”后才生成视频稿，内含口播、分镜、字幕、素材引用和发布描述；视频脚本可编辑，渲染为另一个显式动作。文章变化只提示视频稿过时，不自动消费额度重做视频。ContentStudio 官方提供独立入口、provider/时长/比例/清晰度选项和素材库归档，可以借鉴交互，但我们的稿件版本与手动渲染规则应更清楚。[ContentStudio：AI Video Generation](https://docs.contentstudio.io/articles/ai-video-generation-e0772dba)

### 历史应能回答“当时到底发了什么”

至少保留原稿和平台版本、被用到的图片/视频版本、操作者或AI任务ID、输入prompt版本、来源时间、批准版本、目标账号、实际平台ID/URL、发布时间、失败和重试事件。过滤条件为任务、题材、平台、账号、时间、状态、素材。点击某次发布应看到真实快照，并可复制为新内容包。

Planable 官方明确已发布的社交帖子不能从其平台编辑，要去社交平台编辑，这支持将草稿编辑与发布后变更拆开思考，但不证明它的内部历史就是不可变账本。[Planable：Edit a post](https://help.planable.io/hc/en-us/articles/21715515108764-Edit-a-post)

## 复用与采购判断

建议借鉴 Feedly 的发现过滤、StoryChief 的同源内容与知识上下文、Planable 的编辑/版本/素材体验、Buffer 的简洁多平台 composer。发布方面为可支持且规则允许的海外渠道接官方 API 或 Postiz OAuth/API，保留明确的 provider 适配层。中国平台按各自开放能力另接，不能用“支持32个平台”覆盖它们。

不要整个 fork 一家发布平台再承担其所有数据模型和UI。当前 Postiz 主分支 LICENSE 实时读取为 AGPLv3；如要复制/改造其代码并提供在线服务，须按实际版本评估相关源码提供义务。API 服务集成和 fork 代码是不同工程路线，实施前固定供应商版本与服务条款。[Postiz 当前 LICENSE](https://raw.githubusercontent.com/gitroomhq/postiz-app/main/LICENSE)

本次未核验价格、支付条件、账号接入成功、内容质量或平台审核通过；不宜用营销宣称推导稳定性和发布成功率。
