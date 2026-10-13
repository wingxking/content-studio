# 发布与平台草稿生态：2026-10-13

核验日期：2026-10-13，Asia/Singapore。本文区分代码接入、账号授权和真实远端结果；安装插件、打开编辑器、服务商返回成功均不能单独证明平台草稿或公开发布。

## 产品中的四类结果

| 结果 | 用户实际得到什么 | 必须保存的证据 |
| --- | --- | --- |
| 平台原生草稿 | 文章进入目标账号的草稿箱，仍未公开 | 适配器/平台草稿标识、账号、内容修订；平台页面回读单独记录 |
| 服务商草稿 | 文章进入 Postiz 等服务商的审稿列表 | 服务商草稿标识；不能当作目标平台原生草稿 |
| 平台收件箱上传 | 媒体进入 TikTok App 收件箱，等待用户编辑 | publish_id、上传状态、待用户操作状态 |
| 公开发布 | 目标平台已有符合可见性要求的作品 | 远端作品标识、平台 URL、目标账号及状态回读 |

本项目已有不可变修订、账号绑定、内容包、人工交接和官方 YouTube 视频流程。本轮新增的 WechatSync 网关连接与 Postiz 草稿保存必须沿用这些边界：用户明确点击保存草稿；公开发布暂停时仍可保存草稿；结果不明不重复创建。生态目录的 `implemented` 只表示代码路线可用，不表示已配置、已授权或已经通过真实账号验收。

本轮代码已接入公众号、知乎、Bilibili 专栏的 WechatSync 草稿传输，以及 X、LinkedIn、Reddit 的 Postiz 服务商草稿。两条目录路线现在标为 `implemented`；这些平台的真实账号草稿验收均尚未完成。TikTok 收件箱、公众号官方 API/CLI 和新增 Postiz 渠道继续标为待接入，其他浏览器工具只列研究，不会因出现在目录里获得执行能力。

## 逐平台最少操作路径

| 平台 | 优先路径 | 所有者需要做的事 | 尚未打通时的方案 |
| --- | --- | --- | --- |
| 公众号 | WechatSync 原生草稿；有官方草稿 API 权限时优先评估 API/CLI | 初次安装扩展并登录，或配置 AppID/AppSecret/IP；审阅平台草稿后发表 | 导出富文本、正文图片与封面；在原生编辑器保存草稿 |
| 知乎 | WechatSync 公开文章适配器 | 初次扫码/登录，核对身份及专栏权限，检查草稿 | 保留原生文章入口及内容包，不模拟已完成同步 |
| Bilibili | WechatSync 公开专栏文章适配器 | 初次扫码/登录，核对专栏文章草稿 | 视频使用独立视频入口；文章与视频工具不可混用 |
| X | Postiz 服务商草稿；已核验 API 可发布允许自动化的文字 | 初次授权账号；热点来源内容由真人发布 | 复制和原生交接；不使用 X 网站自动化 |
| LinkedIn | Postiz 服务商草稿，或已授权文字发布 | 初次连接正确的个人/组织账号 | 原生编辑器交接；服务商草稿不称为 LinkedIn 草稿 |
| Reddit | Postiz 服务商草稿；获批连接后才可自动发布 | 明确目标社区、规则、Flair 与获批应用 | 原生社区编辑器；已有其他应用授权不能挪作本项目批准 |
| YouTube | 现有官方 API 视频上传与回读 | 首次 OAuth；每次批准视频及可见性 | 原生 Studio；Private 视频不称为编辑器草稿 |
| TikTok | 官方 Upload API 收件箱，或已授权 Postiz UPLOAD | 应用/账号授权；最后在 TikTok App 完成编辑和发布 | 原生上传页面；本轮未接入收件箱适配器 |
| Instagram | 经授权 Postiz 官方集成，逐平台新增适配 | 连接符合该集成要求的账号 | 原生交接；不把 Postiz 暂存视为 Instagram 草稿 |
| Facebook | 经授权 Postiz 官方集成，逐平台新增适配 | 选择已授权主页/目标和权限 | 原生交接；按实际支持的内容格式验收 |
| 小红书 | 先保留原生图文/视频交接；单独核验准入 | 登录并确认内容资格、AI 标识及实际保存结果 | 不把 WechatSync 私有模块或 Red Skill 宣传当作可用发布授权 |
| 抖音 | 原生交接；后续评估可允许的公开工具或官方接入 | 登录及平台验证，确认可见性和素材 | 不原样采用依赖隐蔽自动化的 CLI |
| 快手 | 原生交接；后续评估可允许的公开工具或官方接入 | 登录及平台验证，确认可见性和素材 | 同上，先验证具体账号与动作 |
| Product Hunt | 已有产品资料包 → 原生 Create Draft | 提供真实公开产品 URL、上线事实，完成账号 onboarding | 不编造 GraphQL 草稿写入；提交页保存草稿后单独安排上线 |

