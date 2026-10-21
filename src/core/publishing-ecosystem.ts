import { platformIds, type Platform } from './model.ts';

export type PublishingRouteKind = 'native_draft' | 'provider_draft' | 'inbox_upload' | 'direct_publish' | 'assisted';
export type PublishingRouteStatus = 'implemented' | 'requires_integration' | 'research_only';
export type EcosystemRoute = {
  id: string;
  name: string;
  kind: PublishingRouteKind;
  status: PublishingRouteStatus;
  platforms: Platform[];
  docsUrl: string;
  setupSteps: string[];
  limitations: string[];
};

// Implementation status describes this application's transport, not account readiness or live acceptance.
export function publishingEcosystem(): EcosystemRoute[] {
  return [
    {
      id: 'wechatsync_articles', name: 'WechatSync：公众号、知乎、B 站专栏草稿', kind: 'native_draft', status: 'implemented',
      platforms: ['wechat', 'zhihu', 'bilibili'], docsUrl: 'https://github.com/wechatsync/Wechatsync/tree/a98e42865387285afcc027c61836488748f3b30f',
      setupSteps: ['构建本项目 extension，在指定 Chrome 配置文件加载 extension/dist 并核对权限，登录目标平台。', '连接本地受保护网关，刷新扩展账号并绑定实际身份。', '选择已审阅的文章版本保存草稿，再打开平台核对正文、图片和草稿标识。'],
      limitations: ['传输适配器已接入；真实账号草稿验收尚未完成，仍需扩展配对、实际登录与逐账号验证。', '本项目还原的 2.0.9 扩展增加 Studio 草稿协议 v1；此入口仅启用已审阅的 weixin、zhihu、bilibili 文章适配器。', '扩展读取当前浏览器会话；登录失效、扫码或验证仍需账号所有者处理。', '适配器成功回报不等于平台独立回读，更不等于公开发布；结果不明时先到草稿箱核对，不能自动重发。', '扩展以 GPL-3.0 独立工程保留来源记录；其余还原适配器没有因此开放到 Studio。'],
    },
    {
      id: 'postiz_staging', name: 'Postiz：服务商审稿草稿', kind: 'provider_draft', status: 'implemented',
      platforms: ['x', 'linkedin', 'reddit'], docsUrl: 'https://docs.postiz.com/public-api/posts/create',
      setupSteps: ['配置 Postiz API 连接，在 Postiz 授权目标账号。', '刷新并核对 integration；Reddit 还需配置明确的社区与规则记录。', '将已审阅文字版本保存到 Postiz，之后在 Postiz 审阅并安排发布。'],
      limitations: ['传输适配器已接入；真实账号草稿验收尚未完成，仍需配置服务商并验证目标账号。', '草稿存储在 Postiz，不会自动出现在 X、LinkedIn 或 Reddit 的原生草稿箱。', '本项目本轮仅接入 X、LinkedIn、Reddit 文字；上游更多渠道需要独立适配与账号验收。', '保存草稿与公开发布分开；Postiz 草稿标识不能作为平台发布回执。'],
    },
    {
      id: 'youtube_official', name: 'YouTube：官方视频发布', kind: 'direct_publish', status: 'implemented',
      platforms: ['youtube'], docsUrl: 'https://developers.google.com/youtube/v3/docs/videos/insert',
      setupSteps: ['在 Docker 授权所选频道的官方 OAuth，并核对频道标识。', '审阅独立视频、标题、可见性与实际修订，明确授权提交。', '通过原上传会话恢复或核验，确认远端视频标识、处理状态和作品链接。'],
      limitations: ['已有实现与历史真实发布证据；具体账号仍须满足当前 OAuth、配额及应用审核要求。', 'Private / Unlisted 视频不是平台编辑器草稿，也不等于公开发布。', '上传结果不明时只核验原会话，不另建上传。'],
    },
    {
      id: 'postiz_text_publish', name: 'Postiz：已授权文字发布', kind: 'direct_publish', status: 'implemented',
      platforms: ['x', 'linkedin', 'reddit'], docsUrl: 'https://docs.postiz.com/public-api/posts/create',
      setupSteps: ['配置 Postiz 并只读核对目标 integration。', '完成当前账号及平台准入核验，Reddit 指定允许此内容的社区。', '批准具体修订后提交，再核对真实作品标识、账号与链接。'],
      limitations: ['实现可用不表示当前账号已经连接或完成真实发布验收。', 'X 热点来源内容保留真人发布；Reddit 自动访问需要应用批准及有效社区规则记录。', '服务商排队或成功响应不能替代平台作品回读。'],
    },
    {
      id: 'wechat_official_cli', name: '公众号：官方草稿 API / wechat-mp-cli', kind: 'native_draft', status: 'requires_integration',
      platforms: ['wechat'], docsUrl: 'https://github.com/fatecannotbealtered/wechat-mp-cli',
      setupSteps: ['在公众号后台确认草稿 API 权限，提供 AppID、私密 AppSecret 及允许的出口 IP。', '将固定版本 CLI 接入 Docker，复用当前文章和封面，上传正文图片并创建草稿。', '保存 media_id，调用草稿查询并到公众号后台核对；最终发表另行处理。'],
      limitations: ['上游 MIT；已查到 v1.0.11，可使用 Linux 二进制，无需新增数据库；本项目尚未接入或完成账号实测。', '接口权限依账号而定；草稿权限与发表/群发权限必须分别检查。', '动态公网 IP 需要重新配置白名单或使用经授权的固定出口；不应导出浏览器 Cookie 代替 API 凭据。'],
    },
    {
      id: 'tiktok_official_inbox', name: 'TikTok：官方收件箱上传', kind: 'inbox_upload', status: 'requires_integration',
      platforms: ['tiktok'], docsUrl: 'https://developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content',
      setupSteps: ['注册应用，获得 video.upload 审批及目标用户授权。', '通过 FILE_UPLOAD 从本地上传视频，保存 publish_id 并查询处理状态。', '账号所有者打开 TikTok 收件箱通知，继续编辑并完成发布。'],
      limitations: ['这是平台收件箱交接，不是永久草稿箱或无人值守公开发布；本项目尚未接入。', '视频可直接上传本地文件；图片和 URL 拉取方式要求符合平台的域名及公开访问条件。', 'Direct Post 的准入要求另行适用，不能把私人账号上传工具当作已获准的公开产品。'],
    },
    {
      id: 'postiz_tiktok_inbox', name: 'Postiz：TikTok 收件箱模式', kind: 'inbox_upload', status: 'requires_integration',
      platforms: ['tiktok'], docsUrl: 'https://docs.postiz.com/public-api/providers/tiktok',
      setupSteps: ['连接经授权的 TikTok integration，并为媒体准备符合要求的 HTTPS 访问地址。', '使用 content_posting_method=UPLOAD 提交明确的收件箱任务。', '提示账号所有者及时在 TikTok 内完成编辑与发布。'],
      limitations: ['Postiz 可能把成功上传标为 published；本产品必须仍记录为待用户完成，不能据此登记公开发布。', '上游文档要求 24 小时内在 App 完成，否则丢弃；多数发布设置在 UPLOAD 模式下不生效。', '当前本地文件不会自动成为公网媒体 URL；此路线尚未集成。'],
    },
    {
      id: 'postiz_extended', name: 'Postiz CLI / MCP：更多官方集成', kind: 'direct_publish', status: 'requires_integration',
      platforms: ['instagram', 'facebook', 'tiktok', 'youtube'], docsUrl: 'https://docs.postiz.com/cli/introduction',
      setupSteps: ['先选择实际需要的渠道，确认 Postiz 已授权该平台及目标账号。', '使用现有 API，或在 Docker 固定 CLI 版本，逐平台接入字段、媒体与状态回读。', '逐账号执行一次真实目标验收后，再开启该路线。'],
      limitations: ['CLI/MCP 是同一 Postiz API 的入口，不增加平台原生草稿或审批权限。', 'Postiz 为 AGPL-3.0；自托管需要 Redis、Temporal 及数据库，不可直接引入其独立 PostgreSQL 示例。', '若自托管，须单独验证 Supabase 内的隔离数据库/角色、唯一调度责任和完整备份；当前未部署。'],
    },
    {
      id: 'producthunt_native', name: 'Product Hunt：原生 Create Draft', kind: 'assisted', status: 'implemented',
      platforms: ['producthunt'], docsUrl: 'https://help.producthunt.com/en/articles/2724119-how-to-schedule-a-post',
      setupSteps: ['完成个人账号 onboarding，准备真实可访问的产品网址和上线资料。', '打开产品提交页面，使用当前内容包填写名称、Tagline、图片与介绍。', '选择 Create Draft，保存实际草稿记录；Schedule Launch 是另一个明确动作。'],
      limitations: ['当前实现提供资料包和原生入口，尚无自动填写或远端创建适配器。', '公开 API 默认只读，已公布的 mutation 没有产品草稿创建接口；申请写权限不等于获得该能力。'],
    },
    {
      id: 'social_auto_upload_research', name: 'social-auto-upload：浏览器 CLI 评估', kind: 'assisted', status: 'research_only',
      platforms: ['xiaohongshu', 'douyin', 'kuaishou', 'bilibili'], docsUrl: 'https://github.com/dreammis/social-auto-upload',
      setupSteps: ['按实际目标筛查单平台公开模块、依赖、会话保存和提交行为。', '先确定可允许的操作边界，再在隔离测试账号核验，不直接采用默认自动发布。'],
      limitations: ['上游 MIT，Python 3.10–3.12；主线采用 Patchright/隐蔽自动化，不能按本项目现有规则原样接入。', '公开说明主要是上传或投稿，不足以证明能创建可回读的原生草稿；本项目未安装。', 'Bilibili 此工具主要处理视频，不能替代专栏文章草稿路线。'],
    },
    {
      id: 'aitoearn_research', name: 'AiToEarn：独立生态评估', kind: 'assisted', status: 'research_only',
      platforms: ['xiaohongshu', 'douyin', 'kuaishou', 'bilibili', 'wechat', 'tiktok', 'youtube', 'instagram', 'facebook', 'x', 'linkedin'], docsUrl: 'https://github.com/yikart/AiToEarn',
      setupSteps: ['只评估需要的公开连接能力与授权方式，不迁入第二套内容管理系统。', '逐平台确认实际 API、浏览器或商业服务边界后再决定是否单独接入。'],
      limitations: ['当前仓库 MIT；完整服务依赖 MongoDB、Redis 和对象存储，Electron 端使用 SQLite，不符合本项目数据库边界。', '渠道宣传、桌面登录或存在插件不能作为本项目已实现草稿或发布的证据。'],
    },
    {
      id: 'native_handoff', name: '原生平台辅助交接', kind: 'assisted', status: 'implemented',
      platforms: [...platformIds], docsUrl: '/api/docs/accounts',
      setupSteps: ['选择实际账号和已批准版本，打开各平台原生创作入口。', '复制标题正文、下载素材，完成平台要求的格式、声明和验证。', '能保存草稿的平台先在原生界面保存；公开后再登记真实作品标识与链接。'],
      limitations: ['这是现有内容包、复制、下载与步骤交接；不代表 14 个平台都存在远端草稿 API。', '文章和视频分别使用支持的创作入口，平台仍可能要求扫码、身份或内容资格核验。'],
    },
  ];
}
