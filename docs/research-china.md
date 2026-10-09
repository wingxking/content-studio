# China publishing routes and local-first integration research

Researched 2026-10-10 (Asia/Singapore). Scope: Xiaohongshu, WeChat Official Accounts, Bilibili, Kuaishou, Douyin, and reusable open-source publishing tools. No account was registered, no application permission approved, and no live post published during this research. Documentation is evidence of a possible route; account-specific acceptance still requires a live session and actual readback.

## Decision

Use a local publishing coordinator with per-platform capabilities. Stage 1 runs on the user's Mac and is callable from Codex through commands/MCP. Prefer documented official publishing APIs where an approved application and authorized creator account are available. Keep browser-based publishing in a local adapter with explicit account/login and verification states. Do not claim that a generic social publishing SaaS covers China platforms through official APIs.

For Stage 1, the fastest open-source candidates are Wechatsync for article drafts, social-auto-upload for video/image-note browser workflows, and xpzouying/xiaohongshu-mcp for a dedicated Xiaohongshu MCP integration. They need account-specific live verification before being enabled. Stage 2 should be deferred until the local route has been accepted; official API adapters can migrate first, while browser-session adapters may still require a local companion or user-operated browser.

Use Chrome profile `radarxai@gmail.com` for debugging and provider onboarding. A Chrome Google identity does not create accounts or publishing permissions on Chinese platforms. Use that email where a platform accepts an email contact; Google OAuth can only be used where the actual platform offers it.

## Capability and onboarding matrix

| Platform | Confirmed content route | Stage 1 route | Account handoff | Google account suitability |
|---|---|---|---|---|
| Xiaohongshu | Creator web UI; App share SDK. No generally available server-side note publishing API confirmed | Logged-in Chrome creator workflow; evaluate local MCP or CLI | User opens creator portal, completes SMS or app QR login and any verification in the browser, then agent checks identity and permissions | Creator search result shows SMS; no Google sign-in verified |
| WeChat Official Account | Official draft/publish documentation exists but primary pages could not be fetched in this session | Use browser draft flow until account API permissions are inspected; API adapter only after inspection | User supplies an existing Official Account by completing administrator QR login; if creating an account, user completes identity/subject verification directly | Google profile/email may help access email; no Google SSO verified |
| Bilibili (mainland) | Official video and article APIs, permission and user authorization gates | Official API if approved; otherwise creator web submission or current biliup | User completes phone/app QR login and required account/developer identity checks, then authorizes app scopes | Mainland privacy policy lists WeChat, Weibo, QQ as third-party logins; international Bilibili is a separate product |
| Kuaishou | Genuine official user video publishing API | Approved API or creator browser flow/CLI | User completes Kuaishou login; official developer onboarding requires a real-name administrator account and application setup | Email can identify developer account; no Google SSO verified |
| Douyin | Genuine official video publishing API | Approved API with user-perceived creation, or creator browser flow/CLI | User completes mobile/app QR login and app OAuth permission grant | Official privacy policy requires a phone for posting; no Google SSO verified |

## Xiaohongshu: avoid confusing ecommerce, identity, sharing, and publication

