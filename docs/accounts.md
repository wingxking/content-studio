# Account setup and operating identity

Required identity: **Chrome profile `radarxai@gmail.com`** for Google sign-in, Supabase, debugging, and platform test accounts when Google is supported. Verify the visible Chrome profile before account operations. Use another identity only after explicit user direction.

Observed on 2026-10-10: Chrome displayed `coding (radarxai@gmail.com)` and an authenticated Supabase dashboard. The existing `radar` organization displayed **EXCEEDING USAGE LIMITS** and “Grace period is over”, while its project showed Healthy. This is point-in-time UI evidence; it does not establish capacity for a new project. No existing radar database was modified for Content Studio.

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

An API key is not a Google registration credential. Sign in to a hosted or existing approved Postiz installation, connect the intended X or LinkedIn account, and configure its API key locally through the environment/OS secret store. Query integrations using the documented API; enter the exact integration ID into the workbench. The adapter verifies the integration exists, is enabled and matches the selected platform before submission. No Postiz subscription or billing upgrade was purchased.

Registering native metadata as Connected alone records an operator check, not an automatically tested OAuth credential. YouTube is now Connected based on the real official OAuth grant, exact channel readback and published video. The other three current accounts remain Blocked with their verified identities and policy/access tasks; login is not publisher authorization. Use Needs login or Blocked until the creator page and visible account identity have actually been checked. Existing account metadata must be updated when login is renewed; do not create duplicate account entries to bypass a blocker.

## Official YouTube onboarding

Current onboarding is complete: the dedicated Desktop AI-agent client exists in radar-511204, the test user is saved, the exact two scopes were granted, and the original video passed API/Studio/player checks and was later withdrawn; the replacement education video has passed public/processed API and Studio-list checks. The following steps document this route for later reauthorization or a separately approved project; do not create another client or upload the same video merely to repeat acceptance.

1. Use the existing radar-511204 project and enabled YouTube Data API. The observed API product Terms/Enable action and publication were approved. No paid trial is required.
2. The current Google Auth Platform consent app is named radar; its dedicated client is Content Studio Mac Agent. It uses External Testing and `radarxai@gmail.com` as its sole test user. For a new project, configure the intended app name, support/contact and test user. First-time registration has a separate Google API Services User Data Policy checkbox: review the actual page and obtain action-time confirmation for that new agreement. Create a dedicated Desktop app client for this agent workflow; select the AI-powered agent designation if available. Do not reuse a human-interactive client.
3. Download the client JSON locally; give Codex only its local path. Do not paste the file contents or tokens into chat.
4. Run `studio youtube-auth <client-path>`, open its Google authorization URL in the specified Chrome profile and explicitly grant upload/read-only scopes after reviewing them.
5. `studio youtube-channel` must return `UCVUtH6reLkEuMrUuTh-XgjQ`. Then update the existing YouTube metadata to Connected, review/approve the actual video and settings, schedule one job, and explicitly run `youtube-upload`.
6. Use `youtube-reconcile` for the existing session/video. Record its public API state and independently check watch/Shorts playback and the Studio content list. Never discard an unknown journal and create a duplicate job.

External Testing grants containing YouTube scopes and their refresh tokens expire after seven days; reauthorization is needed for a continuing test. Upload plus read-only is the minimum pair used here for upload, exact channel verification, and private/processing readback. These scopes must be reviewed on the actual consent screen. Approval, client creation, user grant, and a real public video remain separate milestones. Official setup references: [consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent), [client and AI-agent designation](https://support.google.com/cloud/answer/15549257?hl=en), [Testing restrictions](https://support.google.com/cloud/answer/15549945?hl=en). The private local uploader is limited to reviewed MP4s up to 512 MiB; it does not stream unlimited files or automatically resend partial uploads.

## Supabase task

Database is optional for stage one's local workspace artifacts. When database persistence is needed, use Supabase. Existing authenticated access was observed, but the selected organization has a capacity warning and no project was selected for this product. Local Supabase is not running: Docker CLI exists but its daemon socket is absent. The migration is supplied for a dedicated project. Project creation requires database credentials that the user must enter directly and can also encounter account/legal/billing gates.

Next action: select or provision a dedicated eligible Supabase project, apply `supabase/migrations/202610100001_content_studio.sql`, configure the three server-only environment values, and run read/write/restart acceptance. Do not place the secret key into the browser or chat. No paid plan or quota change is implied by the task.

## Computer Use restriction

Opening the WeChat Official Account portal ended the Computer Use session with an explicit disallowed-URL message. Browser operations were stopped; no attempt was made to bypass the restriction. The user must operate that portal directly or supply a separately permitted official integration. This session did not complete WeChat login, draft creation or publication. Other uninspected account routes remain unverified.