## 已审计的上游与接入成本

### WechatSync：优先用于文章草稿

- 审计提交：`a98e42865387285afcc027c61836488748f3b30f`，默认 `v2` 分支，扩展 `2.0.9`。公开模块覆盖本轮选用的 `weixin`、`zhihu`、`bilibili` 文章草稿；本项目 `wechat` 映射为上游 `weixin`。
- CLI npm `@wechatsync/cli@1.1.0` 已查到，包记录的 gitHead 为 `34d41ce7b592a263731511a556ebe1ef0be37398`。`@wechatsync/mcp-server` npm 查询为 404；源码存在不等于已发布可安装包。
- 根仓库为 GPL-3.0；CLI/MCP 清单标 MIT，属于混合许可证元数据。保留独立组件边界及相应声明，不据子包清单概括整个扩展为 MIT。
- 小红书、抖音不在已审计公开适配器树；相关私有 submodule 指向 `wechatsync/wechatsync-private-adapters`。不根据渠道数量宣传推断这些模块可取得、获授权或可在本项目调用。
- 扩展依赖浏览器登录、Cookie/站点权限和脚本权限。浏览器会话留在受保护的指定 Chrome 配置文件；Docker 网关只承载经授权协议。此路线是可选浏览器伴随能力，不把宿主浏览器变成 Docker 模型/队列服务的替代品。
- 上游普通 HTTP 服务缺少本项目需要的认证/CORS 边界，不能直接对本机任意页面或网络开放。本轮已实现独立 Docker 网关的认证和受限来源；连接密钥与平台会话都不得进入跟踪文件。
- 协议没有可靠的通用 `readDraft`、历史查询或平台幂等键。成功标注为适配器报告，用户打开平台核对另计；超时等不确定结果进入核对状态。公众号返回的编辑 URL 可能含会话参数，持久化前必须移除。

