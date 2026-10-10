# 四个平台发布权限、自动化政策与账号风险复核

核查日期：2026-10-10。本文只核查公开的一手资料，没有读取账号凭据、操作账号或发布内容。政策页面可能继续变化；具体账号的可用功能、授权范围和限额仍需实际验收。

## 结论

可靠产品应优先采用平台批准的 API 与 OAuth，明确记录用户的发布授权，并以平台回执和公开可访问的作品链接完成验收。无头浏览器和 Codex 可见电脑操作都是自动化技术；窗口是否可见、是否模拟鼠标点击，并不会自动获得平台许可，也不能保证不会封号。

本次请求中的 X 自动追热点存在明确政策冲突：官方自动化规则禁止自动发布趋势话题，也禁止非 API 自动化，例如脚本操作 X 网站。应生成候选文稿，由真实用户决定是否手动发布；不能把“Codex 像人点击”当作该限制的替代路线。[X Automation Rules](https://help.x.com/en/rules-and-policies/x-automation)

| 平台 | 产品化发布首选 | 本次账号已登录还缺什么 | 可见浏览器 / 无头浏览器判断 |
| --- | --- | --- | --- |
| YouTube | YouTube Data API，OAuth 用户授权，真实视频上传 | Cloud 应用、启用 API、上传 scope、频道、明确内容与可见性选择 | 官方条款限制未经许可的自动化访问；官方 API 更适合持续产品运行 |
| X | 获批应用和用户 OAuth 的 `POST /2/tweets`，只发布政策允许的内容 | Developer App、写权限、计费额度；热点自动发仍禁止 | 非 API 网站自动化被明确禁止；可见 Codex 操作不应成为规避路线 |
| Reddit | 注册 App、获得批准的 Data API / Devvit 适用能力 | App 注册与用途审批；商业产品另需书面许可 | AI agent 也在现行 App 规则范围；不能假装人类或绕过注册要求 |
| 小红书 | 账号本人使用原生编辑器发布；取得允许范围明确的官方接入后再自动化 | 个人笔记 API 权限未获证明；本次内容资格待账号级确认 | 用户协议限制未经许可的第三方工具，社区规则列明机器发布；可见 Codex 没有明确豁免 |

以上为依据官方资料作出的工程选型建议，不是对账号安全的承诺。

## YouTube

### 发布接口与验收

`videos.insert` 上传视频，接受 `video/*` 或 `application/octet-stream`。纯文章、视频脚本、封面图不等于已上传视频；没有媒体文件会返回 `mediaBodyRequired`。最小上传授权可使用 `https://www.googleapis.com/auth/youtube.upload`。必须另外确认用户真正拥有要上传的频道。[Videos: insert](https://developers.google.com/youtube/v3/docs/videos/insert)

YouTube 社区文字 / 图片帖是另一种功能，要看频道实际资格和功能开通状态。当前 Data API 资源与方法未提供通用的 Community Post 写接口，不能把历史 channel bulletin / channel discussion 接口当作现代社区帖 API。若要保证自动化发布有正式接口，当前项目应生成并上传真实视频。[Community Post 帮助](https://support.google.com/youtube/answer/7124474?co=GENIE.Platform%3DDesktop&hl=en)、[API 资源概览](https://developers.google.com/youtube/v3/getting-started)

API 的成功响应只有作品 ID，不证明视频完成处理、公开或可播放。应保存 ID，随后检查 processing / upload / privacy 状态，并检查最终 watch 或 Shorts 页面；不可把 `public` 请求参数、上传进度条或 HTTP 200 当作公开发布验收。

### 需要纠正的旧信息

2026-10-08 更新的 canonical `videos.insert` 文档现写明：未经验证 API 项目的上传“不再受限于 private viewing”。但旧的 `videos` 资源说明和 2020 年 revision history 仍保留 private-only 表述。因此不能继续把“新项目必定只能私密上传”当作已确认现行结论，也不能保证每个账号都会公开成功。应记录文档冲突，以具体项目和频道的实际返回及作品状态验收。[最新方法文档](https://developers.google.com/youtube/v3/docs/videos/insert)、[资源文档](https://developers.google.com/youtube/v3/docs/videos)、[修订历史](https://developers.google.com/youtube/v3/revision_history)

当前概览列出的默认配额为上传 `videos.insert` 100 次 / 日、搜索 `search.list` 100 次 / 日，其余接口共用 10,000 units / 日。2026-06-01 开始拆分 upload / search buckets；不要使用旧的 1,600-unit 上传成本推算当前默认能力。Cloud Console 的项目实际配额仍是最终依据，扩容按官方申请与审核流程办理。[API 概览](https://developers.google.com/youtube/v3/getting-started)、[Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost)、[修订历史](https://developers.google.com/youtube/v3/revision_history)

### OAuth 与自动化边界

用户登录 Google / YouTube 只建立浏览器会话，不会向产品签发上传 OAuth token。External OAuth 应用若处于 Testing，含 YouTube scope 的 refresh token 通常 7 天到期；用于公开产品时还需按申请的敏感 scope 和应用状态完成相应 OAuth 上线 / 验证。OAuth 验证、YouTube 配额 / 合规审核、频道功能资格是不同事项。[Google OAuth 文档](https://developers.google.com/identity/protocols/oauth2)、[应用状态说明](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)

YouTube 条款禁止未获许可的自动化方式访问；API 开发者政策要求用户知情、同意并对发布数据保留最终控制。工程建议是保留选题、标题、描述、可见性、AI 属性的可审阅版本及明确授权，不以登录 cookie 驱动无人值守网站脚本。[YouTube Terms](https://www.youtube.com/static?template=terms)、[Developer Policies](https://developers.google.com/youtube/terms/developer-policies?hl=en)

### AI 与新闻质量

需要披露的是逼真或实质改变现实的 AI 内容，例如让真人说没说过的话、伪造真实地点事件、生成逼真场景，以及以 AI 音乐为主体的内容。脚本、标题、信息图等创作辅助通常不需同样披露，但不能据此隐藏其他应披露的媒体。API 支持 `status.containsSyntheticMedia`，Studio 当前帮助页称为 “AI use”。新闻视频不可把合成场景冒充现场。[GenAI disclosure](https://support.google.com/youtube/answer/14328491?hl=en)、[API 修订历史](https://developers.google.com/youtube/v3/revision_history)

现行 Spam Policy 明确禁止用 AI / 自动化工具大量生产仅做微小变化的重复视频、无附加价值的搬运和欺骗性标题封面；少量真实尝试并非同一概念。YPP 的 inauthentic / reused content 政策另决定是否可变现，“暂未封号”也不等于可变现。应加入独立核实、原创解释、每条实际有差异的编辑和媒体素材权利证明。[Spam Policy](https://support.google.com/youtube/answer/2801973?hl=en)、[Monetization Policies](https://support.google.com/youtube/answer/1311392?hl=en)

## X

### 官方发布能力

`POST /2/tweets` 可创建 Post，需 User Context OAuth，不能用仅 App-only 的 Bearer Token 代替用户发布授权。当前页面列出 `tweet.read`、`tweet.write`、`users.read`；长期后台任务另需 `offline.access` 获取 refresh token。OAuth 授权本身仍不能替代对具体自动化行为的明确用户同意。[Create Posts](https://docs.x.com/x-api/posts/create-post)、[OAuth PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)

普通 Post 的典型长度上限为 280 characters，长帖是 Premium 功能；不能因为用户注册账号就假定可以发长文章。实际计数应按平台字符规则处理，并区分 UI Premium 长帖与当前 API 支持能力。[Post 类型](https://help.x.com/en/using-x/types-of-posts)、[字符计数](https://docs.x.com/fundamentals/counting-characters)

当前官方价格页显示一般 Post create 为 $0.015 / request，含 URL 的 Post create 为 $0.200 / request；这是 X API 的成本，不包含 Postiz 等中间商费用，价格以 Developer Console 为准。为省费用故意隐藏来源会损害内容可核验性，不应作为内容策略。[API Pricing](https://docs.x.com/x-api/getting-started/pricing)

### 对本次热点请求的直接限制

官方自动化规则允许合规、具有信息价值且有发布权的外部 RSS 等信息，但同时明确禁止自动发趋势话题、单账号或多账号重复 / 高度相似 Post，以及非 API 网站自动化。不能选择浏览器鼠标操作来消除该内容限制。AI 自动回复还另需 X 事先书面批准；不应顺手增加自动评论、自动点赞或追随等增长功能。[Automation Rules](https://help.x.com/en/rules-and-policies/x-automation)

本次可交付 X 文稿与来源，由真实用户作编辑决定并手动发布。以后若做常规新闻 / 信息自动化，要使用获批 API、明确主题范围和政策审核，不构建追热榜自动发布器。

## Reddit

### 注册和商业许可

2026-10-05 更新的 Responsible Builder Policy 要求 API 访问先申请并获得明确批准，App 注册、开发者档案与 App 标识；禁止混用人类 / App 账号和隐瞒访问用途。现行 Rule 8 对 AI agents、bots 和非人类账号明确适用，禁止伪装人类和未经注册的 App。可见浏览器不是正式豁免条款。[Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)、[Don't break the site](https://support.reddithelp.com/hc/en-us/articles/360043512931-Don-t-break-the-site)

产品如代表商业活动使用开发者工具，或用于付费 / upsell 服务，需要 Reddit 的事先许可；OAuth token 不会自动授予商业用途权。Devvit 推荐用于 Reddit 内部应用，不支持的用途走官方 ticket；不能简单把老式 script App 教程视为当前申请已经获批。[Developer access](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data)、[Data API Terms](https://redditinc.com/policies/data-api-terms)

批准后 Data API 用 OAuth 与真实描述性 User-Agent；官方 Wiki 对符合免费资格的客户端列出 100 QPM / OAuth client ID，读取 `X-Ratelimit-*` 头。技术提交路线是 `/api/submit` 的 self / link Post 与相应 `submit` 权限，但 Wiki 自己提醒旧文档可能过时，必须结合用途批准和当前返回能力验收。[Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)、[官方历史 submit 文档](https://github.com/reddit-archive/reddit/wiki/API:-submit)

### 个人主页与社区

自己 profile 发帖确实是 Reddit 原生支持的功能，仍受 Reddit Rules 和 Moderator Code of Conduct 约束。它可以避免随意选定 subreddit 导致的当地主题、AI 禁令、链接格式、flair、账号年龄 / karma 门槛，但不会带来热门社区曝光，也不会免除 App 政策。[Profile tools](https://support.reddithelp.com/hc/en-us/articles/115002454126-What-kind-of-profile-moderation-tools-do-I-have)、[官方社区管理建议](https://mods.reddithelp.com/hc/en-us/articles/360002551551)

不得批量向不同 subreddits 投放相同 / 高度相似文本，刷 karma、反复删除重投或用多账号操纵。不要虚构“一天几帖”“养几天账号”就一定安全的数字。真正的人类可在自己的 profile 单次发布原创且有来源的 AI 辅助文章；持续产品自动发布应先具备 App 身份与批准。本文没有查到官方明确声明“个人用户的 Codex 可见 UI 代发免于 App 注册”。[Spam](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam)

发布验收需同时检查 Post ID / permalink、作者 profile 列表与是否被 removed / spam / moderation 标记。可在个人主页访问不等于已经进入某个 subreddit feed。

## 小红书

### 不同官方开放能力不能混用

电商开放平台针对商品、商家经营等应用类目；新 openaccount 公开文档提供 OAuth、基本用户信息和解除授权等能力。它们不证明普通个人账号拥有远程发布笔记的服务端权限。当前没有找到面向任意个人账号的通用官方后台笔记发布 API，不能宣称完全不存在任何合作接口，但必须拿到具体接口及准入证明再接。[电商应用类目](https://open.xiaohongshu.com/document/developer/file/33)、[openaccount API](https://openaccount.xiaohongshu.com/docs/api-reference)

官方分享 JS SDK 是拉起小红书 App 发布能力的工具。搜索抓取到的官方文档明确提示，不再支持自动填充标题、文案、话题，图片 / 视频不受同样影响；直接页面抓取本次超时，所以后续接入需再确认实时文档和应用审核。分享不等于无交互的服务端公开发布。[官方 Share SDK](https://agora.xiaohongshu.com/doc/js)、[分享平台](https://agora.xiaohongshu.com/)

创作者后台出现 Builder Hub / RED Skill 是真实产品功能线索，但应区分“发布小工具 / Skill 包并挂到笔记”与“对普通笔记发文有官方 API 权限”。本次找到官方 CDN 的小工具邀请说明，描述 Builder Hub 用于小工具创建、上传、管理，未给出通用账号笔记自动发布许可；不应从侧边栏推断获得自动新闻分发权。[官方创作者入口](https://creator.xiaohongshu.com/)、[小工具邀请说明](https://fe-video-qc.xhscdn.com/fe-platform-file/104101b8322bpulog7u06f48k3g2740000000016rhrpc6)

### 第三方工具和机器发布的实际条款

本次从小红书官方协议应用的公开合同接口取得现行条款。2026-03-23 更新的用户协议 §4.1 限制使用未经小红书开发、授权或许可的第三方软件、插件、外挂、系统登录或使用平台；§2.3 另涉及第三方使用账号。社区规范 §4.4.3 将批量发布、高频发布和机器发布列入异常发布模式，§4.4.4 另限制程序、脚本制造虚假互动。这是实际条款，不只是一般封号风险推测。[用户协议](https://agree.xiaohongshu.com/h5/terms/ZXXY20220331001/-1)、[社区规范](https://agree.xiaohongshu.com/h5/terms/ZXXY20221213003/-1)

条款没有明确写出“可见、经账号主人授权的 Codex 代发”例外，也没有界定一次辅助点击是否算机器发布。工程上不能据此声称已获平台许可。当前发布包由账号主人在原生编辑器审阅并亲自点击发布；持续自动发布需取得允许范围明确的官方接入或平台书面授权。人工提交仍需通过实际内容审核。

### 内容与账号风险

2026-07-31 社区公约 2.0 建议主动标明 AI 生成 / 辅助参与；分享应真实、有素材使用权，存疑内容核实来源，转载需授权和出处。新号不能因为改写新闻就伪装成亲历者 / 专业人士，不可用刷互动和矩阵“养号”增加可信度。[社区公约 2.0](https://pgy.xiaohongshu.com/help/detail?id=1eda0a065dd894063c2e029a49e8f6a1&userType=4)、[作者健康等级规范](https://pgy.xiaohongshu.com/help/detail?id=1e77b1987d1646def00d556d9879f19f&userType=4)

本次选题为诺贝尔和平奖及 ICC / ICJ：国内官方规则把政治、经济、军事、外交等公共事务的报道和评论纳入新闻信息；公众账号运营者提供新闻信息服务需许可。改成“中立科普”不能自动证明脱离该范围。[互联网新闻信息服务管理规定](https://www.cac.gov.cn/2017-05/02/c_1120902760.htm)、[公众账号管理规定](https://www.cac.gov.cn/2021-01/22/c_1612887880656609.htm)

2023 自媒体通知还要求国内外时事等显著注明来源，技术生成媒体明确标注；金融、教育、医疗、司法等专业领域需平台核验资格。2021 公众账号规定第九条涉及申请注册生产专业领域信息内容的账号，2023 通知涉及从事专业领域内容生产的自媒体。它们未明确界定偶尔的个人学习笔记与专业领域内容生产的门槛；本次也未核验该账号的资质状态。因此该条诺贝尔奖 / 国际法院科普的账号级分类仍未知，不能断言必需资质，也不能断言肯定豁免。商业专业号标识不能直接替代新闻许可或司法领域资格。向小红书支持提供这篇实际文稿，询问所需资质及提交入口，再按账号实际提示办理。[公众账号管理规定](https://www.cac.gov.cn/2021-01/22/c_1612887880656609.htm)、[自媒体管理通知](https://www.cac.gov.cn/2023-07/10/c_1690638496047430.htm)

## 应落实到产品的机制

1. **能力登记**：每个账号记录 native login、OAuth granted、App approved、commercial use allowed、content-category eligible、media support、limits；任何一项都不能由“已登录”推导。
2. **按内容分流**：X 趋势话题只能候选文稿；新闻 / 专业领域进入资格审核；其他允许的原创信息使用正式发布路线。平台约束应由执行层校验，而非只写进 Prompt。
3. **证据优先**：抓取时间、事件时间、原始机构来源、第二独立来源、争议与不确定性记录在草稿；只改写事实，不搬运整篇文章、新闻照片、音乐或别人的视频。
4. **明确发布授权**：实际账号、具体内容版本、媒体哈希、可见性、目标社区和 AI 披露一并保存。后台自动任务需可停止、可撤销未来任务；已发布内容的删除是独立动作。
5. **低并发与官方限额**：每账号一条活动任务，读取服务限额和 `Retry-After`，遇到验证、登录失效、权限不足、审核删除立即暂停。少量开始是验收策略，不是“低于某数字必不封号”的规则。
6. **避免重复投放**：每平台按受众重写格式，并对同平台近期内容去重；不做批量评论、陌生人私信、买互动、刷播放或假装真实用户。
7. **发布结果对账**：上传、接受、排队、处理中、公开、受限、审核中、失败、未知结果分别建状态；未知结果先查已有作品，不盲目重试造成重复。
8. **审计与账号健康**：保留安全的任务 / 回执 / 错误证据，不保存 cookie 或 token 在仓库；平台警告触发停机和官方申诉，禁止账号替换、代理轮换或指纹伪装来规避限制。

阶段一可以让本机 Codex 完成发现、来源交叉核实、文稿、卡片 / 视频制作和发布包，但每个平台的最终发布路线必须分别通过权限、政策和实际结果验证。阶段二应把许可 API 适配、OAuth 令牌安全保存、队列、回执和撤销能力搬到云端；不以“把浏览器藏到服务器”作为产品独立化方案。
