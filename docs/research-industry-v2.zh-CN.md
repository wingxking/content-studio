# 热点发现、内容生成与跨平台发布：第二轮独立技术调研

调研时间：2026-10-10，Asia/Singapore。范围：官方产品文档、平台规则及维护者源码；本报告没有购买订阅、授权账号、运行这些供应商的真实发布测试。既有项目文档仅用于确认集成背景，以下重要结论重新查阅了当前一手资料。

## 1. 结论与本次请求的关键边界

没有一份公开的一手技术证据能够证明某个产品同时在“全球热点识别、新闻真实性、原创文章、原创视频、中国及海外全部平台、持续不封号”六个维度最好。更可靠的实现是组合专门组件：趋势信号 → 新闻证据 → 原创观点 → 平台适配 → 权限与政策判断 → 发布状态机 → 效果反馈。供应商宣传的“all platforms”“viral score”“autopilot”不能直接当作账号安全或成效证明。

按本项目的 Mac + Codex、Supabase 优先约束，建议保留自己的内容与发布账本，补上可验证的数据发现层；国际平台优先官方 API 或已审批的发布供应商；国内无明确授权 API 的平台先保留用户可监督的本机交接。浏览器自动化应是经过平台规则核查后的小范围适配能力，不能作为所有平台的统一兜底。

