# Content Studio：当前进度、技术架构与功能架构

核查日期：2026-10-10（Asia/Singapore）。本轮以当前代码、真实 Codex 生成、实际素材、官方 RSS、Chrome 账号界面和 83 项测试核查；研究结论与真实平台验收分别记录。

## 当前结论

第一阶段仍未完整验收，第二阶段未开始。目前已能通过本机 Codex 完成地区热点采集、基于已核验资料生成四平台内容、图文和配音视频制作、审批及发布任务协调。**自动事实研究仍需 Codex 单独执行；已有 2 次不同视频的真实 YouTube 提交；旧政治/公共事务选题已改为 Private 下架，新 AI Agent 教育视频已公开。** 独立 Desktop AI-agent 客户端、指定测试用户和上传/读取授权已完成，官方 API 核验了准确频道；同一视频已通过 public/processed 对账、正确频道的 Studio 列表及已登录播放器进度检查。其他平台仍受政策和接入条件阻碍。

| 当前实际状态 | 核查结果 |
| --- | --- |
| 本地服务 | `http://127.0.0.1:4310`，本轮重新启动并通过 HTTP 冒烟 |
| 存储 | 本地 `.studio`；Supabase 适配未真实接通 |
| 内容库 | 3 份真实草稿；新教育稿包含 X、Reddit、小红书、YouTube 四版 |
| 当前教育素材 | 4 张 1080 × 1440 PNG；46.10 秒 1080 × 1920 H.264/AAC 配音 MP4、8 个场景 |
| 草稿审批 | 新教育稿修订 4 已审批；旧稿修订 8 已撤销审批，不再发布 |
| 已核验身份 | YouTube RadarXAI、X @radarxai、Reddit u/radarxai26、小红书 ziv |
| 真实 OAuth / 上传任务 / 当前公开视频 | 1 / 2 / 1；旧作品 Private；YouTube Connected，其他三账号仍 Blocked |
| 自动采集实测 | US/IN/GB/ZA 四个 Google 官方 RSS 成功，39 个候选；保留快照和地区信息 |
| 真实平台提交 | 每条视频 1 次提交、1 个日志；当前 [X8dDltMseM4](https://www.youtube.com/watch?v=X8dDltMseM4) 公开并处理完成；旧视频已私密 |

## 内容分析和发布的实际边界

**热点发现已自动采集。** `studio discover US,IN,GB,ZA 24` 请求官方 RSS，保存候选、相关新闻 URL、地区、RSS item 时间、抓取时间和流量桶。24 是客户端条目新鲜度，不是官方流量窗口；按选定地区覆盖数和字母顺序排序，不能证明全球最火。RSS 标题未核实，不会直接转换成事实或自动批准稿件。本轮皮莱选题来自更早的网页热度与官方新闻核验，后续 RSS 快照并未包含该词，二者没有混用。

**内容研究仍在应用之外执行。** 本轮由 Codex 单独浏览原始公告和独立报道，保存 8 个来源后再调用现有生成器。生成器只读取资料摘录，不浏览；自动打开新闻、提取正文、事实账本、语义事件聚类和竞品分析尚未集成。本轮工作流可由本机 Codex 编排，但不是无人值守事实研究引擎。

**创作和素材已真实完成。** 本机官方 Codex CLI生成主文章与四个平台版本，随后编辑核验。素材为原创文字信息卡和普通合成旁白视频；没有 AI 现场画面、纪实镜头或真人声音仿冒。新渲染器按词换行、按段落和句子分页；小红书将来源放到第四张卡，配文和旁白原文完整保存。

**YouTube 已完成两次不同视频的真实提交，旧视频已下架，其他平台尚未通过。** Postiz 仍只接入 X/LinkedIn 文本且未配置。YouTube Desktop OAuth、频道核验、官方 resumable upload 和对账 CLI 已用于本次真实交付；只接受指定频道和审批过的真实 MP4。上传前记录日志，未知结果只检查原 session/video，不新建第二次上传。旧视频曾完成公开和 47/47 秒播放核验，随后按用户要求设为 Private 并保存，官方 API 读回证实下架。新教育视频公开/处理完成，Studio Shorts 显示 Public/Published，watch 页核对标题、作者、AI 标识及 36/46 秒播放进度；当前两条列表项分别为 Public 和 Private。这不代表匿名或所有地区播放、真人主观完整音画质量、长期授权或重启恢复已验收。原生发布包仍仅交接给符合规则的操作方式。

**政策已影响执行。** 旧趋势稿已撤回；X 趋势自动发仍被阻止。新教育稿为编辑选题，可走获准 API，但 X/Postiz 尚未配置；原生包须真人发布。Reddit agent 需要批准 App；小红书仍缺普通笔记自动化许可，账号级教育内容分类资格未知。可见鼠标或无头浏览器不能替代权限或豁免内容规则。账号与政策详见 [接入记录](accounts.md)、[最新政策报告](platform-policies-v2.zh-CN.md)。

## 技术架构

```mermaid
flowchart TB
  RSS["Google Trends 官方地区 RSS"] --> DISC["CLI：候选、时间、地区、新闻 URL 与私有快照"]
  DISC --> RESEARCH["Codex 独立研究：原始来源和独立报道"]
  RESEARCH --> BRIEF["可审核来源摘录与选题简报"]
  UI["React + Vite 工作台"] --> API["Express / Zod / 严格 TypeScript"]
  API --> CORE["内容、审批、账号和任务协调层"]
  BRIEF --> CORE
  CORE --> GEN["本机 Codex CLI：结构化生成"]
  CORE --> MEDIA["librsvg PNG / FFmpeg + macOS say MP4"]
  CORE --> STORE["原子 JSON、进程锁与私有素材"]
  CORE -. "可选，未实测" .-> SB["Supabase PostgREST / CAS / RLS"]
  CORE --> POLICY["政策、审批哈希、目标账号与去重校验"]
  POLICY --> YT["显式 CLI：YouTube OAuth / 官方上传与对账"]
  POLICY -. "未配置" .-> POSTIZ["Postiz 文本适配"]
  POLICY --> HUMAN["原生包与符合平台规则的人工交接"]
  YT --> RESULT["API 状态、历史回执和公开播放独立验收"]
  POSTIZ --> RESULT
  HUMAN --> RESULT
  RESULT --> METRICS["人工指标快照；自动分析待接入"]
```

OAuth 采用 state、PKCE 和随机回环端口；凭证及上传 session URL 只存 ignored 私有文件。上传期间绑定同一授权 token，拒绝更换账号后的误投；并发对账跳过过期响应，不覆盖新发布结果。Mac 需保持唤醒，服务的 30 秒定时器仅派发已有任务；不会主动发现选题、轮询所有发布状态或唤醒 Mac。YouTube 上传须显式 CLI 调用，不由定时器自动执行。

## 功能架构与完成程度

| 模块 | 已实现与本轮验证 | 剩余工作 |
| --- | --- | --- |
| 业内调研 | Hootsuite、Feedly、Predis、OpusClip、Repurpose、Postiz、Buffer、AiToEarn、n8n 的一手资料 | 供应商真实账号与效果比较 |
| 热点发现 | 四地区官方 RSS、相关 URL、部分失败与时间/流量语义保存，真实采集成功 | 更广地区、语义事件去重、多来源综合评分 |
| 事实研究 | 本轮由 Codex 独立核实并保存来源简报 | 集成文章收集、证据提取、事实核验与更新流程 |
| 内容创作 | 真实主稿和四个平台版本 | 原创多模态画面、品牌与受众反馈 |
| 编辑审批 | 内容/媒体哈希、版本及账号绑定 | 用户在每次发布前的真实最终控制 |
| 图片与视频 | 新稿 4 PNG、46.10 秒 MP4；画面抽查、音视频轨道及音量检查 | 真人完整观看/收听与持续质量验收 |
| 账号 | 四个公开身份已核验；YouTube OAuth 与准确频道核验完成，账号 Connected | 其他平台 App 审批、内容资格及 YouTube 授权续期实测 |
| 发布与恢复 | 两个不同 YouTube 视频各一次官方提交，旧片 Private、新片 Public；公开/处理完成对账、频道列表和已登录播放器进度验证；无重复提交 | 其他平台接入、重复生产周期、重启恢复、匿名及地区播放验收 |
| 效果复盘 | 人工指标录入 | 自动采集、内容效果反馈与成本记录 |
| 云端产品化 | 尚未开始 | 第一阶段验收后改为模型 API、Supabase Storage/多租户、云端任务 |

## 本轮验证和资料

- 83/83 项测试通过，0 跳过；严格 TypeScript检查及生产构建通过。
- HTTP 冒烟通过：真实本地服务、素材字节、目录/来源限制和文档接口。
- 新契约测试覆盖 RSS/XML/超时、X 政策阻止、YouTube token 更换、存储先行、丢失响应、活跃上传者、并发过期对账、可见性变化与 OAuth 回调。契约测试采用模拟请求；之后另行完成上述真实 YouTube 授权、上传和读取，不把模拟测试当作真实账号验收。本次文档更新没有重跑测试。
- 历史任务 `489d1309-02d4-47e8-9d0b-3a9fba52b864` 绑定旧稿修订 7，现视频 Private；新任务 `78fb0a72-f850-4bd3-a48b-0f9629e4e264` 绑定教育稿修订 4，现视频 Public。二者各 1 次提交、1 个上传日志、1 个视频回执，均为准确频道 `UCVUtH6reLkEuMrUuTh-XgjQ`。凭据及日志文件为 0600，所在私有目录为 0700，文档不保存凭据值或上传 session URL。
- [第二轮业内调研](research-industry-v2.zh-CN.md)、[平台政策](platform-policies-v2.zh-CN.md)、[本轮新闻证据](news-topic-2026-10-10.zh-CN.md)、[历史运行及下架报告](news-run-2026-10-10.zh-CN.md)、[新教育内容发布](ai-agent-education-run-2026-10-10.zh-CN.md)。

阶段二继续保持未开始。第一阶段还需完成其他选定平台的获准发布、持续运行与重启恢复、授权续期、重复生产周期和真实指标；Supabase 尚未接通。
