# BeeCMS 规划复核与自动创作生态升级

日期：2026-10-14，Asia/Singapore。规划及调研使用 ultra 推理，三个实现工作包使用 high 推理。审查来源是 kwt 提交的 [BeeCMS 迁移规划](beecms-migration-plan.zh-CN.md)，基线 `b6274cc`；采用原创实现，不复制 BeeCMS 私有适配器、数据库或登录态。

## 产品结论

保留 Content Studio 的 Docker、Supabase、LocalFS、修订审批和单一 pgmq/pg_cron 执行链。BeeCMS 规划中的账号锁、执行契约、素材衍生和指标框架已有实现；本轮补齐配置、知识接入、自动选题生产与集中监控。

用户打开本地网站即可检查配置、上传知识文件、选择知识版本、设置创作任务、查看运行和交付。开启发现任务的自动生产后，有来源且通过题材检查的前 1–3 条候选自动创建单次内容任务，生成待审核原稿和平台版本。视频保持独立、显式创建与渲染。生成不会自行批准新修订；审阅后使用现有单次操作保存远端草稿或向所选授权账号提交。

配置向导针对已有 Docker 实例。它不执行任意宿主脚本，也不挂载 Docker socket。**全新机器从零的一键安装、签名桌面客户端和所有平台自动发布没有被实现或验收**；当前入口是 Web，Docker 生命周期仍使用受控 shell wrapper。

## 文件和数据库职责

- 素材及生成文件在 ignored、非同步的 Docker bind 根下。原始媒体继续使用 LocalFS 内容哈希对象，旧 Storage 资产保持可读。
- 文章使用现有 `data/content/<draftId>/revision-N/`，保留 Markdown、HTML、JSON、来源和平台导出；任务产出在 `data/runs/<runId>/`，独立视频在既有视频目录。
- 知识资料位于 `data/media/localfs/knowledge/objects|sources|snapshots`，包含 SHA-256 原件、不可变来源 manifest 和固定运行摘录。上传或挂载导入均不把知识原文、摘录、文件字节写入数据库。
- Supabase 保留现有业务修订/CAS 权威、操作/关系、账号、队列、时间及回执。本轮没有拆除已验收的修订模型、引入第二数据库或让磁盘 manifest 成为第二套发布状态。
- 外部知识目录只读挂载；显式导入建立持有的不可变版本。它是独立知识来源，不是原有媒体的第二权威。原目录改动不影响既有运行、重试或后续调优。

知识首版支持 UTF-8 TXT、Markdown、JSON、CSV，单文件 2 MiB、资料库 500 个版本/64 MiB、每任务最多 8 个来源。PDF/Office 解析仍未接入。检索是有界关键词和摘录检索，没有部署向量服务，也不宣称已实现语义 RAG。详细限制见 [知识库说明](local-knowledge-library.md)。

## 自动执行和恢复

`discoveryAutomation` 默认关闭。增量迁移 016 在同一事务创建唯一推广关系、冻结子 Task/run 和 pgmq 消息。候选来源、平台、父任务状态与数量均在数据库核验，不能用客户端 payload 改写已冻结任务。子任务无周期、不开启再次发现，重复派发复用同一 run。

知识在首次运行时冻结；重试、同步和润色读取同一 SHA 与摘录。旧即时生成/导入入口拒绝缺少原知识快照的稿件。批量导入先整批去重和容量预检；I/O 中断返回已完成数量，界面刷新，显式重试复用完成版本。

父发现任务完成后，子任务推广失败会保留成功的父证据。网页的“检查 / 修复选题衔接”通过幂等 RPC 补齐子任务，避免队列重试耗尽后无法继续。

配置接口 `/api/runtime/setup` 聚合 Docker、Supabase、LocalFS、模型授权、知识、草稿连接与发布开关。活动接口 `/api/runtime/activity` 只返回摘要：阶段、已有进度、尝试、时间、错误和父子关系。未知提交只给核验入口，安全失败复用原任务恢复；不会通过创建新 job 清除重复提交屏障。