**X 存在直接影响本次“自动追热点并发布”的规则。** 当前官方 Automation Rules 明确禁止非 API 自动化（包括脚本操作 X 网站），也明确禁止自动发布热门话题；官方同时允许合规、有发布权的外部信息源播报。因而“换成可见 Chrome、让 Codex 点击”并没有获得豁免，“API 发得出去”也不意味着自动追热点符合规则。本次热点 X 内容应生成可审阅草稿，由真人决定并手动发布；长期 X 工作流应围绕明确主题、有来源的编辑计划设计，避免自动追热榜。[X 自动化规则](https://help.x.com/en/rules-and-policies/x-automation)

“避免封号”应理解为降低违规、盗用、重复发布和安全异常风险。没有合法工具能保证永不封号，也不能把验证码绕过、指纹伪装、代理轮换、批量账号或随机动作当作产品能力。

## 2. 当前最值得对标的产品与组件

| 层次 | 候选 | 当前一手证据说明的能力 | 不能据此证明的能力 | 对本项目的取舍 |
|---|---|---|---|---|
| 企业级监听与行动闭环 | Hootsuite Wisdom / Lumen / Perch | 实时社交信号、品牌/竞品/受众分析、内容建议、创作及工作流协作 | 未公开的抓取机制、模型架构、全球热榜完整性；无法保证原创视频质量或中国全平台覆盖 | 对标其“监听 → 解释 → 内容 → 审批”产品结构，阶段一无需整套采购 |
| 语义情报与趋势发现 | Feedly AI / Emerging Trends | AI 概念查询、趋势体量/增长过滤、文章提及与摘录、企业 API | 搜索热度不是全球社交热度；30 天到年度趋势不是分钟级突发新闻 | 对标结构化情报，成本不适合个人 MVP |
| 大众搜索热点 | Google Trends Trending Now | 按国家/地区提供近期搜索增长、新闻关联、官方 RSS/CSV 导出 | 无统一的“全球第一热点”；搜索量区间不是精确人数或全平台热度 | 阶段一首选可取得、可解释的趋势信号 |
| 品牌内容自动生成 | Predis.ai | 输入品牌/来源/商品资料，自动规划并生成图文、轮播、头像视频及排期 | 未证明自动核验全球新闻、独立事实研究、所有平台自动发 | 对标内容方向、品牌资料与每周内容计划；按需外接媒体生成 API |
| 长视频再创作 | OpusClip | 多模态选段、字幕、构图、品牌模板、异步剪辑 API 与发布工具 | 不是自动搜新闻并生成原创报道；Virality Score 不是爆款保证 | 有自有/授权长视频后再接，不能用来随意搬运新闻视频 |
| 已有内容的分发 | Repurpose.io | 从来源平台检测内容，按规则分发到目标平台 | 不是全球选题引擎，也不是从零写文章/拍视频 | 对标稳定来源 → 目标工作流，而非当前核心引擎 |
| API 发布与账本 | Postiz | 多平台排期、REST、CLI、MCP、媒体上传、发布状态；公开源码 | 第三方工具不能改变平台规则；连接图标不能证明账号可发 | 已有适配基础，优先验证媒体/YouTube/Reddit的实际账号能力 |
| 低成本海外 API 替代 | Buffer | 新 GraphQL API、MCP、包括 YouTube/X 的渠道，Free 也可用 API | 未列出 Reddit/小红书；分析 API 仍有实验性限制 | 新增重要候选；先做有限对比，不必同时引入两个供应商 |
| 国内浏览器发布参考 | AiToEarn | 自部署完整产品、官方插件文档支持小红书/视频号/抖音并复用登录态 | 插件发布不等于平台官方 API 授权；自部署不等于无云端 Relay 依赖 | 外部适配候选，不建议为插件能力替换整个 Supabase 技术栈 |
| 可视化编排 | n8n | 连接不同来源、模型、渲染与发布 API；可本机运行内部工作流 | 不提供平台权限或内容质量保证；源码可读不等于任意 SaaS 免费使用 | 内部原型可用，阶段二用户可配置工作流需商业许可评估 |

### Hootsuite：强在社交数据上下文与组织工作流

最新官方页面已将 OwlyGPT 演进为 Wisdom，连接 Lumen 的社交监听及 Perch 的内容工作流。用户可询问趋势、品牌提及、受众反馈、竞品和表现，再生成可审阅内容。公开文档说明的是数据上下文与产品能力；底层模型、采集权限和精度没有充分公开，不能反推为“爬全网 + 一个大模型”。[Wisdom 官方产品页](https://www.hootsuite.com/owlygpt)

官方价格页 FAQ 列出 Standard 起价 $99、Professional $199、Advanced $399；正文注明价格基于年付、席位及地区条件，实际购买须以账号报价为准。专业版宣传趋势预测与更多报告，企业版有更深历史监听；这些是厂商能力陈述，本调研未做准确率基准测试。[Hootsuite 计划与价格](https://www.hootsuite.com/plans)

**可借鉴的技术设计（推断）：** 将品牌历史、账号表现、受众语言及新闻事实放进可追溯上下文，先输出内容意图和证据，再生成各平台版本。反馈应影响“题材/角度/长度”，不能只优化发送次数。

### Feedly：结构化语义发现证据最清楚，但企业价格较高

AI Feeds 允许用概念模型和 AND/OR/NOT 组合，并选择信源。它的价值是降低关键词歧义、对齐行业定义；不能把“AI理解概念”解读为已经核验全部事实。[AI Feeds 官方文档](https://docs.feedly.com/article/807-how-to-create-ai-feeds)

Emerging Trends 官方 API 是 `POST /v3/ml/trend-discovery/trends`，可按体量或增长排序，返回标签、别名、定义、增长与体量分类、文章来源及提及摘录；指南的周期为最近30天、3个月、6个月、1年。它适合产业研究和增长趋势，不应代替分钟级突发新闻。[趋势 API 参考](https://developers.feedly.com/reference/emerging-trends)、[趋势 API 指南](https://developers.feedly.com/docs/feedly-ai-trend-discovery-api-guide)

当前 Market Intelligence 定价为 Standard $1,600/月、Advanced $2,400/月，均年付；API Access 在 Advanced 中列出。不要把低价个人 RSS 订阅等同于该 API 的使用权。[Feedly Market Intelligence 价格](https://feedly.com/market-intelligence/pricing)

### Google Trends：适合阶段一，必须保存地区与观测窗口

Trending Now 官方支持100多个国家/地区，按4小时、24小时、48小时或7天查看近期搜索增长，平均约10分钟刷新，并通过 Export 输出 RSS、CSV 或剪贴板。建议采用其明确提供的 RSS，保留 `geo`、时间窗、抓取时间、搜索量档位和来源；不能把美国一条热榜称为“全球最火”。[Trending Now 官方说明](https://support.google.com/trends/answer/3076011?hl=en)

官方 Google Trends API 当前公开页面仍是申请制 alpha，描述了滚动5年、地理维度和跨请求一致缩放数据；没有面向所有开发者可直接启用的公开价格与配额。阶段一不能以已获得该 API 为前提，更不能把非官方网页接口称为官方 API。[Google Trends API alpha](https://developers.google.com/search/apis/trends)

### Predis.ai：自动品牌创作，不是自动新闻编辑部

官方自动发布流程要求提供业务方向、品牌、来源链接和平台，然后生成本周和后续周计划、选媒体类型、排期、检查积分并激活。适合品牌内容流水线；文档没有证实“发现全球第一热点 → 多源核验 → 新闻原创评论”的自动闭环。[Predis 自动发布指南](https://help.predis.ai/knowledgebase/en/article/get-started-with-auto-posting-using-predis?category=Autoposting)

API 能生成视频、轮播和图片；其 `Create Post` 在这里是创意生成，不应误读为已经发布社交网络。异步状态为 `inProgress/completed/error`，通过 webhook 返回成品，文档提示 webhook只发送一次，因此调用方需要保存任务并提供查询恢复。Mac localhost 无法直接接收公网回调，应先选轮询恢复或经过明确配置的回调入口。[Predis API 介绍](https://predis.ai/developers/docs/intro/)、[Webhook 契约](https://predis.ai/developers/docs/predis-api/configure-webhook/)

当前英文价格页展示年付 Core $24/月、Rise $55/月、Enterprise+ $212/月；Core 不包含 Auto Posting。API价格另有链接，不能假设普通生成积分覆盖嵌入产品的 API。英文与旧本地化页面曾出现不同数字，因此以实际结算界面为准。[Predis 价格](https://predis.ai/pricing/)

### OpusClip、Repurpose：再创作与分发要分别验收

OpusClip ClipAnything 官方称使用视觉、音频和情绪线索选择片段；维护者的 API 文档列出 Bearer API key、项目创建、来源视频、剪辑偏好、渲染偏好及异步通知。这里公开的是多模态剪辑流程，未公开足以复刻模型的内部结构。[ClipAnything](https://www.opus.pro/clipanything)、[维护者 API 参考](https://github.com/opus-pro/opus-skills/blob/main/skills/opusclip/references/api-reference.md)

Starter 标价 $15/月，Pro $29/月，Pro 标注 Limited API Access，Business 提供定制 API。API额度不能用页面视频积分自行推算。新闻视频的“可导入 URL”仅表示技术接收，不能代替素材版权和二次创作许可。[OpusClip 价格](https://www.opus.pro/pricing)

Repurpose 的官方帮助说明：ASAP自动发现通常约2小时检查一次，单个检测窗超出3条会跳过额外视频；排期模式最多5个槽/天。该限制是供应商自己的工作流保护机制，不是任何平台承诺“每天5条不会封号”。[Repurpose 自动发布机制](https://support.repurpose.io/en/article/how-auto-publishing-works-in-repurpose-aktmnm/)

## 3. 可维护的技术实现：产品自身必须拥有的核心

### 发现与证据层

1. **多地区趋势订阅。** 明确选择地区，例如美国、英国、印度、日本、澳大利亚，分别保留来源字段，再进行跨地区实体归一。记录“在选定地区的覆盖度”，避免假装采样覆盖全球。
2. **独立新闻证据。** 从授权 RSS、新闻索引和官方事件来源取得候选文章；保留文章时间、事件时间、发布者、URL和允许使用的摘录。来源域名数应去掉通讯社转载，两个转载同一报道不算两个独立证据。
3. **实体和事件聚类。** 用标题/实体/时间/地点进行基础去重，再用模型输出结构化事件卡。设计上应把事实、引用、未知项及分析分开，而不是让模型把所有标题混写。
4. **可解释排序。** 可设地区覆盖、近期增长、独立来源数、时效、受众相关性、原创角度及风险项。权重是产品策略，需要反馈验证；不能把自定义分数包装成官方热度。
5. **冷却与更新。** 同一事件只新建一次，并记录实质进展；旧闻翻炒、重复卡片和只换标题都应阻止。突发事实未确认时，保存待核验状态。

以上为本项目设计建议，不是某家封闭产品内部实现的事实陈述。

GDELT 官方 DOC API 提供跨语言新闻索引、文章列表和报道量时间序列，可辅助分析媒体关注度；报道量不是社交参与度，也不是真实性背书。其公开索引不能授予新闻图片和完整文章的转载权。[GDELT 数据入口](https://gdeltproject.org/data.html)、[DOC API 官方说明](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)

NewsAPI 能提供标题与链接，但官方免费 Developer 计划限开发测试，24小时延迟，不能用于内部生产或公开商业运行；生产 Business 目前标价$449/月，且任何计划都不提供完整文章正文。为个人阶段一采购该层的性价比需明确预算后判断。[NewsAPI 价格及使用范围](https://newsapi.org/pricing)、[NewsAPI 条款](https://newsapi.org/terms)

### 文章与视频层

文章生成应以结构化证据卡为输入，要求每个重要事实映射来源，写出独特解释而非改写原文；同时输出不同语言、标题、长度、平台语气以及不能确认的项目。事实核验不能只由同一个提示词“自检”解决；至少将关键数字和声明回到原始材料核对。

视频要区分三条独立路线：

| 路线 | 适用场景 | 技术实现 | 主要问题 |
|---|---|---|---|
| 原创讲解/数据动画 | 新闻解释、教程、对比 | 脚本 → 自制图表/卡片 → 配音 → FFmpeg或模板渲染 → 字幕 | 需要有真实原创分析；模板本身不构成原创价值 |
| 自有长视频剪短片 | 本人访谈、录屏、已授权素材 | ASR/多模态选段 → 构图/字幕 → 人工看成片 | 必须持有使用权；剪辑模型不能保证没有断章取义 |
| 生成式视觉段落 | 概念演示、非纪实背景 | 图像/视频模型 API → 异步任务 → 剪辑合成 | 成本、稳定性及误导；不得把AI重建的现实事件当新闻现场 |

Creatomate 官方有模板或 RenderScript 渲染接口，初始 `202 Accepted/planned` 不等于成品成功；完成需读取状态或 webhook，成品托管最多30天，产品应保存自己可用的最终资产。[渲染 API](https://creatomate.com/docs/api/reference/create-a-render)、[Webhook 与资产保留](https://creatomate.com/docs/api/reference/set-up-a-webhook)

Runway 的官方 API 将生成任务按模型与输出计费，积分单价$0.01；网页订阅不能视为 API积分。对阶段一建议保留本地可重现图表/讲解视频，确实需要视觉生成时再增加明确预算上限的API适配。[Runway API 价格](https://docs.dev.runwayml.com/guides/pricing/)

### 发布层：适配器、工作流与权限应分开

Postiz 的公开源码以 Next.js、NestJS、Prisma/PostgreSQL、Temporal 为核心；Compose 还配置Redis、存储和Temporal持久化相关服务。自部署需要逐个平台配置开发者凭据；Cloud文档宣称提供其已审批 OAuth 应用。不能把“源代码免费”解读为“免平台审批”。[Postiz 源码与 Cloud 对照](https://github.com/gitroomhq/postiz-app)、[官方 Compose](https://raw.githubusercontent.com/gitroomhq/postiz-app/main/docker-compose.yaml)

其维护者的发布配置已明确支持 Reddit 的 subreddit/title/type/flair，以及 YouTube 的 title/visibility等；媒体需要先上传再引用。适配时应动态取得当前账号和设置，不猜测子社区、频道或flair。供应商成功回执需要与平台作品链接和可见性核对，不能仅把建单成功视为已发布。[Postiz 平台设置](https://github.com/gitroomhq/postiz-agent/blob/main/PROVIDER_SETTINGS.md)、[媒体上传](https://docs.postiz.com/cli/media-upload)

Buffer 是本轮重要新增：现在公开 GraphQL API和MCP，API包含Free计划，支持X和YouTube；当前支持列表不含Reddit、小红书。媒体要用公网可取URL并持续到发布完成，不支持直接上传本地文件；帮助文档对指标API明确提示实验性、个人使用和不可依赖生产报告，与MCP页部分较积极描述存在边界差异，采用较严格限制。[Buffer API范围](https://support.buffer.com/en-us/articles/what-is-buffers-api-GtIYIQilz5)、[GraphQL认证](https://developers.buffer.com/guides/getting-started.html)、[MCP契约](https://developers.buffer.com/guides/integrations/mcp.html)

AiToEarn 的 MIT 全栈部署使用 MongoDB、Redis、RustFS、Next.js/NestJS，自部署文档建议 Server Relay 处理平台OAuth；AI Relay可以换自己模型。全栈移植既不满足当前Supabase优先方向，也不能自动消除第三方发布Relay依赖。[AiToEarn 仓库](https://github.com/yikart/AiToEarn)、[部署架构与 Relay](https://raw.githubusercontent.com/yikart/AiToEarn/main/DOCKER_DEPLOYMENT_EN.md)

它的插件方案会读取同一浏览器已有平台登录态，文档称支持小红书图文/视频、视频号视频及抖音；原始账号数据含`loginCookie`，必须立即丢弃敏感字段，只保留展示需要的UID/昵称。插件适合本机能力实验，但文档不能证明平台许可、账号风险或长期免维护。[AiToEarn 插件发布文档](https://docs.aitoearn.ai/zh/use/plugin-publish)

## 4. 官方 API、无头浏览器、可见 Codex 操作如何选

| 维度 | 平台官方 API/已审批供应商 | 无头浏览器 | 可见浏览器 + Codex 操作 |
|---|---|---|---|
| 授权边界 | OAuth范围、平台开发者审批、供应商合同 | 有登录态不等于有自动化许可 | 可见/模拟真人也不产生规则豁免 |
| 确定性 | 结构化响应、对象ID、明确配额 | DOM变化、上传进度、挑战、弹窗容易失效 | 能理解临时页面变化，但操作成本高且可能点错 |
| 可恢复性 | 能用对象ID查状态；应实现幂等/对账 | 提交后断网容易出现“到底发没发” | 需检查真实内容管理页与作品URL，仍存在不确定提交 |
| 身份凭据 | 最小scope、可撤销token、refresh生命周期 | cookie/profile近似完整会话权限 | 浏览器内会话仍很敏感；不可导出cookie或用截图泄露信息 |
| 成本 | API费用/供应商订阅；审核及维护 | 运行浏览器、系统维护、持续修选择器 | 模型交互、电脑占用、人工接管和不可并发桌面 |
| Mac独立性 | 可迁移云端worker，适合阶段二 | 可迁移但更难隔离会话与运维 | 阶段一适合少量被允许的操作；阶段二不能强制依赖用户Mac |
| 推荐用途 | 首选长期发布路线 | 仅平台允许且没有更好接口的固定流程 | 首次账号检查、合法原生流程监督、异常修复与交接 |

该表的可靠性和运维结论是工程分析，不是厂商公开测得的成功率。

对于 X，官方明确排除非 API 自动化，因此本项目不应提供 Puppeteer、Playwright、GUI点击三种换皮路线来绕过限制。对于其他平台也应逐个核对规则；不能因为普通网页手动可用，就承诺其自动操作获准。[X 自动化规则](https://help.x.com/en/rules-and-policies/x-automation)

长期 API Worker 的关键不是“一个LLM能点击发布”，而是：确切目标账号、授权能力、内容版本、资产版本、发布意图、尝试ID、已发送/未知状态、平台作品ID、公开URL、失败和申诉记录。超时后先查回执再重试，`429`遵循`Retry-After`，`401/403`暂停并显示授权或权限问题；验证码/二次验证交给账号所有者，不做突破。

## 5. 降低封号与商业化风险的实际机制

### 按平台设置能力与政策门禁

**X：** 自动发现热门话题可以服务内部研究，但本轮发现的自动热门话题发布禁令必须落在产品门禁；技术上可调用API不代表该用途合规。不要对单账号或多个账号发布近似重复内容，不用无关热门标签引流，不做点赞/关注/评论互刷。显式标识自动账号也不能替代规则。[X真实性规则](https://help.x.com/en/rules-and-policies/authenticity)、[自动账号标签](https://help.x.com/en/using-x/automated-account-labels)

**Reddit：** 当前 Responsible Builder Policy要求API数据访问先获明确批准，商业使用需要书面批准，AI代理/非人操作账号应注册应用身份、保持范围明确，并禁止跨subreddit相同或近似内容。用户已注册登录只解决账号存在，不解决API批准或社区发帖许可。[Reddit Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)

Reddit的spam判断包含手动与自动行为，社区版主还可增加更严格规则。新闻内容先选允许该题材及格式的一个社区，确认其AI、来源、新闻时效、flair与自推广规则；不把一篇新闻铺到多个社区。[Reddit Spam规则](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam)

**YouTube：** 上传API可以设置标题、可见性、定时、儿童内容和合成媒体声明，必须取得用户OAuth授权。当前方法页面写明未验证项目不再强制private，并出现新的独立上传配额；既有概览曾有旧说明，最终仍要以实际项目、账号、上传结果和公开链接验收。[YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)

“能发布”“不被删除”和“能加入YPP赚钱”是三条不同标准。YouTube当前变现政策不接受批量、模板化、低原创价值、简单新闻朗读或搬运式内容；原创解释和实質变化需要落在成片里。AI辅助本身并非一概被禁，但写明AI制作也不豁免低价值内容。[YouTube变现政策](https://support.google.com/youtube/answer/1311392?hl=en)

对真实事件或真人呈现造成有意义改变的逼真合成媒体需要声明；不能伪造现场、名人讲话或灾难画面当作新闻，相关披露应由资产的实际生成方式决定，而非一律勾选或一律不勾选。[YouTube合成媒体披露](https://support.google.com/youtube/answer/14328491?hl=en-au)

**小红书：** 本次已确认有可用技术候选，不据此承诺通用官方发布API、第三方插件获批准或免封号。产品应以真实创作者账号的功能、AI声明、来源、内容规范与发布回执验收；登录浏览器不等于允许导出会话至云端服务。[可审查的本机技术候选文档](https://docs.aitoearn.ai/zh/use/plugin-publish)

### 账号安全机制（本项目设计建议）

- 平台凭据放OS密钥库或服务端secret store，不放Git、配置文档、前端、模型提示词或Supabase公开表。
- 发布与内容生成进程分离；生成模型只看来源和稿件，不持有社交账号token。
- 操作前显示/核对真实账号UID和频道；多profile避免串号，保持用户指定Chrome身份而不复制整个profile。
- 内容hash和资产hash进入发布快照；同版本只能创建一个确定的目标任务。
- 一个平台出现challenge、权限拒绝、spam警告或不确定提交，暂停该平台队列并记录可解释原因。
- 新账号从少量高质量单帖验证开始；频率根据账号实际限制和反馈调整。没有可靠一手证据支持“每天N条绝对安全”的统一公式。
- 指标区分平台可得、不可得及不同口径，缺失值留空；不要靠发更多重复内容优化模型反馈。

这些措施提高可审计性和恢复能力，但不保证平台审核结果。

## 6. 成本、许可证与第二阶段迁移

| 组件 | 当前证据 | 阶段一决定 |
|---|---|---|
| Google Trends | 官方导出；API alpha申请制 | 采用允许的RSS和明确的地区样本 |
| Feedly Market Intelligence | API所在Advanced $2,400/月年付 | 暂不采购；借鉴事件与证据结构 |
| NewsAPI | 生产Business $449/月；免费只开发 | 不用免费计划跑生产；RSS/可用来源优先 |
| Postiz Cloud | Standard $29/月5渠道，API/MCP/CLI包含 | 如需托管发布，已有适配减少集成成本；购买须另有明确授权 |
| Buffer | Free含API，1key、3,000次/30天；媒体需公网URL | YouTube/X替代候选；分析与平台覆盖需保持边界 |
| Predis | 套餐与API不同，自动发布不在Core | 可选创意/视频供应商，不替代新闻证据层 |
| OpusClip | Pro标注有限API，Business定制API | 有合法长视频时再接 |
| n8n | Sustainable Use License | 自己内部编排可用；用户配置逻辑的产品需商业许可 |
| AiToEarn | MIT，MongoDB/Redis/RustFS + Relay | 独立插件/适配实验，不整体替换现有技术栈 |

Postiz Cloud计划当前有7天试用和按渠道套餐，供应商“无限帖子”并不等于平台无限发送。其部分互动/增长功能即使可用，也不应默认启用；须受平台禁止虚假互动的规则约束。[Postiz 价格](https://postiz.com/pricing)

Postiz源码为AGPL-3.0；若修改并对外提供网络服务，必须认真处理该许可的源码提供义务。采用独立托管API边界可以减少直接复制代码和维护成本，但不是对所有法律义务的普遍豁免。[Postiz许可证](https://github.com/gitroomhq/postiz-app/blob/main/LICENSE)

n8n最新官方FAQ说明：仅组织内部人员创建/修改workflow、客户只连接账号和接收结果的用途可使用Community；外部用户可通过自有UI、API、MCP或AI代理配置逻辑仍需要商业许可。不能因为隐藏n8n编辑器就将阶段二解释为免费。[n8n许可用途FAQ，2026-10-06更新](https://support.n8n.io/article/can-i-use-your-license-for-my-use-case)

X当前官方API按量预购积分，普通建帖$0.015/次，带URL建帖$0.200/次；读数据也计费，并应设置费用上限。价格会变，以开发者控制台为准。不要为了少付URL费用而牺牲新闻来源透明度，更不能因为低价写接口存在就忽视自动热点发布限制。[X API按量价格](https://docs.x.com/x-api/getting-started/pricing)

第二阶段应迁移“确定性工作流”，而不是迁移桌面点击：Supabase事件/证据/稿件/资产/尝试/回执/指标，多租户RLS，独立模型API，持久任务队列，账号OAuth与撤销，以及实际成本预算。浏览器能力只保留为用户本地连接器或明确获准的适配器。完成第一阶段真实平台验收之前，不启动这套云产品化工作。

## 7. 本项目下一次端到端运行的建议

1. **把话题选择结果命名为“本次多地区采样中跨区域关注较高的新闻”。** 保存候选榜、采样地区与时间、选择理由。没有证据时不宣称全球第一。
2. **至少取一个原始事件来源和独立新闻来源。** 确认发布时间与事件发生时间，明确哪些是事实、哪些是分析；遇到信源冲突先不自动公开。
3. **同一证据生成四种用途，而非四份复制品。** X：简短、可手动审阅；小红书：中文解释卡片；Reddit：一个明确社区允许的讨论格式；YouTube：带原创讲解的视频与来源说明。语言依据平台受众及账号定位决定。
4. **本轮X采用人工最终发布。** 保留原因与具体官方规则，不用API、无头浏览器或可见代理来改写禁止用途。
5. **其他平台先用实际账号检查获准路径。** YouTube优先官方/已审批OAuth视频路径；Reddit确认应用/社区规则；小红书以可监督原生发布或经核查的本机适配为候选。账号刚注册不等于已有这些权限。
6. **每个平台单独记录结果。** 草稿、上传中、待审核、已建单、待操作、公开成功、失败和不确定必须分开；保存作品ID、URL及可见性证据，不能四个平台共用一个success标志。
7. **随后再验证连续运行。** 断网、服务重启、过期授权及上传后超时应不会造成重复内容。初次公开成功只完成一轮验收，不代表全天候发布能力已成熟。

本轮重要新增是：Google Trends可用官方RSS替代脆弱的非官方接口；Buffer已有适合小规模集成的新API；Hootsuite的重点已变为社交数据上下文与行动；最关键的是X对自动热门话题与网站自动化的明确禁止，应立即进入产品的发布策略，而非只写在研究备注中。
