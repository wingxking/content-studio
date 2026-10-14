# Account setup and operating identity

Required identity: **Chrome profile `radarxai@gmail.com`** for Google sign-in, Supabase, debugging, and platform test accounts when Google is supported. Verify the visible Chrome profile before account operations. Use another identity only after explicit user direction.

## k account continuation: 2026-10-15

The owner selected **Zhihu article drafts** for the next live acceptance route. k was unlocked, and the native Chrome profile menu independently showed **radarxai@gmail.com**. Zhihu's authenticated home page showed **孔涛**, with the profile link `https://www.zhihu.com/people/kong-tao-1-90`. This resolves the earlier browser-login blocker only; the extension's actual platform UID, article editor permission and a saved draft are still separate checks.

The Linux model container still reported **Not logged in** after the owner's earlier completion message. A fresh official device-login process was started in the same isolated container. Google/OpenAI sign-in using the verified radar identity reached **Phone number required** at `https://auth.openai.com/add-phone`. This new device process also expired after 15 minutes while waiting. Complete phone/SMS verification first, then start `sh scripts/docker.sh model-login --root /absolute/private-root` for a fresh code and complete any account terms and the final device grant. Container login/readiness must be checked independently. Never copy another profile's authentication, retain codes or reuse an expired code.

The radar extensions inventory contained ChatGPT and Google Docs Offline, with no WechatSync. The [official WechatSync site](https://www.wechatsync.com/) linked to Chrome Web Store ID `hchobocdmclopcbnibdnoafilagadion`; the store showed **2.0.9**, updated April 1, 2026. Its installation dialog requested **Read and change all your data on all websites** and **Manage your downloads**. Installation and local draft-bridge pairing are awaiting action-time owner confirmation of that expanded browser access. No extension was installed or paired by this check. After approval, install from the same official listing, transfer pairing secrets only between the extension and local Accounts UI, check the actual Zhihu identity, and authorize one reviewed revision/account before saving the test draft. Keep the original revision, job and private journal if any dispatch has an unknown result.

Publishing and creator scheduling remain paused. No real platform draft or new public post was created in this continuation checkpoint.

The optional Docker browser fixture was retried separately. `browser-start` reached its 600-second service-start timeout and exited with `docker failed (130)`; neither the Selenium image nor browser container was present. The wrapper did not expose a specific registry/network error. `browser-smoke` then exited with `Browser compatibility is blocked: start the optional browser and executor services before fixture smoke.` The 14 base services retained their running state and API health; this remains an unpassed fixture gate.

### Isolated real-model generation after authorization

The manual `tests/ecosystem-live-generation.ts` script requires an explicit confirmation flag and a separate persistent bind. It generates only an unapproved master and Zhihu article in a random Supabase workspace, preserving the knowledge snapshot and output hashes. It does not pair accounts, save remote drafts or publish. On this k instance its actual authorization preflight stopped at `readiness`, and the database query confirmed that the random workspace was not created. The preserved manifest is under `qa-live/zhihu-live-pFLXZR`; use the retry command below only after actual container authorization succeeds. Replace the bind root on another machine; never transfer authentication with it.

```sh
STUDIO_ACCEPTANCE_RUNTIME=/absolute/private-root

docker compose --project-directory "$PWD" \
  --env-file "$STUDIO_ACCEPTANCE_RUNTIME/config/compose.env" -f infra/compose.yml \
  run --rm --no-deps --entrypoint node \
  --volume "$PWD/tests:/app/tests:ro" \
  --volume "$STUDIO_ACCEPTANCE_RUNTIME/qa-live:/acceptance-live" \
  api --import tsx tests/ecosystem-live-generation.ts \
  --confirm-isolated-generation --retry --root /acceptance-live/zhihu-live-pFLXZR
```

For a new acceptance run, create a private `qa-live` directory under the chosen ignored runtime root first, replace `--retry --root ...` with `--root /acceptance-live --model <available-catalog-id>`, and retain the reported child directory. Failures report a safe stage and keep the original run. An interrupted active run must wait for its original lease/queue visibility to expire before an explicit retry; do not create a replacement task. A remote draft test still requires inspecting the generated content, binding the actual platform identity and approving that exact revision/account.

## Latest k verification: automation/knowledge upgrade, 2026-10-14

This run independently switched from another open Chrome profile to `radar`, opened its profile menu, and verified **radarxai@gmail.com** before account work. YouTube Studio showed **RadarXAI**, channel `UCVUtH6reLkEuMrUuTh-XgjQ`, and the existing education video. This supersedes the earlier operator-attested profile statement below. No existing platform post or account settings were changed.

- **Linux Codex:** container `login status` reports Not logged in. The official device-login flow was started, but Google/OpenAI completion remained unfinished when k's screen locked. Run `sh scripts/docker.sh model-login --root /absolute/private-root` from this checkout, complete the fresh official code in the verified Chrome profile, then check login status and refresh models. Codes expire; do not retain or reuse the code from this run. Current catalog entries are cache, not authenticated inference evidence.
- **YouTube API:** the actual Web read-only check returned `available=false`; native Studio login does not establish the restored Docker worker's OAuth access. Use the documented Docker `youtube-auth` flow with the privately downloaded Desktop client JSON, review upload/read-only scopes, and confirm the expected channel before a separately approved upload. Do not copy the source instance's tokens.
- **Zhihu:** the verified profile reached `zhihu.com/signin?next=%2F`; native UI offers owner QR/SMS login and account terms. Complete login yourself and report only the visible name. Then install/re-pair the reviewed optional WechatSync extension, bind its actual UID in “平台与账号”, allow article drafts, and test one approved revision. The current k draft bridge reports unconfigured; no real draft was saved.
- **Postiz:** the runtime reports no API key. Configure it privately in the chosen Docker root's `config/application.env`, restart, query integrations, and bind the exact authorized X/LinkedIn/approved Reddit target. Keep App/community approval and content/account revision approval separate. No key, subscription or OAuth grant was created.
- **Chrome:** Browser Use explicitly reported that the Mac is locked and automatic unlock failed. Unlock k manually to resume native account tests and any required final consent. The new local Web interface was separately tested in the in-app browser; that does not transfer profile identity or OAuth to any platform.
- **Optional Docker browser fixture:** `browser-start` was retried but the pinned Selenium browser image transfer did not complete within the lifecycle timeout (`docker failed (130)`). No Chromium container/browser smoke or live finance adapter acceptance is claimed. The original Python fixture executor image remains available.

Knowledge upload/import/search and the actual Supabase/pgmq generation-to-three-draft **mock extension** flow passed. These are product/transport evidence, not live platform draft acceptance. Publishing and both owned schedules remain paused. See [upgrade evidence](automation-knowledge-upgrade-2026-10-14.zh-CN.md).

## Remote testing target: 2026-10-14

The owner selected device `k`, user `k`, checkout `~/x/content-studio`, for subsequent implementation and acceptance. Authenticated key-based SSH now works at `k@k.softshell-court.ts.net`; the source Mac uses the `k-macmini_key` identity for the known k host aliases. Docker runs the restored, isolated instance `.docker-k-acceptance`, Compose project `content-studio-k-test`, at `http://127.0.0.1:4310` on k. The source instance and old remote `.docker` bind root remain preserved. Git synchronization transfers source; it does not transfer account authorization.

The owner reported completing Google sign-in in the `radarxai@gmail.com` Chrome profile on k. This is operator-attested; this run did not independently verify the visible profile or platform identities through remote Chrome. Verify both before account actions. No password is stored in project instructions, skills or notes. Source-Mac sign-ins do not authorize the new machine.

Default Docker restore omitted authentication. Linux Codex currently reports **Not logged in**: run `docker exec -it content-studio-k-test-model-runner-1 codex login --device-auth` on k, open the returned official authorization URL in the verified owner profile, complete the required consent, then check `codex login status` in that container and refresh the product model catalog. Never copy or track the source Mac's auth files. New generation remains blocked until this step is completed; build, fixture and render tests do not establish model authorization.

The optional original browser publisher has no live platform permission or accepted adapters. Its pinned ARM64 Selenium image download failed repeatedly through Docker Hub and its official mirror; the profile remains off. After a successful digest-verified image pull, use `sh scripts/docker.sh browser-config --root /Users/k/x/content-studio/.docker-k-acceptance --fixtures` and `browser-start` with that root, then run the explicit fixture smoke. Real Xueqiu, Gelonghui and Guba operations stay blocked. The optional noVNC listener is loopback-only port 17900 with a random password in the private Compose settings; use an authenticated SSH tunnel when operating from another computer. Do not paste that secret or browser profile into chat, source control or shared context. The product session controls cover the isolated fixture slot only.

Follow [the remote-testing skill](../.agents/skills/content-studio-remote-testing/SKILL.md), [Docker transfer instructions](docker-runtime.md), and [this iteration's executed evidence](beecms-iteration-2026-10-14.md).

Observed on 2026-10-10: Chrome displayed `coding (radarxai@gmail.com)` and an authenticated Supabase dashboard. The existing `radar` organization displayed **EXCEEDING USAGE LIMITS** and “Grace period is over”, while its project showed Healthy. This is point-in-time UI evidence; it does not establish capacity for a new project. No existing radar database was modified for Content Studio.

## Draft companion account baseline: 2026-10-13

The visible Chrome profile was verified as `radarxai@gmail.com`; the inspected extensions inventory did not contain WechatSync. The new gateway and draft adapters therefore remain unpaired and have no real-platform draft acceptance. This observation does not establish a new login or permission grant for any platform. Earlier account observations below keep their original dates.

For WeChat Official Accounts, Zhihu and Bilibili articles, install the reviewed extension in that profile and inspect its requested permissions. Enable the extension's CLI / MCP connection, then enter its extension ID and Token only in the local Content Studio Accounts setup. Copy the private connection URL directly into the extension; do not put it in CLI arguments, shell history, screenshots, chat or tracked files. Keep the browser open. Refresh connection status, log into each intended platform, verify its visible identity and creator permissions, then bind that exact account in Content Studio. WeChat portal access remains subject to the documented tool restriction; the account owner must use a permitted environment. Do not route a denied browser operation through the companion.

X, LinkedIn and Reddit drafts use an independently configured Postiz integration. The last recorded provider check on 2026-10-12 found no `POSTIZ_API_KEY`; do not treat historical browser login as a configured provider. Supply API credentials through the private runtime configuration and verify the actual integration and account. Reddit still requires a specific target community and current rules. These drafts stay in Postiz, not the platforms' native draft boxes; public delivery has separate approval and policy checks. Configure bridge secrets through the Accounts UI, never CLI arguments.

### Draft-only CLI in Docker

The CLI follows the existing positional syntax. Run it inside the API container; the host needs Docker Compose and a shell, not Node. Replace the example IDs and revision with the exact reviewed article, selected accounts and current revision. `save-drafts` explicitly authorizes storing that version as drafts and queues delivery; its return value is not proof of an existing remote draft. It works while public publishing is paused, and does not request public publication.

```sh
STUDIO_BIND_ROOT=/absolute/private-root

docker compose --project-directory "$PWD" --env-file "$STUDIO_BIND_ROOT/config/compose.env" -f infra/compose.yml \
  exec -T api node --import tsx src/server/cli.ts draft-connectors

docker compose --project-directory "$PWD" --env-file "$STUDIO_BIND_ROOT/config/compose.env" -f infra/compose.yml \
  exec -T api node --import tsx src/server/cli.ts save-drafts DRAFT_UUID ACCOUNT_UUID_1,ACCOUNT_UUID_2 3

docker compose --project-directory "$PWD" --env-file "$STUDIO_BIND_ROOT/config/compose.env" -f infra/compose.yml \
  exec -T api node --import tsx src/server/cli.ts draft-receipt JOB_UUID REMOTE_DRAFT_ID 'https://zhuanlan.zhihu.com/p/REMOTE_DRAFT_ID/edit'
```

`draft-connectors` returns the sanitized configured/connected state, nonsecret extension ID, observed account identities and ecosystem catalog. It does not print the extension Token, service key or pairing URL. `draft-receipt` records an owner's verification of an existing draft after opening it in the intended account; it neither creates another draft nor records a published post. Unknown outcomes must be inspected before recording the existing ID and URL; do not repeatedly queue them.

Never paste a token-bearing WeChat editor URL into a shell. Use only the identifier and a reconstructed token-free URL such as `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=REMOTE_DRAFT_ID`. Bilibili uses `https://member.bilibili.com/platform/upload/text/edit?aid=REMOTE_DRAFT_ID`. For Postiz, use the configured Postiz web origin without query parameters or fragments and the actual provider draft ID. Core receipt validation strips or rejects unsafe URL parameters, but cannot remove secrets already stored in shell history. No command accepts pairing credentials as arguments.

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

## 六平台最新实测：2026-10-12

本轮使用可见 Chrome profile `coding (radarxai@gmail.com)`，刷新页面后核对登录状态。只登记直接观察到的身份；没有新的公开提交或发布 API 授权。2026-10-12 经用户当次确认后完成 Product Hunt Google Continue，仅共享页面显示的姓名、头像和邮箱。完整功能与验收见 [六平台发布能力升级](publishing-capabilities-upgrade-2026-10-11.zh-CN.md)。

| 平台 | 当前实测 | 必需下一步 |
| --- | --- | --- |
| Reddit | 刷新后仍登录 `u/radarxai26`；`/prefs/apps` 显示既有 `DevPlatform Actions` 授权，但不是已验证的本项目 publisher | 获准 App/provider、匹配 Postiz integration、明确测试 subreddit、当前规则与必需 flair |
| Product Hunt | `coding open / @coding_open` 注册及 onboarding 已完成；三项邮件订阅取消后提交；`/posts/new` 产品 URL 表单已无 Complete onboarding 提示 | 本地 native/Connected 只表示身份及原生入口核验，能力为 manual，automatic/remoteDraft 均为 false；真实产品 URL/资料及远端草稿/上线验收待完成 |
| 微信公众号 | 本轮未重试；历史 Computer Use 明确禁止此 URL | 由账号管理员在允许环境扫码，检查账号类型与实际发布 API 权限；不可绕过工具限制 |
| 知乎 | `zhuanlan.zhihu.com/write` 跳到登录；没有可见 Google 入口 | 本人在已打开标签扫码/短信登录；只提供非敏感可见身份及专栏权限 |
| 小红书 | 刷新后创作后台仍为 `ziv`，视频/图文/长文入口与草稿箱(0)可见；Red Skill 是审核后添加到笔记/评论的附件功能 | 核对账号内容资格、AI 声明及获准路线；保持已有权限阻塞，登录不等于自动发布许可 |
| Bilibili | 创作中心跳到 passport 登录，没有可见 Google 入口 | 本人在已打开标签扫码/短信登录，再核对 UID、专栏/视频投稿权限 |

Google 邮箱不能替代中国平台的手机/管理员身份验证。2026-10-12 用户依次确认 Google Continue、年龄声明与取消三项邮件订阅后，已点击 Get Started，进入第 2/2 步并跳过可选个人资料，再继续进入已登录首页；未添加 LinkedIn/X 资料或关注推荐账号。重新打开 `/posts/new` 后只显示产品 URL 表单，Complete onboarding 提示消失。`coding open (@coding_open)` 的既有账号更新为 native/Connected；实际能力为 manual，automatic=false、remoteDraft=false，未获得发布 API 权限，未创建远端草稿或公开 launch。仍缺真实公开产品 URL 和上线资料；六个既有发布任务状态、尝试次数、远端 ID 不变，发布保持暂停。新密码、验证码、恢复码和私有会话不得发到聊天。知乎/B站完成登录后回复「已登录」及可见用户名即可继续核验。

### 2026-10-12 实际接口与播放器复验

- `GET /api/youtube/status` 由 Docker delivery worker 调用现有官方 OAuth，返回 `available=true` 和预期频道 `UCVUtH6reLkEuMrUuTh-XgjQ`。同一 Chrome profile 中，现有视频 [X8dDltMseM4](https://www.youtube.com/watch?v=X8dDltMseM4) 显示 RadarXAI 作者，播放器到达 **46/46 秒、Replay**；本次没有新增授权或上传。
- `GET /api/publishing/integrations` 实际返回 HTTP 400，明确缺少 `POSTIZ_API_KEY`。这属于尚未配置，不能当成 provider 故障，也不能把其他应用的既有 Reddit 授权当作本项目凭证。[Reddit 当前 Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)要求对应的获准访问；未撤销或复用 `DevPlatform Actions`。
- [小红书 Red Skill 页面](https://creator.xiaohongshu.com/new/skill-hub)说明上传 Skill 审核通过后可添加到笔记或评论；页面没有证明一般笔记自动发布 API、写权限或对第三方自动化的许可。未上传 Skill、素材或稿件。
- 知乎专栏仍跳登录，Bilibili 实际文章入口 `https://member.bilibili.com/platform/upload/text` 再次跳 passport 登录。微信入口沿用历史工具限制，本次没有重试或绕过。Product Hunt `/posts/new` 刷新后仍已登录且无 onboarding 提示，仍缺真实产品网址。
- 已更新四个实测账号的说明和核验时间。五个账号及六个既有任务保留，稿件与任务快照完全不变，状态/尝试次数/远端 ID 不变；发布暂停、两个 scheduler 保持禁用。六个优先平台的 `automatic` 和 `remoteDraft` 都为 false，YouTube 视频路线为已接入官方 API。

## Latest four-account verification: 2026-10-10

The user completed registration/login. In Chrome profile `coding (radarxai@gmail.com)`, current native UI checks confirmed X `@radarxai`, YouTube `RadarXAI` with channel `UCVUtH6reLkEuMrUuTh-XgjQ`, Xiaohongshu `ziv` with account `63520392304`, and Reddit `u/radarxai26`. This supersedes the earlier registration blockers below; it does not establish OAuth or automated publishing permission. The new AI-agent education video is public; the previous topic was reversibly withdrawn to Private. X, Reddit and Xiaohongshu remain unsubmitted.

- YouTube: the existing dedicated Desktop AI-agent client in radar-511204, sole External Testing user and exact upload/read-only grant are complete. Official API verified channel UCVUtH6reLkEuMrUuTh-XgjQ. Old job 489d1309-02d4-47e8-9d0b-3a9fba52b864 submitted revision 7 once; at the owner's request, video aKaJ3qBAhCc was set to Private and saved in Studio, with official private/processed readback at 06:36:33.598 UTC. The old draft is now revision 8 with approval revoked. New draft 823d5dbf-9b3f-4e3c-a7ab-edf9ca7ed317 revision 4 was submitted once through job 78fb0a72-f850-4bd3-a48b-0f9629e4e264; video X8dDltMseM4 is confirmed public/processed at 06:37:59.454 UTC and Public/Published in Studio Shorts. [Current video](https://www.youtube.com/watch?v=X8dDltMseM4). The signed-in player initially reached 36/46 seconds; the 2026-10-12 recheck reached 46/46 seconds with Replay. Subjective quality and anonymous/geographic playback remain separate. Existing scopes returned 403 insufficientPermissions for videos.update; no broader grant was made. Credentials and journals remain private. No paid trial was started.
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

Registering native metadata as Connected alone records an operator check, not an automatically tested OAuth credential. YouTube is now Connected based on the real official OAuth grant, exact channel readback and published video. X, Reddit and Xiaohongshu remain Blocked with their verified identities and policy/access tasks. Product Hunt is the fifth account, native/Connected after observed onboarding completion and usable product URL form. Its capability is manual with automatic=false and remoteDraft=false; actual product draft/launch acceptance still requires a real public product URL and launch facts. Login is not publisher authorization. Use Needs login or Blocked until the creator page and visible account identity have actually been checked. Existing account metadata must be updated when login is renewed; do not create duplicate account entries to bypass a blocker.

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
