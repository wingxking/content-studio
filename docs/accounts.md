# Account setup and operating identity

Required identity: **Chrome profile `radarxai@gmail.com`** for Google sign-in, Supabase, debugging, and platform test accounts when Google is supported. Verify the visible Chrome profile before account operations. Use another identity only after explicit user direction.

Observed on 2026-10-10: Chrome displayed `coding (radarxai@gmail.com)` and an authenticated Supabase dashboard. The existing `radar` organization displayed **EXCEEDING USAGE LIMITS** and “Grace period is over”, while its project showed Healthy. This is point-in-time UI evidence; it does not establish capacity for a new project. No existing radar database was modified for Content Studio.

## Current Docker account setup: 2026-10-11

The deployed runtime uses the supported [Docker lifecycle](docker-runtime.md); the native npm/CLI instructions below are historical migration evidence. All account and credential operations run in containers. Keep Chrome profile `radarxai@gmail.com` verified before this owner's Google actions. Browser login and API authorization remain separate.

Existing YouTube credentials are private `delivery-private/youtube/secrets/client.json` and `token.json` under the configured bind root, mounted only into delivery workers at `/data/youtube/secrets`. The current instance retained these files and its two original journal bodies; the Web read-only authorization check returned the exact expected channel without a new grant or upload. A default portable restore omits private credentials and journals, leaves protected journal markers and publication paused, and requires explicit authorization or an approved private transfer before automatic uploads.

For a new computer or expired consent, download the intended Desktop client JSON privately, then run:

```sh
sh scripts/docker.sh youtube-auth --root /absolute/private-root \
  --client-file /absolute/private-desktop-client.json --callback-port 8765
```

This one-off delivery container publishes only `127.0.0.1:8765:8765`; another unoccupied port may be selected. It binds the callback inside the container but advertises the host loopback address. Open the printed official Google URL in the verified browser profile, review only upload and read-only scopes, and complete consent yourself. State, PKCE and exact Host validation remain required. Credentials stay in the private delivery mount; no token or client JSON is printed. The Web “check existing YouTube API authorization” button dispatches a read-only channel check to the delivery worker. This runtime check passed; a new grant was not exercised during this acceptance. Production Web OAuth remains a later phase.

Local intake accepts assets up to 500 MiB. Reviewed MP4 upload remains size-bounded and streams 8 MiB chunks; explicit interrupted-upload continuation reuses the same existing session. Unknown outcomes and protected restored journals require reconciliation, never a replacement upload. The Docker-only runtime needs no host Node, Codex, Supabase CLI, macOS service or Keychain.

## 六平台最新实测：2026-10-11

本轮使用可见 Chrome profile `coding (radarxai@gmail.com)`。只登记直接观察到的身份；没有新的公开提交或 API 授权。完整功能与验收见 [六平台发布能力升级](publishing-capabilities-upgrade-2026-10-11.zh-CN.md)。

| 平台 | 当前实测 | 必需下一步 |
| --- | --- | --- |
| Reddit | 已登录，头像菜单为 `u/radarxai26` | 获准 App/provider、匹配 Postiz integration、明确测试 subreddit、当前规则与必需 flair |
| Product Hunt | 已选择指定 Google 账号，停在 Continue；未确认注册成功 | 本次最终注册条款确认，然后完成个人账号 onboarding；真实产品 URL/名称/资料，不把新闻作为产品 |
| 微信公众号 | 本轮未重试；历史 Computer Use 明确禁止此 URL | 由账号管理员在允许环境扫码，检查账号类型与实际发布 API 权限；不可绕过工具限制 |
| 知乎 | `zhuanlan.zhihu.com/write` 跳到登录；没有可见 Google 入口 | 本人在已打开标签扫码/短信登录；只提供非敏感可见身份及专栏权限 |
| 小红书 | 已登录创作后台，显示 `ziv`、图文/视频入口 | 核对账号内容资格、AI 声明及获准路线；保持已有权限阻塞，登录不等于自动发布许可 |
| Bilibili | 创作中心跳到 passport 登录，没有可见 Google 入口 | 本人在已打开标签扫码/短信登录，再核对 UID、专栏/视频投稿权限 |