来源：[固定上游版本](https://github.com/wechatsync/Wechatsync/tree/a98e42865387285afcc027c61836488748f3b30f)。

Docker 生命周期已纳入 `delivery-private/draft-bridge`：捕获、恢复和旧实例启动前创建私密目录并设置运行 UID/GID；API 可写，投递 worker 与网关只读，文章/视频 worker 不挂载。备份先停止 API、worker 与网关，配对配置随现有私密边界加密；默认恢复跳过配对凭据，不自动生成连接密钥。恢复实例默认使用独立端口 `19528`，首次捕获默认 `19527`，可通过 `--draft-bridge-port` 指定。本轮只验证配置和临时目录，不以此声称网关已经在真实实例启动或成功连接扩展。

### 官方公众号 API / wechat-mp-cli：有权限时最适合 Docker

候选 `@fateforge/wechat-mp-cli`，核验到 `v1.0.11`，MIT。上游提供 Go/Linux 二进制、JSON 输出、Markdown 转换、正文图片上传替换、草稿创建/更新/读取，以及独立发布状态查询；写动作采用绑定请求的 dry-run/confirm token。无需引入第二数据库。[源码与使用说明](https://github.com/fatecannotbealtered/wechat-mp-cli)、[版本](https://github.com/fatecannotbealtered/wechat-mp-cli/releases)、[许可证](https://github.com/fatecannotbealtered/wechat-mp-cli/blob/main/LICENSE)。

尚缺本项目适配器、真实账号凭据和账号验收。先在公众号后台检查草稿权限，再配置受保护的 AppID/AppSecret 和出口 IP 白名单；动态出口可使用账号所有者授权的固定代理。草稿和发表/群发权限分开判断。官方文档在本次检索环境不可读取，因此本文不根据博客断言所有个人或未认证账号都具有相同权限；接口实现依据已查看的上游源码，账号准入必须以官方后台/实际调用为准。[官方草稿文档入口](https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_add)。

`md2wechat-skill` 当前主分支采用自定义 Source Available/BUSL 类许可证，商业用途有限制；不能根据历史介绍或同名分支当作 MIT 组件嵌入。[当前许可证](https://github.com/geekjourneyx/md2wechat-skill/blob/main/LICENSE)。

### Postiz：服务商草稿与平台结果分开

官方 `POST /posts` 的顶层 `type=draft` 保存在 Postiz，不排队公开发布；之后从 Postiz 提升为正式发布。它不承诺将草稿写入每个平台。本项目本轮只覆盖已有 X、LinkedIn、Reddit 文字契约。更多 provider 的字段、媒体、账号身份和回读需要独立接入。[Create Post](https://docs.postiz.com/public-api/posts/create)。

CLI npm 名称为 `postiz`；检索到的上游包清单版本为 `2.0.19`，需要 Node >=18，AGPL-3.0。CLI/MCP 是同一 API 的入口，可列账号/能力与保存草稿；并不免除平台批准。本轮无须为了已有 HTTP 调用再增加 CLI 常驻进程。[CLI 文档](https://docs.postiz.com/cli/introduction)、[MCP 文档](https://docs.postiz.com/mcp/introduction)、[包清单](https://github.com/gitroomhq/postiz-agent/blob/main/package.json)。

自托管官方 Compose 包含 Postiz、PostgreSQL、Redis、Temporal、Temporal PostgreSQL、Elasticsearch。不得直接复制两个新 PG 服务到本项目；若决定自托管，先验证同一 Supabase 实例中的隔离逻辑数据库、角色和全 profile 备份，以及哪一方负责排程。当前没有部署这个新增栈。使用已有授权的远程服务商可以减少运维，但仍需明确配置、账号验证和媒体传输边界。[安装](https://docs.postiz.com/self-host/installation/docker-compose)、[当前 Compose](https://github.com/gitroomhq/postiz-docker-compose/blob/main/docker-compose.yaml)、[服务器许可证](https://github.com/gitroomhq/postiz-app/blob/main/LICENSE)。

### TikTok：收件箱上传是真实可行的独立能力

官方 Upload API 需要已注册应用、获批 `video.upload` 及目标用户授权。视频可以用 `FILE_UPLOAD` 直接传本地文件，返回 `publish_id` 后查询状态；用户必须打开 TikTok 收件箱通知继续编辑并发表。图片或 URL 拉取还需符合域名和公开 URL 规则。本轮只有研究，未新增此适配器。[官方上传文档](https://developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content)。

Postiz 的 `content_posting_method=UPLOAD` 也是收件箱路线，其文档要求用户 24 小时内处理；多数发布设置被忽略。尤其注意：Postiz 可能将成功上传报告为“已发布”，产品必须仍显示“收件箱已送达，待用户完成”。该 Postiz 路线要求公开 HTTPS 媒体，本地文件需另有明确的临时传输方案。[Postiz TikTok 设置](https://docs.postiz.com/public-api/providers/tiktok)。

Direct Post 另有审核要求，官方明确不接受仅供自己/团队账号使用的私人工具这一用途。不能把本地个人工具的代码完成等同于已经具备 Direct Post 生产资格。[官方准入说明](https://developers.tiktok.com/docs/en/content-sharing-guidelines)。

### Product Hunt：原生草稿存在，公开 API 没有已证实的产品写入

官方帮助明确提供 Create Draft / Schedule Launch；真正的草稿可以在原生提交流程保存。公开 API 默认只读，部分写操作需平台批准，当前公开 mutation 文档仅列 follow/unfollow，没有产品草稿创建。本项目降低用户操作的可行下一步是基于真实页面做明确的资料填入及草稿确认，保留真实产品 URL 要求；不得猜测私有接口。[草稿流程](https://help.producthunt.com/en/articles/2724119-how-to-schedule-a-post)、[API 权限](https://www.producthunt.com/v2/docs)、[公开 mutation](https://api-v2-docs.producthunt.com/operation/mutation/)。

### 其他 CLI / 桌面生态：不整套迁入

`social-auto-upload` 当前 MIT，Python 3.10–3.12，公开 CLI 覆盖抖音、小红书、快手、Bilibili 等；主线使用 Patchright/stealth 与浏览器会话，历史 Web/Docker 路径不保证与主线同步。它描述的主要是上传/投稿，不是已验证的通用草稿读取。因本项目不以隐蔽自动化作为依赖，不原样接入；Bilibili 视频能力不能替代文章草稿。[仓库](https://github.com/dreammis/social-auto-upload)、[当前依赖](https://github.com/dreammis/social-auto-upload/blob/main/pyproject.toml)。

AiToEarn 当前 MIT，服务端依赖 MongoDB、Redis 与对象存储，Electron 端使用 SQLite。这与本项目 Supabase 单数据库边界不符；只研究可单独复用、权限明确的公开能力，不迁入整个系统。README 的平台清单不证明本账号或本项目已经打通。[仓库](https://github.com/yikart/AiToEarn)、[许可证](https://github.com/yikart/AiToEarn/blob/main/LICENSE)、[部署配置](https://github.com/yikart/AiToEarn/blob/main/docker-compose.yml)。

## 验收和后续顺序

本次聚焦验证：Postiz 草稿适配器使用仅本机监听的假服务商执行 11 项测试，覆盖精确 `type=draft`、保留原 `type=now`、账号/文本/媒体前置校验、400/401 拒绝、408/500/断连/错误回执的不确定结果，以及不自动重试；全部通过。原有内容、文字限制与发布能力回归 34 项通过。生态目录的 12 条路线覆盖全部 14 个平台，能序列化为 JSON。以上均未向真实服务商或平台发帖。

Docker 生命周期与备份回归 7 项通过，包含旧根目录新增私密目录、保留既有配置、权限修复、拒绝目录符号链接和备份失败清理。`node scripts/docker.mjs config --root .docker` 验证了合并后的 Compose 配置；未运行 stop/start/backup/restore，也未改写现有实例的配对状态。新增完整 API/界面、网关协议和端到端状态测试由本轮总体验证单独记录，不能用上述局部测试替代真实账号验收。

1. 将本轮三个文章草稿适配器与 Postiz 暂存纳入完整 API/界面及 Docker 协议回归；保留真实账号未连接的明确提示。
2. 所有者只做一次扩展安装/账号登录或服务商 OAuth。每个平台以同一份已批准的测试文章执行一次保存，核对图片、格式、实际身份、远端标识和可重新打开的草稿；未执行的平台保持未验收。
3. 断连、超时、旧版本、登录失效、重复点击和回执地址带凭据均应有测试；不确定结果不得自动创建第二份草稿。保存草稿不唤醒公开发布任务。
4. 有公众号官方 API 权限时，再以固定版本 CLI/API 减少浏览器依赖。TikTok 收件箱列为后续独立目标；Product Hunt 先补齐真实产品资料。
5. 每次报告分别写清：代码已接入、账号已授权、草稿已存在、公开作品已确认。当前研究本身没有创建任何外部草稿、上传或公开内容。

## 本轮最终集成结果

完整测试 251 项、严格 TypeScript 与生产构建通过。隔离 Docker + Supabase + HTTP API + 持久化队列 + 模拟扩展的三平台草稿流程通过，重复点击零重复写入，公开发布保持暂停。加密升级备份核验 1009 文件，14 个本地服务已运行，中文页面检查通过。真实账号草稿验收仍未完成：指定 Chrome 配置未安装 WechatSync，Postiz 未连接。前文的局部测试阶段记录以本节最终集成状态为准。完整能力清单与未完成项见 [产品审查](product-review-2026-10-13.zh-CN.md)。

安装后须追加大于 60 秒空闲连接检查；当前未加入未经上游支持的心跳指令。微信编辑链接持久化时去掉会话参数，如果平台要求重新登录或拒绝直接打开，请从官方后台草稿箱按记录的草稿 ID 核对；不将带 Token 的链接复制到 CLI 或文档。
