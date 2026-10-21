# Content Studio 文章草稿扩展执行端

范围：本轮只接微信公众号、知乎、哔哩哔哩专栏。扩展工程位于 `extension/`，根据用户提供的 Wechatsync 2.0.9 发行包恢复，并增加 Content Studio 草稿协议 v1。其他还原适配器仍属于独立扩展能力，不开放为 Studio 投递通道。

## 现有链路与职责

现有系统已经具备草稿投递，不需要另建数据库、队列或浏览器发布服务：

1. 文章编辑器为具体平台保留独立 `Variant`。保存草稿时，用户选择账号并提交 `expectedRevision`，这是对该修订和目标账号的草稿授权。
2. `prepareRemoteDrafts` 固定正文、来源、媒体哈希、账号身份和扩展 ID，生成不可变 `Job.snapshot` 与 `contentHash`。相同修订及账号返回既有任务。
3. `queueRemoteDraft` 将执行操作送入现有 Supabase/pgmq。delivery worker 使用文章/视频共用的账号执行租约和提交栅栏，避免同一账号并发写入。
4. `executeRemoteDraft` 复核文章修订、媒体与绑定账号，记录提交意图，再通过服务端 HTTP 请求 draft-bridge。
5. draft-bridge 校验内部服务密钥，经扩展主动建立的 WebSocket 下发任务。浏览器 Cookie 只在 Chrome 内使用。
6. 扩展进行 DOM 预处理、图片上传及平台草稿创建，回传草稿 ID、编辑器 URL 和原任务上下文。
7. 服务端复核回执，记录 `draft_saved`。操作人员仍须打开平台编辑器核对正文、图片、封面及目标身份；这不构成公开发布。

| 层 | 主要源码 | 职责 |
| --- | --- | --- |
| 账号与配对 | `src/core/draft-connectors.ts`、`src/server/draft-api.ts` | 扩展凭据、只检查所选平台、绑定真实用户 ID |
| 审批与任务 | `src/core/remote-drafts.ts` | 固定修订/账号/媒体、幂等准备、队列、回执及未知结果处理 |
| 传输契约 | `src/contracts/draft-executor.ts` | 协议版本、三个允许的平台、单目标任务和执行上下文 |
| 本地网关 | `src/server/draft-bridge.ts` | HTTP 服务鉴权、扩展 Origin/配对密钥、单连接、业务串行、独立心跳 |
| 扩展传输 | `extension/src/mcp/client.ts` | Token 校验、连接重试、按连接实例回包、区分 Studio 与普通 MCP |
| Studio 执行器 | `extension/src/studio/` | 任务校验、写前身份检查、持久防重记录、草稿回执规范化 |
| 同步流程 | `extension/src/background/sync-service.ts`、`extension/src/adapters/index.ts` | DOM 预处理、最终写前复核、仅草稿选项、严格图片模式 |
| 平台实现 | `extension/core/src/adapters/platforms/{weixin,zhihu,bilibili}.ts` | 沿用恢复的上游平台适配器，不在 Studio 中重新实现平台接口 |
| UI | `src/ui/draft-connections.tsx`、扩展 `SettingsDrawer.tsx` | 本项目扩展安装、私密配对、按平台核对及明确授权 |

## 原插件的技术结构

Manifest V3 service worker 负责浏览器能力及请求，Content Script 负责页面采集与 DOM 处理，React 弹窗/编辑器负责独立同步操作。`core` 将平台适配器与运行时分离：适配器声明能力、认证方式、预处理要求及草稿写入；Chrome Runtime 提供 Cookie、请求头规则、存储与标签页等能力。另有 CMS、Markdown/HTML 转换、阅读提取、历史记录和可选 MCP WebSocket 客户端。来源与恢复方法见 `extension/RESTORATION.md`、`extension/recovery.json`。

| Studio 平台 | 扩展平台 ID | 现有适配器做法 | 草稿回执 |
| --- | --- | --- | --- |
| `wechat` | `weixin` | 从已登录公众号后台读取身份和临时请求参数，将 HTML/图片转换后创建图文草稿 | `appmsgid` 与公众号图文编辑器 URL |
| `zhihu` | `zhihu` | 核对 `/api/v4/me`；先创建草稿，再更新同一 ID 的正文 | 文章 ID 与 `/p/{id}/edit` |
| `bilibili` | `bilibili` | 核对导航接口身份及浏览器 CSRF，调用既有专栏草稿适配流程 | `aid` 与专栏编辑器 URL |

这些路径是提供的扩展源码中的实现，不代表平台提供稳定公开 API 或当前账号已通过真实验收。仍需遵守现有平台政策和账号权限。

## 本轮改动及协议