新受理的 Postiz/YouTube API 任务保存 `verificationCheck` 操作元数据，复用既有每分钟 dispatcher 和 delivery worker 自动只读核验。每轮最多 3 条，取消信号覆盖远端、数据库与账号锁请求；失败退避，权限错误、48 次或 24 小时后停止。首次 YouTube 回读暂时失败保留已受理 ID；显式续传仍只使用原 session，随后进入相同核验路径。历史记录、未知结果、草稿和暂停实例不自动开启核验。监控显示最近/下次检查与停止原因，队列/上传不标成公开发布。

## 发布生态调研

| 路线 | 本项目能力与实际边界 |
| --- | --- |
| WechatSync | 已实现公众号、知乎、B站专栏文章原生草稿；需要指定浏览器扩展、真实账号绑定与保存许可。公开发布仍在平台完成；超时没有通用读回证明，须核对原草稿。 |
| Postiz | 当前接入 X、LinkedIn、获准 Reddit 文字；草稿保存在 Postiz 服务商内。API 密钥、integration、App/社区资格和单修订账号批准就绪后才执行。 |
| YouTube | 既有官方 API 可恢复上传。Private/Unlisted 是已上传视频，不是编辑器草稿；最终频道、处理和可见性须回读。 |
| 公众号官方 API/CLI | `wechat-mp-cli` 官方 release 已更新到 v1.0.12，可评估独立 Linux 草稿与发布路线。本轮没有安装、配置其 AppSecret 或宣称账号获得资格。 |
| TikTok | 官方 Upload API 支持获批 `video.upload` 送 App 收件箱、查询状态；不是公开发布。本轮未新增适配器。 |
| 财经试点及其他平台 | 保持已有关闭/人工交接状态，不能因平台图标或浏览器登录宣称已获得自动写权限。 |