The ecommerce documentation enumerates orders, after-sales, products, inventory, logistics, finance, and related commerce operations. Its availability does not establish access to creator note publication. [Official ecommerce API catalog](https://open.xiaohongshu.com/document/api?apiId=22012&apiNavigationId=99&apiParentNavigationId=14&gatewayId=103&gatewayVersionId=1661&id=22).

The identity portal's scope documentation currently says only `basic_info` is open; `write_notes` is marked planned, with sensitive-permission review for relevant future scenarios. Therefore it should not be treated as an available unattended publishing API. This source is search-index evidence; direct retrieval timed out and console eligibility remains unverified. [Official scope documentation](https://openaccount.xiaohongshu.com/docs/scope).

The official JS share SDK transfers content into the Xiaohongshu App. This is a user-mediated sharing route, not proof of cloud server publication. [Official JS share SDK](https://agora.xiaohongshu.com/doc/js).

The creator portal's indexed login page shows phone/SMS controls and email/password controls. Google SSO was not shown. [Creator portal](https://creator.xiaohongshu.com/).

Actionable handoff: open that portal in the specified Chrome profile; the user directly completes platform login, app QR confirmation, SMS challenge, or identity challenge. After login, capture the displayed account name/ID, verify the editor is usable, create a harmless draft, read it back from the content/draft list, and only claim live acceptance after a published note URL can be reopened and observed in the account's own content list. These verification steps are implementation recommendations, not claims that every platform exposes identical draft controls.

## WeChat Official Accounts: permission verification is a prerequisite

Primary WeChat pages could not be fetched by the research tool. Preserve the official references, but mark current endpoint availability and account entitlement as unverified:

- [Add draft, current service documentation path](https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_add.html)
- [Submit draft for publication](https://developers.weixin.qq.com/doc/service/api/public/api_freepublish_submit.html)
- [Query publication status](https://developers.weixin.qq.com/doc/service/api/public/api_freepublish_get.html)
- [Legacy draft documentation](https://developers.weixin.qq.com/doc/offiaccount/Draft_Box/Add_draft.html)
- [Legacy publication documentation](https://developers.weixin.qq.com/doc/offiaccount/Publish/Publish.html)
- [Account portal](https://mp.weixin.qq.com/)

Do not assume a personal subscription account has publication API permission. Third-party reports describe removal of publishing permissions for some personal/unverified accounts from July 2025, but this was not independently established from accessible primary material and must not be promoted to a verified current fact in the product.

Actionable handoff: user logs in to the Official Account backend with the administrator's WeChat QR confirmation; inspect account subject/type and the backend API permissions before promising draft or publication APIs. If API use is enabled, credentials must be stored locally in a secret store/environment and IP allowlisting must be checked against the actual calling location. Avoid placing secrets into committed project files. Browser draft generation can proceed with an existing authenticated administrator session when allowed by the UI. A successful submission is not sufficient acceptance; require the backend status plus the resulting article URL and readable article content.

## Bilibili: official capability is real but gated

The official developer agreement expressly includes batch manuscript publication. Developer/app registration is not the same as authorization to publish for a particular creator. [Developer service agreement](https://open.bilibili.com/agreement/developer-service).

The official article route requires `ATC_BASE` application permission and user authorization, submits to `/arcopen/fn/article/add`, returns an article ID, and has an audit period during which it is not public. Its documentation calls for developer identity information and review before app creation. [Article submission](https://open.bilibili.com/doc/4/b14b77b6-8889-8c8b-2e83-17c5a4c550fb).

Official video demo code shows OAuth token exchange, upload initialization, part upload, merging, cover upload, and submission to `/arcopen/fn/archive/add-by-utoken`, yielding a `resource_id`. [Official Go demo](https://github.com/bilibili-openplatform/demo/blob/main/golang/main.go). The official video detail query requires `ARC_BASE` and user authorization. [Query a video](https://openhome.bilibili.com/doc/4/d9554788-dcef-f139-6217-b487d41c3826).

The official error catalog documents app/user authorization errors, request limits, additional confirmation, image verification, and account eligibility failures. A runner must surface these as actionable account requirements rather than repeatedly retrying. [Signing and error codes](https://open.bilibili.com/doc/4/8673959e-f7bb-56e6-6e68-d225f971b81b).

Mainland account policy lists phone registration/login, email login, and WeChat/Weibo/QQ authorization; it does not list Google. [Mainland privacy policy](https://www.bilibili.com/blackboard/privacy-pc.html?visit_id=1brx8eqpnf7k). International Bilibili policy does mention Google, but that does not establish mainland creator submission access. [International privacy policy](https://www.bilibili.com/blackboard/protocal/international_cn_privacy.html).

Actionable handoff: user logs into mainland Bilibili in the chosen Chrome profile, completes phone/QR and any identity or membership checks, then authorizes an approved publishing app if available. Otherwise use the [official web submission path](https://www.bilibili.com/h5/customer-service/home) or evaluate current biliup. Acceptance must link the submitted resource to the readable public video/article and account content list after audit.

## Kuaishou: asynchronous official user-video API

The official route requires OAuth `access_token`, registered `app_id`, and `user_video_publish`: start upload, upload bytes or parts, then publish. The documentation explicitly says publication is asynchronous; query by `photo_id` to confirm success. `pending` indicates processing/unwatchability. A successful upload may still fail during video validation/transcoding. [Create video](https://open.kuaishou.com/platformDocs/openAbility/contentManagement/createAVideo).

Developer account documentation describes registered email, administrator name/identity, and a real-name Kuaishou account matching that identity. Developer login can use that account's QR or registered phone plus code/password. This is separate from a Google browser profile. [Developer account documentation](https://open.kuaishou.com/platform/openApi?group=GROUP_OPEN_PLATFORM&menu=58).

Actionable handoff: user completes login at [creator portal](https://cp.kuaishou.com/) or supplies an approved developer app through secure local configuration; finish real-name/QR/SMS challenges directly. Verify the account identity and chosen capability. Do not report a returned `photo_id` as publication completion until status readback and visible playable content agree.

## Douyin: official creation must remain visible to the user

The official API requires application approval for `video.create` plus user authorization; upload obtains the video ID and creation submits the post. An audit stage follows creation, with the video visible only to the creator during that stage. The documentation also requires users to clearly perceive each creation performed on their behalf; permission may be revoked for imperceptible delegated publishing. Therefore an unattended product must not assume OAuth consent alone satisfies the documented UX condition. [Create video](https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/create/create-video).

Douyin privacy policy says phone verification is needed for posting functionality. [Privacy policy](https://www.douyin.com/draft/douyin_agreement/douyin_agreement_privacy.html?id=6773901168964798477).

Actionable handoff: log in at [creator center](https://creator.douyin.com/) in the specified profile, user completes SMS/app QR and verification, then grant OAuth to an approved app if available. Account requirements, audit status, and public visibility must be represented separately. A creation ID is acceptance of submission, not evidence of public publication.

## Open-source candidates and integration boundaries

### social-auto-upload

MIT-licensed project with a current CLI/skill-oriented mainline and browser upload implementations for Douyin, Xiaohongshu, Kuaishou, WeChat Channels and others; Bilibili wraps biliup. The repository notes an ongoing refactor, with historical web code no longer guaranteed current. Thus use pinned versions and CLI adapters, then test actual accounts. It is a third-party publisher, not an official platform API. Its browser automation includes secondary-verification handling; do not treat that as permission to evade challenges. [Repository](https://github.com/dreammis/social-auto-upload).

Recommendation: strongest breadth candidate for Stage 1, behind a coordinator that validates local files, isolates per-account state, records attempts, and reads back actual results. Do not auto-update executable dependencies during a pending publication; make updates explicit and re-verify.

### Wechatsync

GPL-3.0 Chrome extension with CLI and MCP bridge, using existing browser login state and platform web-editor endpoints; its README describes draft-first operation and lists WeChat, Xiaohongshu, Bilibili columns and Douyin image notes among supported destinations. These are website endpoints used by a third-party extension, not necessarily formally supported developer Open APIs. [Repository](https://github.com/wechatsync/Wechatsync).

Recommendation: fastest article-draft candidate. Keep it as a separate local tool/process rather than copying its adapters into a differently licensed product without a license review. Require draft readback and explicit identification of which destinations actually publish versus only save drafts.

### xpzouying/xiaohongshu-mcp

Apache-2.0 original project offers Mac binaries and standard MCP; first login is manual, saved locally, and the README describes note/video publishing. [Repository](https://github.com/xpzouying/xiaohongshu-mcp).

Recommendation: dedicated Xiaohongshu Stage 1 option when a reliable account/session is present. Prefer original maintained upstream over small wrappers/forks; capability and safety claims still need live inspection.

### biliup

Current biliup offers login, renew and video upload commands and local cookie-file configuration. [Current README](https://github.com/biliup/biliup/blob/master/README.md?plain=1). The older biliup-rs repository was archived 2025-11-30 and explicitly directs users to biliup. [Archived repository notice](https://github.com/biliup/biliup-rs).

Recommendation: evaluate current biliup for local Bilibili video fallback; preserve the distinction from official Open Platform OAuth API. Cookie files are credentials and belong outside tracked work.

## Required Stage 1 acceptance and account TODOs

Recommendations, derived from the documented asynchronous/review/account constraints:

1. Select the actual account in Chrome profile `radarxai@gmail.com`; verify displayed account ID before any submission.
2. User completes SMS, QR, CAPTCHA, 2FA and real-name challenges directly in platform UI. Do not ask them to paste passwords, tokens, cookies or identity-document scans into chat.
3. Save safe account metadata only: platform, handle/ID, intended route, tested scope, login timestamp, verification blocker and next action. Credentials stay in the OS secret store or ignored local config.
4. Create a test content package, save/read back a draft where supported, then submit a single appropriate test post through the user's authorized test scope.
5. Store attempt ID and immutable package hash before submission. On ambiguous timeout, inspect platform content first; do not blindly re-submit.
6. Separate `draft_saved`, `submitted`, `processing/review`, `published_verified`, `needs_login`, `needs_user_verification`, `permission_required` and `failed`.
7. Verify published success with stable platform ID, resulting URL, and account content-list readback after platform processing/review. A button click, API 200, or upload success does not meet this gate.
8. Re-run after a Mac restart and show how Codex invokes the runner using the existing session; handle an expired session as a resumable account task.

Account TODOs are legitimate when Google login is not supported. Ask the user to open the designated platform portal in the chosen Chrome profile, complete QR/SMS/identity verification there, and report the visible handle only. For official API routes, record approved app/scopes and have the user configure secrets locally. Stage 2 remains deferred until this local workflow is accepted across the enabled destinations.