原有普通 MCP 只有文章和平台列表，无法表达 Studio 审阅过的任务、内容和账号；还可能扫描全部平台，且没有跨 service worker 重启的写入防重记录。本轮加入以下约束：

- 网关用 `studio.hello` 本地心跳确认协议 `content-studio-drafts` v1、`draftOnly: true` 和三个目标；此探测不访问任何平台。官方原版不具备该协议，不能被显示为已接入的执行端。
- 对外业务方法缩为 `checkAuth` 和 `syncArticle`。不转发全平台扫描、独立上传、页面提取或发布方法。心跳与长业务请求独立，既有 20 秒心跳/8 秒超时不阻断草稿执行。
- `syncArticle` 只允许一个目标及 HTML 正文，必须含 `draftOnly: true` 和 `execution: { protocolVersion: 1, jobId, contentHash, expectedUserId }`。响应原样回传该上下文，服务端必须匹配才能接受回执。
- 扩展在预处理前检查身份，并通过 `beforeSync` 在调用平台适配器前再次检查身份及当前 WebSocket。切换账号、禁用连接或旧连接失效时，不进入该次草稿写入。
- `contentStudioDraftJournalV1` 在任何预处理/上传/写入前持久记录任务与完整请求的 SHA-256。记录不保存正文、Cookie、配对密钥或含临时 Token 的编辑器 URL。相同任务已完成时只回传原回执；已开始但未完成时拒绝重写；同一任务改正文/账号/哈希也拒绝。
- 日志最多 2000 个任务，达到上限时停止接受新任务，不自动淘汰未知结果。不要通过清空扩展存储绕过对账；维护须先确认相关任务及回执已归档。
- Studio 正文仅在扩展自身的临时预处理页面转换，不发给当前普通网页。预处理失败时停止执行。三个适配器的图片上传在 Studio 模式下使用严格模式：任何图片上传失败都不返回完整成功回执；如果平台已创建空草稿，仍需要对账。
- Studio 连接地址仅接受 `ws://127.0.0.1` 或 `ws://localhost` 的私密 `/connect?key=…` 地址。设置和连接日志不输出地址中的配对密钥。
- 配置了 Studio 地址时，独立同步入口、CMS 写入、旧网页 `addTask`/`magicCall` 与全平台认证扫描会被阻止，避免绕过 Studio 任务；网页也不能读写 MCP 配置或 Token。普通 MCP 地址继续保留原独立扩展工作方式。
- 禁止唤醒时自动扫描所有平台；Chrome 120+ 的 30 秒重连 alarm 只恢复已启用的传输，不恢复业务任务。浏览器关闭、系统休眠、重新加载或 MFA 仍可能中断工作。

服务端仍是业务状态的唯一权威；扩展日志只是避免重复副作用的执行栅栏，不是另一套任务队列。没有新增迁移、账户 Cookie 导出、模型执行或公开发布能力。扩展 GPL-3.0 工程和主应用通过受保护协议保持独立构建边界。

## 结果不明与对账

提交意图写入后，断线、超时、失败/缺失回执、回执任务/账号不符均保持 `needs_reconciliation`。扩展不会自动重发，Studio 也不会因换修订或换本地账号名绕过同一物理账号的阻塞。操作人员到对应草稿箱查看，使用现有“确认草稿回执”功能登记实际 ID 和编辑器 URL；只有核对既有结果后才能继续。写入前失败且未发送请求的任务保留现有可重试行为。

公众号 URL 中的临时 Token 会在扩展和服务端两层剥离。回执仍标记 `adapter_reported`；人工打开核对后才是 `operator_verified`，不声明已独立回读正文或已公开发布。平台登录在最后一次复核后仍可能被用户改变，不能将浏览器会话当成可冻结的服务器凭据。

## 安装与启用

1. 在 Node 24/npm 构建工具环境执行 `npm --prefix extension ci --ignore-scripts`、`npm --prefix extension run package`，或使用独立 Docker 构建导出产物。构建不启动主应用。
2. 在设备 k 的 Chrome 确认使用 `radarxai@gmail.com` 个人资料。打开 `chrome://extensions`，开发者模式 → 加载已解压的扩展程序 → 选择 `extension/dist/`。保持路径稳定；变更扩展 ID 后必须重新配对和绑定。
3. 在扩展设置启用 CLI / MCP 连接，复制扩展 ID 与 Token。Content Studio“平台草稿连接”保存两项私密配对，再把生成的完整私密地址粘贴到扩展服务器地址。不要把地址、Token 放进工单或日志。
4. 必须同时使用本轮服务端与适配版扩展；旧网关的本地下载心跳和官方原版 MCP 不兼容此协议。运行中的 K8s 实例需通过既有发布流程更新 API、delivery worker、draft-bridge 镜像，保持同一版本；不要同时启动 Compose 应用。
5. 连接通过后，在 Studio 一次选择一个平台，刷新真实身份，确认拥有或管理该账号，并允许草稿保存。三个账号需分别核对，不能用某一个平台成功代表其余平台。
6. 在文章编辑器选择当前“文章”格式修订及已绑定账号，明确点击保存到草稿箱。LocalFS 图片沿用服务端每张 5 MiB、总计 10 MiB 的限制，以 data URI 交给扩展上传。
7. 打开平台编辑器核对草稿。公开发表仍由现有单独流程或用户在平台执行。