Google 邮箱不能替代中国平台的手机/管理员身份验证。Computer Use 确认规则要求在实际接受新账号条款前再次确认；本轮 Product Hunt 最终动作已留待回应。新密码、验证码、恢复码和私有会话不得发到聊天。完成登录后回复「已登录」及可见用户名即可继续核验。

## Latest four-account verification: 2026-10-10

The user completed registration/login. In Chrome profile `coding (radarxai@gmail.com)`, current native UI checks confirmed X `@radarxai`, YouTube `RadarXAI` with channel `UCVUtH6reLkEuMrUuTh-XgjQ`, Xiaohongshu `ziv` with account `63520392304`, and Reddit `u/radarxai26`. This supersedes the earlier registration blockers below; it does not establish OAuth or automated publishing permission. The new AI-agent education video is public; the previous topic was reversibly withdrawn to Private. X, Reddit and Xiaohongshu remain unsubmitted.

- YouTube: the existing dedicated Desktop AI-agent client in radar-511204, sole External Testing user and exact upload/read-only grant are complete. Official API verified channel UCVUtH6reLkEuMrUuTh-XgjQ. Old job 489d1309-02d4-47e8-9d0b-3a9fba52b864 submitted revision 7 once; at the owner's request, video aKaJ3qBAhCc was set to Private and saved in Studio, with official private/processed readback at 06:36:33.598 UTC. The old draft is now revision 8 with approval revoked. New draft 823d5dbf-9b3f-4e3c-a7ab-edf9ca7ed317 revision 4 was submitted once through job 78fb0a72-f850-4bd3-a48b-0f9629e4e264; video X8dDltMseM4 is confirmed public/processed at 06:37:59.454 UTC and Public/Published in Studio Shorts. [Current video](https://www.youtube.com/watch?v=X8dDltMseM4). The signed-in player reached 36/46 seconds; full playback remains pending. Existing scopes returned 403 insufficientPermissions for videos.update; no broader grant was made. Credentials and journals remain private. No paid trial was started.
- X: the withdrawn trend draft must not be republished. The new education draft is editorial and can use a rule-compliant official API route, but no X API/Postiz publisher is configured. Configure approved developer/user authorization or an authorized Postiz integration locally; do not send secret values to chat. Website automation remains prohibited.
- Reddit: current App/AI-agent policy requires registration and approved access. No approved app, API credentials, or human/App identity separation is configured. Prepare the personal-profile version; a genuine human may review and publish manually.
- Xiaohongshu: creator access is available, but no approved general personal-note publishing API is configured. The current User Agreement §4.1 restricts unauthorized third-party tools, and Community Rules §4.4.3 includes machine publishing among abnormal publishing modes. Visible Codex operation has no stated exemption. The approved caption and four cards are ready for a genuine owner review and final native Publish click, subject to platform review. The Nobel Peace/ICC/ICJ note was withdrawn and must not be published. The replacement adult AI/coding practice avoids that topic, but its account-specific professional-content classification has not been established; do not infer either a blanket license requirement or exemption. Seek an account-specific qualification answer and approved integration or written authorization before promising automatic publication.

See [current platform policy evidence](platform-policies-v2.zh-CN.md) for direct official sources and the distinction between login, platform authorization and content eligibility.

自动发布的具体申请和接入步骤见 [X、Reddit、小红书接入方案](automatic-publishing-access-2026-10-10.zh-CN.md)。

## Safe access handoff

Keep the account signed in in the chosen Chrome profile. Complete phone/SMS, administrator QR, two-factor, real-name, CAPTCHA, and account terms directly on the relevant platform, then provide only the visible handle/channel ID and any intended test destination. Do not paste passwords, cookies, tokens, recovery codes, or identity-document scans into this chat or tracked files.

