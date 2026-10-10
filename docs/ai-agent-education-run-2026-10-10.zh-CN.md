# AI Agent 教育内容发布及旧内容下架

核查日期：2026-10-10，Asia/Singapore。用户要求排除政治、军事题材，撤下前一条内容，改为 AI Agent 赋能 AI 教育的实践内容。

**旧视频已改为 Private 下架；新教育视频已在 YouTube 公开。X、Reddit、小红书尚未提交。** 第一阶段整体验收未完成，第二阶段未开始。

## 旧内容下架证据

- 原视频 `aKaJ3qBAhCc`、任务 `489d1309-02d4-47e8-9d0b-3a9fba52b864` 曾真实公开，历史回执保留。
- 原草稿 `ddfd86a0-eb21-4eed-9556-b03ef3e37630` 已推进到修订 8，审批清空；原任务的修订 7 快照不变。旧内容不再授权重发。
- 用现有 `youtube.upload` / `youtube.readonly` 调用 `videos.update` 返回真实 HTTP 403 `insufficientPermissions`；没有扩大 OAuth 范围。
- Chrome 页面恢复可操作后，在准确旧视频的 Studio 页面选择 **Private → Done → Save**；页面显示 **All changes saved**、Private 和禁用 Save。
- **06:36:33.598 UTC** 官方 API 确认同一作品 `private / processed`。同一频道 Shorts 列表也显示旧项 **Private / Uploaded**。
- 这是可逆的私密下架，没有永久删除。现有状态枚举没有 withdrawn/private，因此旧任务变为 `needs_reconciliation` 并保留历史 ID/URL；实际下架结果已明确，不是未知结果，不应重新上传。

## 新内容和核验

主稿：**让 AI Agent 组织练习：30 分钟构建一个 CSV 读取工具**。面向成人 Python 和 AI 素养学习，教学 Agent 检索获准文档、提供分级提示并运行核对过的测试；学习者先尝试、解释代码、调试，然后关闭 AI 完成变化输入的新任务，次日再检。

这是具体实践提案，30 分钟是建议分配，不是已经验证的完整干预，更不承诺成绩。没有虚构个人实验、已部署辅导系统、教师资格或自主 Agent 的研究效果。示例使用虚构水果 CSV，不使用学习者个人数据。

一手依据：

- [Anthropic 编码技能研究](https://www.anthropic.com/research/AI-assistance-coding-skills)：52 名主要为初级的开发者；即时成绩 50% 与 67%，相差 17 个百分点，速度差异不显著。测试的是侧栏助手；探索性关联不作因果或长期结论。
- [Scientific Reports 物理辅导研究](https://www.nature.com/articles/s41598-025-97652-6)：194 名本科生、两节物理课；不直接推广为成人编程、自主 Agent 或普遍长期效果。
- [Python csv 官方文档](https://docs.python.org/3/library/csv.html)：仅作为 DictReader、缺失字段和文件读取的接口依据。

真实 Codex 生成得到独立草稿 `823d5dbf-9b3f-4e3c-a7ab-edf9ca7ed317`，不是覆盖旧草稿。审稿与素材附加后最终审批修订 **4**。独立事实复核未发现实质问题；X 273 字符，小红书标题 12 字符、正文 884 字符，YouTube 105 个旁白词。

小红书：4 张 1080×1440 PNG，全部视觉检查；来源为第四张卡。YouTube：8 个场景、46.10 秒、1080×1920 H.264/AAC MP4，975,790 bytes，SHA-256 `524616e2947f2fa9669a2a8431baef3fd316447906edff05d8e65d3cdd4a0e54`。画面样本和完整旁白核对，音轨均值 -15.9 dB、峰值 -1.7 dB；这些检查不代替真人完整质量审阅。

## YouTube 真实发布

- 保留已授权的原 RadarXAI 账号，准确频道 `UCVUtH6reLkEuMrUuTh-XgjQ`；没有另建账号、客户端或申请更宽权限。
- 新任务 `78fb0a72-f850-4bd3-a48b-0f9629e4e264`，**1 次提交、1 个私有 journal**，独立于旧作品。
- **06:37:59.454 UTC** 官方 API 确认准确频道、`processed / public`，任务为 `published`。
- 视频 **X8dDltMseM4**：[公开作品](https://www.youtube.com/watch?v=X8dDltMseM4)，[Shorts](https://www.youtube.com/shorts/X8dDltMseM4)。标题：**An Adult AI Learning Loop: Build a Toy CSV Tool**。
- Studio Shorts 显示新视频 **Public / Published**，旧视频 **Private / Uploaded**。
- watch 页核对新标题、RadarXAI 作者及 AI 标识；已登录播放器到达 **36/46 秒**。完整播放结束、主观音画质量、匿名及各地区访问尚未另行确认。
- 上传设置：公开、非儿童向、合成媒体披露、教育类别、英文。描述包含 AI 辅助及普通 macOS 合成旁白说明和三项来源，无真人仿冒或纪实素材。

## 其余渠道和自动发布条件

| 平台 | 新稿状态 | 自动发布需补齐 |
| --- | --- | --- |
| X `@radarxai` | 文案准备完成，未提交 | 原创教育稿为 editorial，可走合规官方 API；配置实际开发者应用、用户发布授权和可用额度，或获准 Postiz 集成。当前 `postizConfigured=false`，没有可用发布配置。网站脚本/Codex 点击不能替代 API 路线。 |
| Reddit `u/radarxai26` | 完整文章准备完成，未提交 | 获批 App/agent 接入、对应身份与适用商业许可，核查实际目标社区规则；个人账号登录不等于批准。个人主页稿可由本人原生发布。 |
| 小红书 `ziv / 63520392304` | 文案及 4 张卡准备完成，未提交 | 普通笔记的获准官方/合作接入或书面许可；当前不存在已配置通用路线。本人可在原生编辑器审阅并最终发布，保留 AI 披露及平台标识；该成人学习稿的账号级专业分类资格仍未知。 |

[平台政策和一手来源](platform-policies-v2.zh-CN.md)、[账号接入步骤](accounts.md)。更换无头浏览器、模拟鼠标或反检测配置不会获得平台许可，也不保证不封号。其余尚未接入平台没有提交或回执。

自动发布的具体申请和接入步骤见 [X、Reddit、小红书接入方案](automatic-publishing-access-2026-10-10.zh-CN.md)。

## 本地成品和后续

私有完整包：`.studio/exports/ai-agent-education-2026-10-10/`，包含主稿、四个平台文稿、已审批草稿、4 张配图、MP4、manifest 及操作说明。文件不包含 OAuth token、cookie、client secret 或上传 session URL。

旧内容下架记录：`.studio/ops/withdrawal-aKaJ3qBAhCc.json`；旧导出包已标为 withdrawn_private，不得重发。新 API 凭证与 journal 保持 ignored、文件 0600、目录 0700。

本轮为研究、真实生成/媒体、发布和记录更新，没有修改发布运行时代码；不把先前实现测试当作本轮真实账号验收。还需获准接入其他渠道、持续生产和指标、真实重启/授权续期、Supabase 持久化及阶段二产品化。
