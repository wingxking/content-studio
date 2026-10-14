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