本轮核查的一手资料：[WechatSync MCP](https://github.com/wechatsync/Wechatsync/blob/v2/packages/mcp-server/README.md)、[Postiz 创建](https://docs.postiz.com/public-api/posts/create)、[查询](https://docs.postiz.com/public-api/posts/list)、[草稿状态切换](https://docs.postiz.com/public-api/posts/change-status)、[指标](https://docs.postiz.com/public-api/analytics/post)、[公众号 CLI release](https://github.com/fatecannotbealtered/wechat-mp-cli/releases/tag/v1.0.12)、[YouTube 恢复上传](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)、[TikTok Upload](https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content)。Postiz 将已有草稿切换为 schedule 是新的写操作，不作为安全失败的自动重试；missing-content 空结果不证明未发。

保留 [X 自动化规则](https://help.x.com/en/rules-and-policies/x-automation)、[Reddit Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy) 与本项目 [平台政策](platform-policies-v2.zh-CN.md)。X 趋势题材必须真人发表，X 网站自动化不开放；中国平台账号内容资格仍需逐账号核验。

## k 上执行记录

工作目录 `/Users/k/x/content-studio`；隔离运行根 `.docker-k-acceptance`，Compose project `content-studio-k-test`，Web `http://127.0.0.1:4310`。升级前 Docker-only 加密备份 `.docker-backups/2026-10-14-ecosystem-before` 校验 1,041 文件，逻辑数据库备份通过，原有实例和私密状态保留。

Chrome 已现场核验 `radar` profile 邮箱 `radarxai@gmail.com`。YouTube Studio 返回 RadarXAI 及 `UCVUtH6reLkEuMrUuTh-XgjQ`，既有视频仍可见；知乎显示本人扫码/短信登录。独立 Linux 模型授权、Postiz key、扩展配对和真实草稿验收仍须各自完成，不能用缓存模型目录或旧实例登录替代。

最终源码通过 Docker 严格 TypeScript、生产 Vite 构建和 Git whitespace 检查；全量测试 **300 项：299 通过、0 失败、1 跳过**。跳过项是历史 `macOS say` 视频测试，不能当作新的 Linux 渲染验收。API、文章/视频/投递 worker 已构建并重启；完整 wrapper 也成功构建模型、TTS 与 renderer 镜像，使用既有固定上游版本。

增量迁移 016、017 已应用。两份独立 Supabase SQL 验收均以自带 BEGIN/ROLLBACK 结束：自动推广验证完整冻结输入、上限、同事务入队、重复修复及无递归；发布核验验证既有队列去重、暂停/历史/未知/草稿不启动、已受理 YouTube ID 可查询且没有新 cron。临时演练工作区已清理，没有保留待消费的测试任务。

`tests/ecosystem-docker-smoke.ts` 使用随机工作区、真实 Supabase/pgmq 和确定性的研究/模型 fixture：知识 HTTP 上传/导入→发现→唯一子任务→适配故障→原知识快照重试→LocalFS 修订→批准→三平台模拟扩展草稿。结果：1 个子任务、master 生成 1 次、重试 attempt 2、3 条草稿回执、0 次重复写、0 条公开帖文；逐表检查测试工作区无残留。它不证明真实模型或真实平台已授权。

实际已运行 Web 的 `/runtime/setup`、`/runtime/activity` 返回正常，29 条当前/历史活动无读取警告。IAB 实际验收：配置状态、UTF-8 文件选择上传、只读挂载显式导入、重复导入复用、SHA 检索、自动生成 1–3 篇的设置和知识版本选择、活动筛选。保留的 `acceptance-software.md` 是隔离根内明确标注的合成验收资料，两个 provenance 引用共用一个 SHA 对象。API Origin 限制实际返回 403。只停止/启动 API 容器的网页恢复演练通过：故障提示出现，连接恢复后自动消失；频道核验失败指向账号配置，未提供发布动作。

升级后加密备份 `.docker-backups/2026-10-14-ecosystem-final` 校验 **1,045 文件**；默认恢复到 `.docker-k-ecosystem-restore` 同样校验 1,045 文件。知识 object 与两个来源 manifest 共 3 文件 SHA 完全一致。恢复实例 paused=true、pending queue=0、active owned cron=0、account owners=0，模型和 YouTube 授权文件未恢复。恢复实例已停止并保留。原有账号、稿件和发布任务与升级前快照完全一致，工作实例发布和定时创作保持暂停。

最新账号阻塞见 [accounts](accounts.md)。Linux 设备授权在未完成期间超过 15 分钟；需本人重新启动官方流程。原生 Chrome 因 k 锁屏无法继续，但已独立核验 radar profile 和 YouTube Studio 目标频道。可选 Selenium image 下载未在生命周期 timeout 内完成，实际 Docker Chromium smoke 仍未通过。无 Postiz key/扩展配对、无新真实草稿或公开提交，不能声称所有平台已自动发布。阶段二、全新一键安装/客户端、PDF/Office、48 小时稳定运行和逐平台 live 验收仍未完成。

## 2026-10-15 知乎验收续接

本节最新检查点覆盖前文“扩展未安装/未配对、知乎待登录”的历史阻塞。用户选择优先验收知乎文章草稿。k 解锁后，原生 Chrome 菜单再次确认 radar profile 的 radarxai@gmail.com；知乎首页已登录为「孔涛」，个人主页为 `https://www.zhihu.com/people/kong-tao-1-90`。

用户已按安装框实际显示的“读取和更改所有网站数据、管理下载”权限批准官方 WechatSync **2.0.9**。首次安装与私密配对曾成功：即时 `draftBridgeStatus.connected=true`，知乎独立真实 `checkAuth` 在 **177 ms** 识别「孔涛」与真实 UID，`bindDraftAccount` 成功绑定账号 `390dfd96-6e1d-40ca-be9f-aacf43f5d510`，`status=connected`、`permissionConfirmed=true`。这是已完成的身份与绑定证据；重装后的连接与真实草稿验收结果以下文为准。不记录 UID 或配对秘密。

草稿连接接口新增严格的可选单平台参数；本轮界面默认知乎，初次加载、刷新和保存配对后的刷新均传 `platform=zhihu`，其余平台明确保持未核对。上游 `checkAuth` 超时或失败只返回固定安全诊断，清除缓存 UID/用户名并拒绝绑定与草稿保存；正常未认证结果仍按未认证处理。配对面板改用独立展开状态，输入 Token 或状态刷新不会覆盖用户展开；初始未配对、保存成功和显示连接地址会明确展开。

新版桥先通过内部固定本地探针，才将连接标记为已认证并允许业务请求；随后每 **20 秒**执行一次 `checkAuth({platform:'zip-download'})`，最多一个独立心跳在途，**8 秒**超时。长业务在途仍继续心跳；公开三平台 allowlist 不变，断线/失败/配置轮换统一清理，已派发写入保持未知结果且不自动重发。[固定上游 ZipDownloadAdapter.checkAuth](https://github.com/wechatsync/Wechatsync/blob/a98e42865387285afcc027c61836488748f3b30f/packages/core/src/adapters/platforms/zip-download.ts#L27-L35) 只返回本地常量，不读取真实平台身份或产生下载。[Chrome MV3 WebSocket 指南](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) 支持用应用消息保持已有连接；[官方冷唤醒限制](https://developer.chrome.com/docs/extensions/develop/concepts/real-time#not-great-for-push-notifications) 说明 WebSocket 不能从扩展外部唤醒已休眠 worker，因此不保证桥长时间停机后的自动冷恢复。

本轮最终 Docker 严格 TypeScript 与全量测试通过，**326 项：325 通过、0 失败、1 跳过**（历史 macOS `say`），覆盖之前的 325 项检查点；空 Sources 展示修正另通过 **22 项 targeted 测试**，**`9b9e68e`** 已构建并部署 API/delivery-worker。完整验证范围见 [acceptance](acceptance.md#latest-k-checkpoint-2026-10-15)。既有 one-off `tests/ecosystem-docker-smoke.ts` 在随机工作区 `f99fa126-e3c2-4150-82b7-7fbe9ba7e41d` 通过真实 Supabase/pgmq、fixture 模型与扩展流程，并清理该数据库工作区；fixture 测试本身不算真实平台验收。

旧桥版本的真实被动测试已完成 **120 秒**：直接读取 `draftBridgeStatus.connected` 布尔值，t=0、t=15 为 true，t=30 至 t=120 均为 false。这与更早误读中文状态标签的无效采样不同，是有效旧版本断连证据。**新版随后完成正式 180 秒真实 idle 验收，13/13 次 authenticated connected 均为 true**；采样日志时间 **03:18:02–03:21:02**，扩展设置已关闭、Chrome 保持 neutral tab。已有连接保活在该区间通过，长时间停机后的冷唤醒仍无保证。中途的知乎 10 秒超时已被后续新鲜 **200 OK / 320 ms** 和 **120 ms / 154 ms** 核验成功覆盖，不再列为当前阻塞；原生 `/api/v4/me` 显示孔涛且无 challenge，临时 DevTools/扩展详情页均已关闭。详细观察见 [accounts](accounts.md#k-account-continuation-2026-10-15)。这不保证未来网络可用，草稿派发仍须通过其当次身份核验。

一次可访问性输出意外显示扩展静态 Token 后，已从官方商店重装扩展撤销旧 Token，并通过 IAB Accounts 保存新 Token、轮换 pairing/service key。扩展连接地址与 Token 已做私密相等确认。中途的等待连接、disabled 开关及空白网页是历史排障观察，已由后续浏览器交互恢复、新鲜身份核对和正式 idle 通过的证据覆盖。原 UID 绑定记录保留，owner 工作区仍为 **6 个账号、6 条既有 job、paused=true、0 条新增知乎 job**；独立 QA 工作区现为 **1 account / 1 draft-save job**。本轮新增 **1 条真实私密知乎草稿、0 条公开帖文**，不混入 owner 数据。

**Linux 模型容器授权与 readiness 已通过。** 用户明确将 Codex 授权改用 Chrome profile **`zill.xkk@gmail.com`**，操作前已可见核验；选择现有同一 OpenAI 账号的 **Personal account → Continue**。owner 说明旧 alias 是同一账号改邮箱前的身份，旧私人邮箱不记录。`model-login --method browser` wrapper **exit code 0**，主 `model-runner` 的 `codex login status` 为 **Logged in using ChatGPT**，`/readyz` 为 **200 / ready=true**。临时登录/operations 容器均未残留，临时 0600 URL handoff 文件已删除；device-code 安全开关没有改，host/profile 凭据没有复制。此前 Not logged in、空白 choose-account 与手机号路径均为历史观察；当前不需要重复向 owner 提问或修改全局设备码设置。可选 browser 路线只在 one-off 期间做 host loopback 1455→容器 relay 1456→CLI localhost 1455 的原样 TCP 转发，默认 device 路线保持不变。边界见 [Docker runtime](docker-runtime.md) 和 [accounts](accounts.md)。

新增人工显式执行的 `tests/ecosystem-live-generation.ts`，用于独立持久化 bind 和随机 Supabase workspace 的真实母稿、知乎文章生成。使用合成的非私密软件知识材料，保留固定摘录、运行、修订和生成文件哈希；没有模拟模型、审批、账号配对、投递或清理路径。失败保留 manifest 和快照，修复授权后显式 `--retry`。这份脚本及其 TypeScript 检查本身不算真实模型生成或平台草稿验收。

脚本增量 Docker 严格 TypeScript 检查通过。较早的 one-off Docker 预检在 `readiness` 处返回 `workspaceInitializationAttempted=false`；当时随机工作区 `a95e8c1b-966e-4190-b074-28be2dd66017` 行数为 0，仅保留私有 manifest。授权成功后，`tests/ecosystem-live-generation.ts --confirm-isolated-generation --retry --root /acceptance-live/zhihu-live-pFLXZR` 已使用真实 **gpt-6.1-sol** 完整成功，**exit code 0**；“运行中、尚无结果”的中间状态现已被成功结果覆盖，无需重试已成功的运行。

实际 workspace 为 `a95e8c1b-966e-4190-b074-28be2dd66017`，task 为 `9e43d87e-71cf-44eb-a076-d7466d7394af`，run/draft 为 `a18d6681-d1e2-4d65-89bd-497ef2a54c03`、**revision 1**。来源快照固定于合成的软件备份/修订原则知识；实文件为 **master 5,582 bytes、知乎文章 6,323 bytes、导出包 14,865 bytes**。主流程已全文复核题材与安全边界，这不代表公开发布批准。生成完成时隔离 workspace 内为 **0 accounts / 0 jobs**，后续真实草稿验收仅向该 QA 工作区加入一个账号和一条 job。旧预检零行观察不能再当作当前工作区状态。

独立审查补齐进程中断后的 active run 恢复：等待原 lease/队列可见性到期，领取原消息并沿用快照，不另建 run 或自动重送；这仍是故障恢复规则，不是要求重试已成功的生成。安全 Markdown→HTML 与空来源展示修复已部署。

人工显式真实草稿脚本 `tests/ecosystem-live-draft.ts --confirm-isolated-zhihu-draft --root /acceptance-live/zhihu-live-pFLXZR` 已**单次派发成功，exit 0**。job `37ed121b-ded0-4d7b-ba22-05faa138755b`、operation `9e0945e4-efef-4bc6-ae61-49819a5b25c3` 为 **draft_saved / attempts=1**，原生草稿 **`2094031460613281455`**。radar 原生知乎编辑器实际核验账号孔涛、精确审查标题、5 个 H2、列表、加粗与 source SHA 均正确，无 `##`/`**` 字面符号，状态为「刚刚·草稿」；关闭首 tab 并在独立 radar 窗口重开同 URL 后内容仍在，截图保留于 ignored 本地证据。QA 4311 活动页另显示 operation 已完成、「已保存草稿 · 未发布」、尝试 1。

**03:48:34.167Z** 已实际保存 **operator_verified**，attempts 仍为 **1**，公开 `remoteId`/`remoteUrl` 均为 null。再次执行同一人工命令 **exit 0 / inspectedOnly=true / dispatchedThisInvocation=false**，返回同一草稿回执，未重复创建。IAB 发布记录实际显示「平台原生草稿已记录」「已由操作人到草稿箱核对」、真实 ID/URL 及「已保存草稿·未发布」。完整标题、时间与[编辑器回执见 accounts](accounts.md#live-zhihu-draft-acceptance-2026-10-15)。QA 临时 tab 已关闭，4311 API 容器已停止并移除；主 4310 保持运行，QA DB/manifest 和独立 radar 原生编辑器窗口保留。最终全量回归已通过上述 **326 项**检查；其他平台、冷唤醒、48 小时稳定运行及可选 browser 验收边界保持未完成。

历史上，可选 Docker browser-start 在 600 秒启动等待后返回 `docker failed (130)`，镜像和 browser 容器未出现；wrapper 未暴露具体 registry/网络错误，随后 browser-smoke 返回缺少可选服务的兼容性阻塞。可选 Selenium/Chromium 仍未验收。早期设备码曾在等待期间超过 15 分钟；已过期的码不能复用，也不能作为当前 Pro 账号需要手机号的证据。上述真实模型生成与知乎私密草稿回执已通过各自检查，未请求公开发布。