If the platform offers Google, choose `radarxai@gmail.com`. This authorizes sign-in, but does not replace new account terms or a materially expanded OAuth permission grant. At such a final action the computer-use policy requires action-time confirmation. Account creation cannot be honestly recorded as complete before the resulting profile or creator console is visible.

## Earlier account observations and remaining platform tasks

| Platform | Current status | How to supply usable access | After login |
|---|---|---|---|
| Reddit | Registration reached a “Prove your humanity” CAPTCHA | Open https://www.reddit.com/register/ in the chosen profile, complete the challenge and account terms; select Google if offered | Report handle and intended own/test subreddit; confirm post permissions/community rules |
| YouTube | Google session active; Studio redirected to channel creation with explicit Terms of Service | Review channel name/handle and approve or personally complete Create channel | Open Studio and confirm channel ID; test one generated MP4 and read back actual visibility |
| X | Live page offers Google; continuing explicitly accepts X terms | Open https://x.com/ in the chosen profile; use Google if offered, finish required registration/2FA/terms | Report visible handle; connect to authorized Postiz integration or use native composer |
| TikTok | Needs creator/login inspection | Open https://www.tiktok.com/tiktokstudio/upload and use Google if offered; finish age/login/terms checks | Verify upload access; use native upload or an approved creator-facing integration |
| Xiaohongshu | Creator portal visibly requires phone/SMS; no Google option shown | Open https://creator.xiaohongshu.com/ and complete existing-account SMS/QR login | Confirm creator handle and usable image-note/video editor |
| WeChat Official Accounts | Computer Use ended the session because mp.weixin.qq.com is a disallowed URL | Open https://mp.weixin.qq.com/ and scan using the account administrator's WeChat | Inspect subject/account type and actual API permissions; check draft/publication route |
| Bilibili | Mainland creator login/verification required | Open https://member.bilibili.com/ and complete phone/App QR and any required account checks | Confirm UID and video/article submission access; do not confuse international Bilibili Google login |
| Kuaishou | Creator login/verification required | Open https://cp.kuaishou.com/ and complete phone/App login | Confirm account and upload access; official app route requires approved OAuth scope |
| Douyin | Phone/App creator login required | Open https://creator.douyin.com/ and complete phone/QR verification | Confirm creator account and ensure delegated creation is visible to the user |
| Instagram / Facebook | Existing Meta login and publishing identity required | Sign in in the selected Chrome profile | Check correct page/professional account and intended publishing surface |
| LinkedIn | Login and authorized integration required | Open https://www.linkedin.com/ in the chosen profile | Confirm member/page target and matching integration permissions |

The four-account verification above supersedes the earlier Reddit, YouTube, X and Xiaohongshu registration observations in this historical table. The table distinguishes researched login routes from current UI observations. “Needs inspection” has not been tested live and must not be reported as a confirmed platform outage or account error. Update the observed column after each real browser check.

## Postiz adapter

An API key is not a Google registration credential. Sign in to a hosted or existing approved Postiz installation, connect the intended X, LinkedIn or approved Reddit account, and configure its API key locally through the environment/OS secret store. Query integrations using the documented API; enter the exact integration ID into the workbench. The adapter verifies the integration exists, is enabled and matches the selected platform before submission. No Postiz subscription or billing upgrade was purchased.

Registering native metadata as Connected alone records an operator check, not an automatically tested OAuth credential. YouTube is now Connected based on the real official OAuth grant, exact channel readback and published video. The other three current accounts remain Blocked with their verified identities and policy/access tasks; login is not publisher authorization. Use Needs login or Blocked until the creator page and visible account identity have actually been checked. Existing account metadata must be updated when login is renewed; do not create duplicate account entries to bypass a blocker.

### Reddit Postiz configuration

The expanded adapter supports approved Reddit self posts with one explicit community. Configure `POSTIZ_API_KEY` privately in the Docker root's ignored `config/application.env`, use the intended approved provider URL, restart through the Docker lifecycle, then query integrations in Web. Choose the exact Reddit integration ID, review the actual community rules URL, record non-sensitive App approval evidence, and supply required flair. The evidence field is an operator declaration, not an automated platform-approval lookup. The seven-day rule-review gate is a project guard, not an official Reddit time limit.

