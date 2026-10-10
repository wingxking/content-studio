# X、Reddit、小红书自动发布接入

核查日期：2026-10-10。目标为原创 AI/软件教育内容。网页登录、用户发布同意、平台 API 权限和可用额度是不同条件。当前这三家均未真实提交。

## X：优先接入官方 API

1. 在 [Developer Console](https://console.x.com) 登记开发用途、创建应用，填写本产品的真实功能，不声称已有发布资格。配置账号 OAuth 和准确回调地址。
2. 新接入优先 OAuth 2.0 用户授权：`tweet.read`、`tweet.write`、`users.read`；需要长期运行时另外审核 `offline.access`。本地回调按官方要求使用 127.0.0.1，生产使用 HTTPS。应用实际创建/权限授权仍须真实界面完成。
3. 保证账号有可用 API 余额或适用额度，设置消费上限。官方当前为预付、按调用计费；公开表格普通发帖 $0.015、含 URL 发帖 $0.200，实际请求和价格以 Console 为准。本文稿含研究链接；不能把普通帖价格作为它的费用。没有购买余额、绑定支付方式或开自动充值。
4. 用新教育稿做一次发布，校验响应 post ID、账号、内容和公开 URL；未知结果先对账，不能盲目重发。此后才接入已有本地任务协调器。

[官方接入流程](https://docs.x.com/x-api/getting-started/getting-access)、[应用与回调](https://docs.x.com/fundamentals/developer-apps)、[OAuth 2.0](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)、[计费](https://docs.x.com/x-api/getting-started/pricing)。

项目已有 Postiz X 文本适配，但 `postizConfigured=false`。自托管 Postiz 可配置自己的 X 应用；将 Postiz API key 留在本地环境/系统密钥存储，连接目标账号，再录入精确 integration ID。供应商 API key 不等于 X OAuth 权限。其 X 认证实现与当前 X v2 文档需实际兼容性核验，不能保证仅加一个 key 即成功；直接 OAuth 2.0 是明确备选。[Postiz X 配置](https://docs.postiz.com/self-host/providers/x-twitter)。

[自动化规则](https://help.x.com/en/rules-and-policies/x-automation)允许符合规则的信息型顶层帖，但限制自动趋势帖、重复内容及网站脚本。当前教育稿为独立 editorial 选题；旧趋势稿已撤回。API 接通不会解除选题、反垃圾或账户处罚规则。

## Reddit：申请获批 App 或 Data API

**社区 App 路线：** 注册 Devvit App，开发最小功能并送审；获得管理员允许后安装到具体社区，再申请 External Endpoints，供 Mac/云服务用 managed App Token 调用。该功能明确是 limited-access，额外审批不可略过；请求以 App 账号执行。当前个人主页是否可安装、账号适用范围和目标社区发帖条件都尚未确认，不能替换为自动向所有 subreddit 发帖。

[App 注册](https://developers.reddit.com/app-registration)、[送审](https://developers.reddit.com/docs/guides/launch/launch-guide)、[External Endpoints 与申请入口](https://developers.reddit.com/docs/capabilities/server/external-endpoints)。

**外部发布产品路线：** 不适合 Devvit 时，向 Reddit 说明产品、用途、发布目标、频率、数据和用户授权，申请 Data API。商业用途另需明确书面批准及适用合同。[开发用途申请](https://support.reddithelp.com/hc/en-us/requests/new?tf_42139884615700=api_request_type_developer_clone&ticket_form_id=14868593862164)、[商业申请](https://support.reddithelp.com/hc/en-us/requests/new?tf_42139884615700=api_request_type_enterprise_clone&ticket_form_id=14868593862164)。

Devvit `runAs: USER` 代用户操作要求逐次明确人工按钮动作，不构成无人值守个人账号代发许可。[用户操作](https://developers.reddit.com/docs/capabilities/server/userActions)。本项目未获得这些批准，不能仅复制已有登录或 OAuth token 开始自动发帖。即使获批，仍需检查实际社区的 AI、推广、flair 和账号要求。

## 小红书：先取得明确笔记写入权限

官方 scope 搜索索引显示 `basic_info` 已开放，`write_notes` 为“规划中”，特定场景人工审核。该 scope 页面本次直接抓取失败，属于官方索引证据，不能当作已经开放的实测接口。

可进入官方应用管理流程，提交真实业务场景、隐私政策和数据使用承诺，请平台确认：笔记发布权限是否接受本产品、实际接口、适用账号、审核/标识和第三方服务条件。获准后才评估连接现有协调器。没有申请答复或接口验证前，保留“未接通”。[快速接入](https://openaccount.xiaohongshu.com/docs/quick-start)、[scope 及材料](https://openaccount.xiaohongshu.com/docs/scope)。

[Share SDK](https://agora.xiaohongshu.com/doc/js)拉起 App 分享，并限制自动填充标题、文案及话题，不能作为无人值守笔记发布 API。现行[用户协议](https://agree.xiaohongshu.com/h5/terms/ZXXY20220331001/-1)和[社区规范](https://agree.xiaohongshu.com/h5/terms/ZXXY20221213003/-1)限制未经许可第三方工具及机器发布；没有查到 Codex 可见点击例外。当前可用路线为本人原生编辑器审阅与最终发布四张卡片/正文；保留 AI 披露及原生标识，账号级教育内容分类资格仍待具体核实。

## 项目交付顺序

先接通 X 并验证一次原帖；并行准备 Reddit 和小红书申请材料。可用渠道使用统一的“素材审查 → 修订审批 → 指定账号任务 → 官方/获准集成提交 → 作品 ID/URL 对账”，受限渠道保留人工交接。服务商、无头浏览器或鼠标自动化不能免除平台许可，也不能保证不封号。

所有密钥、token、cookie 留在本机环境/系统密钥存储或 ignored 私有目录，提供本地文件路径或完成 OAuth，不要发到聊天。当前没有新购 API 余额、创建这三家的开发者应用、授予新权限或提交审核。
