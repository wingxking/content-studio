# Account setup and operating identity

Required identity: **Chrome profile `radarxai@gmail.com`** for Google sign-in, Supabase, debugging, and platform test accounts when Google is supported. Verify the visible Chrome profile before account operations. Use another identity only after explicit user direction.

Observed on 2026-10-10: Chrome displayed `coding (radarxai@gmail.com)` and an authenticated Supabase dashboard. The existing `radar` organization displayed **EXCEEDING USAGE LIMITS** and “Grace period is over”, while its project showed Healthy. This is point-in-time UI evidence; it does not establish capacity for a new project. No existing radar database was modified for Content Studio.

## Latest four-account verification: 2026-10-10

The user completed registration/login. In Chrome profile `coding (radarxai@gmail.com)`, current native UI checks confirmed X `@radarxai`, YouTube `RadarXAI` with channel `UCVUtH6reLkEuMrUuTh-XgjQ`, Xiaohongshu `ziv` with account `63520392304`, and Reddit `u/radarxai26`. This supersedes the earlier registration blockers below; it does not establish OAuth or automated publishing permission. No post has been submitted in this new cycle.

- YouTube: Studio shows upload controls. The authorized Data API route needs a Cloud project and OAuth application. Cloud first-use setup was initially blocked at country/Terms. A later current UI check confirmed the user completed it and created radar-511204. The YouTube Data API enable page explicitly states use binds its own product terms; the user has been asked for this specific action-time agreement. API activation and later Desktop OAuth/grant remain pending. No paid trial was started.
- X: prepare the trend-based draft for real human publication. Current official rules prohibit automatic trend posts and non-API website automation; no automated submission is attempted.
- Reddit: current App/AI-agent policy requires registration and approved access. No approved app, API credentials, or human/App identity separation is configured. Prepare the personal-profile version; a genuine human may review and publish manually.
- Xiaohongshu: creator access is available, but no approved general personal-note publishing API is configured. The Nobel Peace/ICC/ICJ topic has unresolved news/professional-category eligibility; the generated note is held for verification. This is a conservative classification from official rules, not a claim that every personal educational note requires a news license.

See [current platform policy evidence](platform-policies-v2.zh-CN.md) for direct official sources and the distinction between login, platform authorization and content eligibility.

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

An API key is not a Google registration credential. Sign in to a hosted or existing approved Postiz installation, connect the intended X or LinkedIn account, and configure its API key locally through the environment/OS secret store. Query integrations using the documented API; enter the exact integration ID into the workbench. The adapter verifies the integration exists, is enabled and matches the selected platform before submission. No Postiz subscription or billing upgrade was purchased.

Registering native metadata as Connected records an operator check, not an automatically tested OAuth credential. The four current accounts are deliberately Blocked in the workbench, with their verified identities and policy/OAuth tasks; login is not publisher authorization. Use Needs login or Blocked until the creator page and visible account identity have actually been checked. Existing account metadata must be updated when login is renewed; do not create duplicate account entries to bypass a blocker.

## Official YouTube onboarding

1. First-use Cloud setup is already complete and radar-511204 is available. Approve the actual YouTube Data API product terms or personally click Enable in the current page; no paid trial is required.
2. After the API is enabled, configure OAuth branding/audience and the test user `radarxai@gmail.com` as required, then create an OAuth Desktop app client.
3. Download the client JSON locally; give Codex only its local path. Do not paste the file contents or tokens into chat.
4. Run `studio youtube-auth <client-path>`, open its Google authorization URL in the specified Chrome profile and explicitly grant upload/read-only scopes after reviewing them.
5. `studio youtube-channel` must return `UCVUtH6reLkEuMrUuTh-XgjQ`. Then update the existing YouTube metadata to Connected, review/approve the actual video and settings, schedule one job, and explicitly run `youtube-upload`.
6. Use `youtube-reconcile` for the existing session/video. Record its public API state and independently check watch/Shorts playback and the Studio content list. Never discard an unknown journal and create a duplicate job.

Testing OAuth grants can expire; approval and a real public video remain separate milestones. The private local uploader is limited to reviewed MP4s up to 512 MiB; it does not stream unlimited files or automatically resend partial uploads.

## Supabase task

Database is optional for stage one's local workspace artifacts. When database persistence is needed, use Supabase. Existing authenticated access was observed, but the selected organization has a capacity warning and no project was selected for this product. Local Supabase is not running: Docker CLI exists but its daemon socket is absent. The migration is supplied for a dedicated project. Project creation requires database credentials that the user must enter directly and can also encounter account/legal/billing gates.

Next action: select or provision a dedicated eligible Supabase project, apply `supabase/migrations/202610100001_content_studio.sql`, configure the three server-only environment values, and run read/write/restart acceptance. Do not place the secret key into the browser or chat. No paid plan or quota change is implied by the task.

## Computer Use restriction

Opening the WeChat Official Account portal ended the Computer Use session with an explicit disallowed-URL message. Browser operations were stopped; no attempt was made to bypass the restriction. The user must operate that portal directly or supply a separately permitted official integration. This session did not complete WeChat login, draft creation or publication. Other uninspected account routes remain unverified.