Connection checks preserve Blocked; they never authorize a previously blocked route. A changed community/target invalidates prior approval. The implementation has passed documented payload and local recovery tests, but no live Postiz key, integration or Reddit submission was configured in this upgrade. Full Postiz self-hosting and WechatSync remote draft sync are not installed.

## Official YouTube onboarding

Current onboarding is complete: the dedicated Desktop AI-agent client exists in radar-511204, the test user is saved, the exact two scopes were granted, and the original video passed API/Studio/player checks and was later withdrawn; the replacement education video has passed public/processed API and Studio-list checks. The following steps document this route for later reauthorization or a separately approved project; do not create another client or upload the same video merely to repeat acceptance.

1. Use the existing radar-511204 project and enabled YouTube Data API. The observed API product Terms/Enable action and publication were approved. No paid trial is required.
2. The current Google Auth Platform consent app is named radar; its dedicated client is Content Studio Mac Agent. It uses External Testing and `radarxai@gmail.com` as its sole test user. For a new project, configure the intended app name, support/contact and test user. First-time registration has a separate Google API Services User Data Policy checkbox: review the actual page and obtain action-time confirmation for that new agreement. Create a dedicated Desktop app client for this agent workflow; select the AI-powered agent designation if available. Do not reuse a human-interactive client.
3. Download the client JSON locally; give Codex only its local path. Do not paste the file contents or tokens into chat.
4. Run `studio youtube-auth <client-path>`, open its Google authorization URL in the specified Chrome profile and explicitly grant upload/read-only scopes after reviewing them.
5. `studio youtube-channel` must return `UCVUtH6reLkEuMrUuTh-XgjQ`. Then update the existing YouTube metadata to Connected, review/approve the actual video and settings, schedule one job, and explicitly run `youtube-upload`.
6. Use `youtube-reconcile` for the existing session/video. Record its public API state and independently check watch/Shorts playback and the Studio content list. Never discard an unknown journal and create a duplicate job.

External Testing grants containing YouTube scopes and their refresh tokens expire after seven days; reauthorization is needed for a continuing test. Upload plus read-only is the minimum pair used here for upload, exact channel verification, and private/processing readback. These scopes must be reviewed on the actual consent screen. Approval, client creation, user grant, and a real public video remain separate milestones. Official setup references: [consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent), [client and AI-agent designation](https://support.google.com/cloud/answer/15549257?hl=en), [Testing restrictions](https://support.google.com/cloud/answer/15549945?hl=en). The private local uploader is limited to reviewed MP4s up to 512 MiB; it does not stream unlimited files or automatically resend partial uploads.

## Historical native Supabase setup

The supported current runtime is Compose Supabase, API `56421`, PostgreSQL `56422`, Web `14310`; use `sh scripts/docker.sh start --root /absolute/private-root`. The native CLI instructions below are retained only for historical migration/recovery.

The earlier local product used the dedicated Supabase CLI project `content-studio-local`: API 55421 and Postgres 55422, both bound to loopback. Docker, database/Auth/private Storage, pgmq and pg_cron have been exercised on this Mac. Migrations 001–006 are applied. Server-only runtime values stay in ignored `.studio/runtime.env`; the browser never receives the service-role key.

Use `npm run local:setup`, `npm run local:start` and `npm run local:status`; see [local system delivery](local-system-delivery.zh-CN.md) for acceptance and backup/restore. The existing hosted `radar` project is not the application's database and was not modified. Hosted Supabase selection and cloud production deployment remain stage two. Earlier observations that the local Docker daemon was unavailable are historical and have been superseded by this running installation.

## Computer Use restriction

Opening the WeChat Official Account portal ended the Computer Use session with an explicit disallowed-URL message. Browser operations were stopped; no attempt was made to bypass the restriction. The user must operate that portal directly or supply a separately permitted official integration. This session did not complete WeChat login, draft creation or publication. Other uninspected account routes remain unverified.