## 可重复的测试

独立扩展：`npm --prefix extension run verify`。跨工程往返：`npm --prefix extension run test:integration`；宿主机不连接真实数据库时会明确跳过容器专用 Supabase 测试。

Docker 验证镜像：先构建 `infra/Dockerfile` 的 application 目标为 `content-studio:extension-drafts-v1`，再用 `extension/Dockerfile` 的 build 目标构建 `content-studio-extension:studio-protocol-v1`，最后以仓库根目录为上下文构建 `extension/Dockerfile.integration`。三个镜像标签都可以通过 build arg 指定。

- 单元测试使用测试镜像执行 `npm test`，设置 `STUDIO_CONTAINER=false`，不挂载私密数据；这是测试夹具模式，不启动原生产品运行时。
- 往返测试执行 `npm --prefix extension run test:integration`。真实恢复的 MCP 客户端、执行器、sync-service 和三平台适配器连接真实网关，Chrome API 和所有平台 HTTP 响应均为夹具。
- 容器专用用例只允许已有 Docker 网络的 `http://kong:8000` Supabase，使用随机 workspace，HTTP API 创建草稿任务，现有 delivery worker 消费真实 pgmq，最后检查回执、重复保存不新增任务或草稿，并清理自己的数据库记录。私密运行配置只读挂载，密钥不写入镜像或报告。不增加第二个调度器，也不触碰真实工作区内容。

执行结果与真实平台验收边界见下方验证记录。不要把模拟平台响应或 `draft_saved` 状态替代原生编辑器验收。

## 2026-10-15 验证记录

执行主机为设备 k，分支 `codex/automation-knowledge-ecosystem`，基线 HEAD 为 `8d2512b6d3f3bb5dd3d09d6ffe072829982acb2f`，本轮改动尚未提交；保留了工作区原有改动。

| 验证 | 结果 | 说明 |
| --- | --- | --- |
| 主应用严格 TypeScript + Docker application 构建 | 通过 | 镜像 `content-studio:extension-drafts-v1`；未替换在线实例 |
| Linux 主应用全量回归 | 376 通过、1 跳过 | 共 377 项；历史 macOS `say` 用例跳过 |
| 扩展单元回归、严格 TypeScript、MV3 构建校验 | 47 通过 | Linux Docker 独立构建；含 Studio 执行器 9 项 |
| 跨工程严格类型检查 | 通过 | 扩展 TypeScript 配置检查真实网关、执行器及集成用例 |
| 容器往返/集成 | 8 通过 | 三平台真实适配器代码，切号阻断，断线不重写，预处理页面加载竞态，图片失败不报完整，HTTP API→真实 Supabase/pgmq→delivery worker→扩展→三平台回执；每个平台创建一次、重复保存零新增 |
| 原有生态端到端 smoke | 通过 | 发现任务、冻结知识、修订导出与三个草稿通道；三个回执、重复写入 0、公开帖子 0 |
| 去重与清理 | 通过 | 同一任务重连只返回既有回执；同修订重复保存不新增任务或草稿；随机测试 workspace 的队列和业务记录清理完成 |
| 真实平台草稿/原生浏览器 | 待完成 | Chrome API、DOM 预处理消息和平台 HTTP 在本轮集成测试中为夹具，没有新增真实平台草稿或公开帖子 |

宿主 macOS 的主应用全量回归有两项现有路径断言失败（`/var` 与 `/private/var`）；同一源码在 Linux 容器未复现并通过全量回归。本轮没有改动这两个无关用例。

构建产物为 `extension/dist/` 和 `extension/artifacts/wechatsync-2.0.9-restored.zip`，manifest 标识 `2.0.9 + Content Studio drafts v1`。当前应用仍运行原有 K8s v9 镜像；真正启用前需配套更新服务端、加载并配对适配版扩展，按 `docs/accounts.md` 的步骤完成三账号原生草稿验收。

本轮同时导出不含本地构建配置的 Docker 产物 `extension/artifacts/docker-studio-v1/dist/`。主 ZIP 的 source map 已核对 MCP 客户端、同步服务、Studio 协议与执行器四个入口，均与当前源码一致。
