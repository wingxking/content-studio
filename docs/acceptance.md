## 2026-10-21 插件迁移续接

- 插件 2.0.13 配对迁移、原位升级和 Chrome 内重新加载已经验证；旧同步助手停用但保留存储。原未知草稿记录保留，未重发。
- 主项目最终 v22 Docker 检查：严格 TypeScript 通过，584 项测试中 583 通过、1 项原有媒体跳过、0 失败。插件 76 项单元测试和 9 项真实 bridge/Supabase/pgmq 集成测试通过，平台 HTTP 为模拟。
- 恢复协议覆盖“未知结果阻止新写入 → 原平台核对 → 原任务登记回执 → 同步插件日志”，不再次发送草稿。真实知乎草稿读取仍被创作中心开通门槛阻塞，不能算真实平台全链路验收通过。
- v22 进一步移除日常账号页中的开发测试面板，后端和插件逻辑与已测 v21 相同；完整执行范围、保留的回归证据与人工步骤见 [本轮交付记录](plugin-recovery-delivery-2026-10-21.zh-CN.md)。连续 48 小时观察须针对最终版本重新开始，不能累计旧窗口，也不能替代内容质量及真实发布验收。

## Historical task-workbench delivery — 2026-10-19

The original main instance now runs `20261019-workbench-v18` at `http://127.0.0.1:4310`. See [the delivery record](task-workbench-delivery-2026-10-19.zh-CN.md) for actual test results and remaining gates. Main regression: 555 passed / 1 historical skip / 0 failed; companion: 52 passed plus 8 real local API/queue/bridge tests with mocked platform writes. Exact-image restart recovery, duplicate prevention, MP4 decode and browser flows passed. The v18 48-hour observation started at 2026-10-19 05:09:50 UTC and is not accepted yet. Chrome activation, current account reconciliation, public delivery and existing editorial/production acceptance gates remain open. Publishing and schedules remain paused.

# Local product acceptance and channel delivery evidence

当前单实例升级与验收记录见 [2026-10-19 统一环境](unified-runtime-2026-10-19.zh-CN.md)。当前入口为 `http://127.0.0.1:4310`；旧隔离验收地址仅为历史记录。

2026-10-17 证据生产 v2 的实现与独立验收边界见 [来源权重、知识检索与自动审校](evidence-production.zh-CN.md)。迁移/模型/PDF/持续运行分别验收，不能将夹具结果视为生产准确率。

最新品牌、任务授权与双时间交付复核见 [2026-10-17 升级记录](automation-brand-review-2026-10-17.zh-CN.md)；实现与真实平台准入分别验收。

Date: 2026-10-10, Asia/Singapore. The latest scope accepts a complete local application with automatic publishing where authorized and actionable native publishing handoff elsewhere. Local application acceptance and live acceptance of each channel are separate. Cloud work remains feasibility and architecture only. Current implementation and executable acceptance are recorded in [local system delivery](local-system-delivery.zh-CN.md).

## Implementation review checkpoint: 2026-10-15

The follow-up [review and fixes](review-workflow-2026-10-15.zh-CN.md) are deployed as **`20261015-review-v9`**, application image `sha256:d5c00bbd399f4570098a6b1fbdae83e3975ff98f54b8f3ada036a739b3c3fbc9`. This supersedes the v8 runtime below without adding a dependency or database migration.

- [x] **374 tests: 373 passed, 0 failed, 1 historical macOS test skipped**; strict Node/browser TypeScript, production build and whitespace checks passed. Real Supabase/024 also passed the legacy-proposal smoke and a deliberately stale CAS commit, with safe conflict classification and no duplicate revision/followup.
- [x] Full interactive Web acceptance in disposable workspace `7a3b337d-7baa-4542-adf1-abdbc6f6a59d` used the production API, Supabase and pgmq with deterministic research/model/extension fixtures. It covered hotspot → production, draft-only automatic sync, platform-only editing, mixed two-article/two-account draft results, replay without duplicate delivery, task cloning with scheduling disabled and batch-filtered read-only history. The detail contained zero edit/delivery controls. Initial task-navigation checks also proved “continue editing” retains input after both New and task-switch actions.
- [x] The video fixture used a previously fully decoded real 320×180 MP4; this run does not claim another render. Two platform targets shared that single render. After changing YouTube metadata, the entire Bilibili target and approval remained equal. Unsaved shared narration disabled both approval buttons. A synthetic unknown YouTube result blocked that target's edit while Bilibili could reuse its existing approved handoff. Copy-title and controlled video preview passed.
- [x] A document-free legacy article with an opaque media reference previewed as **video**, not image: readyState 4, 320×180, 2.416667 seconds. Its HTTP download matched SHA-256 `3dc81be4791e47a670ede29a378a51b18fae498d606c7c804ae4dcb8b27f550b`. Platform-only editing preserved master bytes and the absent document; the original revision-one export and media bytes matched on fixture shutdown.
- [x] Fixture setup initially exposed an overly narrow W3C assertion in the fake extension and a missing fixture journal initialization. Both were corrected in test setup; no production bypass was added. The completed fixture exited 0 and cleaned its tables. The first aborted fixture was explicitly cleaned; queued messages from the exact disposable workspace IDs were archived, with zero remaining active fixture messages. No real model call, platform submission, public post or owner media mount occurred.
- [x] **Actual v9 Kubernetes → Compose → Kubernetes roundtrip** passed after deliberately changing only the candidate configuration to a never-adopted, nonexistent image. Compose used the v9 image ID from the active runtime marker, not the candidate; all configured API/worker health checks passed. The validated v9 configuration was restored before gated Kubernetes adoption. Wrong-context invocation was rejected before resource operations. All six Supabase container IDs stayed unchanged.
- [x] Final Kubernetes is **8/8 Ready**, API readiness 200; original **5 articles / 6 delivery records / 2 video projects** and all three business hashes match the pre-review baseline. **868 authoritative files** match the earlier verified backup, excluding three ephemeral worker-health timestamps. Only Supabase runs in Desktop; Web/companion listen solely on 127.0.0.1:4310/19527. Global contexts were preserved.
- [x] Final owner-page readback loaded the original revision-five article with Save disabled, no alerts, and no browser warning/error; the content-management page loaded read-only. Temporary browser tabs and fixture containers were closed. The verified owner Chrome profile's existing extension popup restored the original pairing, with passive setup confirming connected, **publishingPaused=true / schedulerEnabled=false**. No settings, token, permission or platform content was changed.

The Bilibili official adapter/grant, other live-platform acceptance, automatic extension cold wakeup and 48-hour burn-in boundaries below remain unchanged.

## Workflow, video and OrbStack checkpoint: 2026-10-15

This checkpoint supersedes the earlier Compose-only application topology. The five article pages and independent multi-target video workspace are implemented; see [implementation and boundaries](workflow-kubernetes-video-implementation.zh-CN.md) and [runtime operations](orbstack-kubernetes.zh-CN.md). The accepted owner application now runs in namespace `content-studio-k8s` with **8/8 deployments Ready**. The original Supabase, pgmq and pg_cron remain in Compose project `content-studio-k-test`, using the original database and bind root. Web and companion listeners were checked on **127.0.0.1:4310 / 19527**, with no LAN listener. Docker's global context remains `desktop-linux`; Kubernetes calls use explicit `--context orbstack` without changing the global current-context.

- [x] Strict Node and browser TypeScript, production build and **370 tests: 369 passed, 0 failed, 1 skipped** (historical macOS speech) passed. Docker/Kubernetes ownership, backup, real-shell lifecycle and process-health checks passed. Kustomize server-side validation and Compose configuration validation passed.
- [x] Migrations **018–024** were applied after encrypted backup. Actual rollback-only SQL tests verified atomic article/current-revision/receipt/outbox commits, command replay, accepted-proposal followups without duplicate adaptation, platform-specific publication history, discovery-derived batch filters, pure reads, shared article/video account serialization, lease fencing and unknown-submission barriers.
- [x] Final incremental review repaired legacy AI-proposal normalization, selected-model inheritance and checkpoint baseline-path exposure. A one-off application process using real Supabase/024 verified `applyOperation` on a document-free draft, exact frozen payload, model/instruction inheritance, one followup, replay without another revision/operation, and safe editor/checkpoint projections including real field conflicts. It ran no worker/model/platform action; the randomly created workspace and all six related tables were deleted and re-read empty afterward. `tests/article-proposal-database-smoke.ts` records the reproducible guard and assertions.
- [x] A random disposable workspace exercised real Supabase/pgmq with fixture research/model/extension: knowledge snapshots, discovery promotion, failed adaptation retry, immutable export and three platform draft receipts. Master generation ran once; repeated delivery created no duplicate write and no public post. Its database fixtures were cleaned. This is transport and workflow evidence, not a claim of new live-platform acceptance.
- [x] The independent Kubernetes video fixture used real Kokoro, prepared-media/MPT and FFmpeg to produce horizontal and portrait videos, fully decode both MP4s and verify download hashes. YouTube and Bilibili target metadata/approval remained independent while sharing one physical render. Repeated preparation returned the same handoff jobs, with zero delivery attempts. API Pod recreation preserved Tus half-upload offset and final file SHA-256.
- [x] An actual render interruption stopped a video worker while the renderer was running. The old upstream attempt later succeeded but did not promote a result after losing ownership. After the real 120-second lease expiry, a new worker resumed the same render/operation, attempt 1→2, reused 9 stages and produced a fully decoded 960×540 MP4 with SHA-256 `37455bce908dd049b67a255f3a5bf9e7d84844262bf83d3bf7232701b396a4c4`. Database clocks and leases were not shortened for the test.
- [x] Browser checks covered all five article entries, URL filters/deep links, read-only management, history/batch relations, unsaved navigation protection, paginated video selection, platform-specific metadata and actual video playback. Opening an old draft without a rich document caused no write; changing only its Zhihu title kept master text, absent document and other platform content unchanged and scheduled no AI adaptation. Browser warning/error count was zero. These UI checks used v4; v5 retains the same UI and includes the final activity-operation enum and migration 023.
- [x] The pre-migration format-3 encrypted backup verified **1,062 files** and restored the original 3 workspaces to isolated Compose with matching business/article/video hashes. The later backup made after stopping all Kubernetes application Pods verified **1,065 files**; its isolated restore matched all **4 workspace business states**, article/video revisions and command receipts, plus **868 authoritative business files**. Three ephemeral worker-ready timestamps were checked separately rather than treated as business data. **Two unknown-upload barrier markers** survived without restoring account/model authorization. The restored API passed `/readyz`, list/detail, media-byte hash and SPA deep-link checks; its workers were never started and the restored instance is now stopped with files retained.
- [x] Release **`20261015-workflow-v5`** completed **Kubernetes → same-release Compose → Kubernetes**. Article, video and delivery hashes matched across all three observations: **5 original articles, 6 original delivery records, 2 original video projects**. The first fallback exposed an unintended Compose dependency reconciliation and stale Kong REST DNS; writers were stopped, only Kong was refreshed, and rollback now uses `up --no-deps` with explicit root/project settings. The corrected roundtrip preserved all six Supabase container IDs. API and role-worker Compose probes now check live readiness. Compose application containers and fixture Pods are stopped; PVs and data are retained. No workspace ever had two active application runtimes.
- [x] Final adopted release **`20261015-workflow-v8`**, application image `sha256:885caba324d159332cf27fdaf33a66bc01b1d586caa08ffa19188227bc1a4252`, includes the proposal/projection corrections above. Migration 024 ran only after all application Pods exited; Supabase containers were retained. The matching image was built in Desktop, transferred to OrbStack and verified by image ID before fresh Pod preflight, server validation and gated adoption. All **8 deployments are Ready**; owner article/video/delivery hashes still equal the v5 baseline, with the same six Supabase container IDs. The unchanged model/renderer/TTS use fixed aliases of the already verified images. v6/v7 were build candidates and were never deployed. The encrypted post-Kubernetes restore checkpoint above covers schema through 023; 024 additionally passed rollback-only SQL and the actual isolated application/database smoke.
- [x] Final v8 visible-page recheck in the verified owner Chrome profile confirmed navigation, article list, revision-five master and three platform tabs, media and distribution panel. Opening the draft kept Save disabled and caused no edit or submission. The temporary QA tab was closed. IAB was unavailable in this final check, so it does not add a new console-check claim to the earlier v4 evidence. At **11:49:15.712Z**, passive setup confirmed the existing companion connected, publication paused and scheduler disabled.
- [x] Passive setup readback confirms **publishingPaused=true / schedulerEnabled=false**. Existing owner Chrome pairing recovered by opening its already installed companion popup, with no settings/token change, new permission or platform request. After closing it, snapshots at 0, 73, 128 and 190 seconds remained connected. This establishes operator-assisted reconnection and sampled keepalive, not automatic cold wakeup.

No public post, video upload or new platform grant was created by this implementation acceptance. YouTube continues using the existing official OAuth/resumable adapter. Bilibili automatic video delivery stays disabled until a reviewed official adapter and application grant exist; its current route provides the shared MP4, subtitles, platform metadata and native handoff. Other per-account live delivery checks, automatic companion cold wakeup and the 48-hour burn-in remain separate unfinished gates. Stage two/cloud work remains gated.

## Latest k checkpoint: 2026-10-15

This checkpoint supersedes the historical uninstalled/unpaired extension, blank-browser and model-login blockers below. Live bridge keepalive, container authorization, real article generation and one private Zhihu draft save/readback passed their scoped checks.

- [x] The owner approved the actual all-websites data and downloads permissions for official WechatSync **2.0.9**. Initial pairing in the verified `radar` Chrome profile returned **connected=true**; a Zhihu-only live `checkAuth` succeeded in **177 ms**, identifying **孔涛** and an actual UID. Account `390dfd96-6e1d-40ca-be9f-aacf43f5d510` was bound with `status=connected` and `permissionConfirmed=true`. This records that initial success, not the current connection state; no UID or pairing secret is reproduced.
- [x] The final full Docker run and strict TypeScript passed **326 tests: 325 passed, 0 failed, 1 skipped** (historical macOS `say`), from `content-studio:local` with `STUDIO_CONTAINER=false` and no private runtime mounts. This supersedes the earlier 325-test checkpoint and includes safe Markdown-to-HTML/empty-Sources regressions. The empty-Sources correction also passed **22 targeted remote-draft tests**; commit **`9b9e68e`** was built and deployed to API/delivery worker. The UI checks only the selected platform; failed checks cannot bind cached identity. The authenticated bridge keeps its independent 20-second heartbeat/8-second timeout during long requests, and unknown writes never replay.
- [x] The new one-off Docker ecosystem smoke passed end to end in workspace `f99fa126-e3c2-4150-82b7-7fbe9ba7e41d` with real Supabase/pgmq and fixture model/extension. Its `finally` cleaned up the database workspace. This proves isolated transport/recovery, not live model/platform authorization.
- [x] The old bridge's complete **120-second** passive test sampled the actual `draftBridgeStatus.connected` boolean: t=0 and t=15 true; t=30 through t=120 false. This is valid old-version evidence, distinct from the earlier invalid Chinese-label sample.
- [x] An accidental static-Token accessibility output was followed by official-store reinstall/revocation and fresh private pairing save through IAB Accounts, rotating pairing/service keys. Private comparison confirmed the extension's URL/Token match the saved configuration. No values are recorded.
- [x] The owner's workspace retains **6 accounts and 6 jobs**, **paused=true**, the existing UID binding and **zero new Zhihu jobs**. The isolated QA workspace now has **1 account and 1 draft-save job**; **0 public posts** were created.
- [x] The new heartbeat passed a real **180-second idle test: 13/13 authenticated connected samples true**, logged **03:18:02–03:21:02**, with extension settings closed and Chrome on a neutral tab. This establishes existing-connection keepalive for that interval, not cold wakeup. The later 10-second Zhihu timeout was superseded by fresh **200 OK / 320 ms** and subsequent **120 ms / 154 ms** identity successes. Native `/api/v4/me` showed 孔涛 without a challenge; temporary DevTools/extension details were closed afterward. [Detailed account evidence](accounts.md#k-account-continuation-2026-10-15) does not guarantee future network availability.
- [x] The owner directed Codex authorization to visibly verified Chrome profile **`zill.xkk@gmail.com`** and selected the existing same OpenAI account through **Personal account → Continue**. Browser OAuth wrapper exit code was **0**; main `model-runner` reports **Logged in using ChatGPT**, and `/readyz` returned **200 / ready=true**. No device-code security setting changed, host/profile credentials were not copied, temporary login/operations containers were absent afterward, and the mode-0600 URL handoff file was deleted. The earlier private account alias and all OAuth secrets are omitted.
- [x] Real **gpt-6.1-sol** knowledge-backed generation completed with **exit code 0** through `tests/ecosystem-live-generation.ts --confirm-isolated-generation --retry --root /acceptance-live/zhihu-live-pFLXZR`. Workspace `a95e8c1b-966e-4190-b074-28be2dd66017`, task `9e43d87e-71cf-44eb-a076-d7466d7394af`, run/draft `a18d6681-d1e2-4d65-89bd-497ef2a54c03`, **revision 1**. The fixed synthetic software backup/revision snapshot produced **5,582-byte master**, **6,323-byte Zhihu article** and **14,865-byte export package**. The main workflow read the full text and checked topic/safety boundaries; publication approval is separate. The script asserted **0 accounts / 0 jobs in that isolated workspace**.
- [x] The explicit `tests/ecosystem-live-draft.ts --confirm-isolated-zhihu-draft --root /acceptance-live/zhihu-live-pFLXZR` completed with **one dispatch / exit 0** in that same QA workspace. Job `37ed121b-ded0-4d7b-ba22-05faa138755b` / operation `9e0945e4-efef-4bc6-ae61-49819a5b25c3` reached **draft_saved, attempts=1**, with native draft **`2094031460613281455`** and [matching editor URL](https://zhuanlan.zhihu.com/p/2094031460613281455/edit). Native radar-profile editor readback verified 孔涛, the exact reviewed title, five H2 headings, lists/bold/source SHA, no literal Markdown markers and **「刚刚·草稿」**. Reopening the same URL in an independent radar window retained the content. QA UI on port 4311 independently showed the completed operation and **「已保存草稿 · 未发布」**, attempt 1.
- [x] At **03:48:34.167Z** the receipt was persisted as **operator_verified**, with public `remoteId`/`remoteUrl` null. Repeating the manual command returned **exit 0 / inspectedOnly=true / dispatchedThisInvocation=false**, the same draft receipt and **attempts=1**: no duplicate draft. IAB independently showed **「平台原生草稿已记录」 / 「已由操作人到草稿箱核对」**, actual draft ID/URL and **「已保存草稿·未发布」**. [Detailed live evidence](accounts.md#live-zhihu-draft-acceptance-2026-10-15) records the title and timestamps.
- [x] The temporary QA tab was closed and port-4311 API container stopped/removed. Main port 4310 remains running; the QA database/manifest and independent radar native-editor window are retained. No public publication was requested.
- [ ] Other platforms, optional Selenium/Chromium, cold wakeup and the **48-hour** burn-in remain unaccepted.

See the [current account instructions](accounts.md#k-account-continuation-2026-10-15) and [upgrade continuation](automation-knowledge-upgrade-2026-10-14.zh-CN.md#2026-10-15-知乎验收续接). Stage two remains gated by local acceptance.

The heartbeat uses only the fixed reviewed [upstream local zip-auth return](https://github.com/wechatsync/Wechatsync/blob/a98e42865387285afcc027c61836488748f3b30f/packages/core/src/adapters/platforms/zip-download.ts#L27-L35), not a real-platform check. [Chrome's MV3 WebSocket guidance](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) covers keeping active workers alive with messages; [its real-time guidance](https://developer.chrome.com/docs/extensions/develop/concepts/real-time#not-great-for-push-notifications) does not guarantee externally waking a suspended extension. Cold recovery after a long bridge outage remains unaccepted.

## Latest six-platform upgrade: 2026-10-11

- [x] Strict TypeScript and production build passed; 187 tests passed with zero failures.
- [x] Real Docker API/Supabase isolated workspace: six platform variants and native handoff jobs; immutable Product Hunt fields, safe HTML downloads, Bilibili article route, repeated-batch deduplication, capability blockers, Origin protection and rejected editor receipt passed.
- [x] Actual Linux Codex generated a 453-character master and 465-character Zhihu/Bilibili article variants with source links; fixed required/nullable output schema compatibility and added direct/remote validation regression.
- [x] Chrome profile `coding (radarxai@gmail.com)` verified; six-platform capability view and video-format exclusions checked.
- [x] Product Hunt fields edited and saved in Web (r1→r2); the old publication snapshot retained r1 fields. All six QA deliveries remained `awaiting_operator`, zero attempts and no remote IDs.
- [x] Fresh Reddit `u/radarxai26` and Xiaohongshu `ziv` login checked; Zhihu and Bilibili require owner QR/SMS login.
- [x] 2026-10-12: Product Hunt registration/onboarding completed in Chrome profile `coding (radarxai@gmail.com)`. Owner-approved age declaration and three newsletter opt-outs submitted via Get Started; step 2 optional profile skipped and recommendations continued without following accounts. Authenticated `coding open / @coding_open` and `/posts/new` product-URL form observed with no Complete onboarding banner. Existing native account updated to Connected; capability readback is manual, automatic=false and remoteDraft=false. No publishing API grant, remote draft or launch created. Five accounts retained; six existing job status/attempt/remote-ID tuples and paused publication verified unchanged.
- [ ] Live Reddit approved API/provider integration and destination acceptance.
- [ ] Product Hunt real-product remote draft/launch acceptance; supply a genuine public product URL and launch facts.
- [ ] WeChat, Zhihu, Xiaohongshu and Bilibili account-specific remote draft/submission/public visibility acceptance.
- [ ] Docker browser publishing bridge and WechatSync draft adapter are not implemented; existing Docker Codex execution is content generation.

See [upgrade implementation and blockers](publishing-capabilities-upgrade-2026-10-11.zh-CN.md). No new live external content was submitted in this upgrade. Earlier native and Docker channel evidence is preserved below.

## Live authentication recheck: 2026-10-12

- [x] Product Hunt authenticated account and product URL form persisted after reload; no onboarding banner. Actual product URL and remote launch are still pending.
- [x] Reddit account menu again showed `u/radarxai26`. Its existing `DevPlatform Actions` grant was inspected read-only and was not reused, changed or mistaken for this application's publisher approval.
- [x] Xiaohongshu creator identity `ziv`, image/video/long-article entries and empty draft list checked. Red Skill hub describes reviewed Skill attachments; it does not demonstrate automated note-publishing permission.
- [x] Zhihu and Bilibili article routes again required phone/App sign-in; no account or creator permission fabricated. The historically prohibited WeChat URL was not retried.
- [x] Official YouTube channel check and complete existing-video playback passed as recorded below. Missing Postiz key produced the expected explicit HTTP 400 configuration diagnostic.
- [x] Four existing account notes/timestamps updated through the local API. All drafts and complete existing job records stayed identical; five accounts, six jobs, paused publication and disabled scheduler retained. Six priority platforms have automatic=false and remoteDraft=false; only the authorized YouTube video route is automatic.
- [ ] User-owned public product URL; owner QR/SMS login for Zhihu/Bilibili; approved Reddit provider and actual destination; permitted WeChat access and Xiaohongshu publishing route.

No new external post, draft, upload or permission grant was made in this recheck. This account/documentation follow-up does not claim a fresh 187-test run; that code regression belongs to the preceding implementation checkpoint.

## Historical local acceptance

- [x] Real Codex generation from a supplied source brief; exactly one valid variant per requested platform.
- [x] Review/edit/approve cycle; content or media changes invalidate approval.
- [x] Real PNG cards and MP4 containing video plus audio; visual samples, exact narration script and audio track inspected. Full human quality review remains separate.
- [x] Four account metadata identities match the requested Chrome profile; YouTube is Connected, while the other three publishing routes remain blocked.
- [x] Original revision 7 and replacement education revision 4 each scheduled to the verified target account; one attempt/journal per distinct video, with no duplicate upload.
- [x] Pause persists; concurrent dispatch cannot create a second submission.
- [x] Ambiguous response survives restart as needs reconciliation.
- [ ] Source content, selected account, platform IDs, URLs, and measured analytics remain traceable.
- [x] Build, typecheck and meaningful workflow tests pass.
- [x] Local Chrome create and review screens checked; native account and live queue acceptance remains pending.

## Required live acceptance per enabled channel

- [ ] Correct account created or logged in; terms, CAPTCHA, SMS/QR/2FA and creator permission checks completed.
- [ ] Draft or preview created and read back where supported.
- [ ] One appropriate original test post/video submitted.
- [ ] Platform processing/review completes; actual post ID and platform URL recorded.
- [ ] Content and intended account checked in creator list; actual public/private visibility confirmed.
- [ ] Expired login or permission rejection becomes an actionable resumable account task.
- [ ] Mac/server restart recovers pending work; uncertain submissions are inspected before resubmission.

The per-channel checklist above remains incomplete across the selected platform set. The YouTube checks actually met are recorded below; other platforms, account renewal and restart remain pending. A manual receipt is operator-attested; a provider PUBLISHED response is provider-reported. Neither alone is proof of public visibility. See [accounts](accounts.md) for exact access handoff tasks.

## Scoped live YouTube acceptance: 2026-10-10

- [x] Dedicated Desktop AI-agent client in radar-511204, External Testing user radarxai@gmail.com and explicit upload/read-only grant completed; exact channel UCVUtH6reLkEuMrUuTh-XgjQ verified by the official API.
- [x] Approved revision 7 submitted once through job 489d1309-02d4-47e8-9d0b-3a9fba52b864; one upload journal and one resulting video.
- [x] Official reconciliation confirmed public/processed video aKaJ3qBAhCc and its [platform URL](https://www.youtube.com/watch?v=aKaJ3qBAhCc).
- [x] The intended RadarXAI Studio Shorts list showed the single item Public/Published; watch-page title, author and AI disclosure matched, and the signed-in player reached 47/47 seconds with Replay.
- [ ] Subjective human full audio/video quality review, anonymous playback and geographic availability.
- [ ] Live authorization renewal/permission rejection, Mac/server restart recovery and repeated production cycles.
- [ ] Measured analytics/cost recording and live Supabase persistence.

This scoped delivery does not complete stage one across the requested channels. X, Reddit and Xiaohongshu remain unsubmitted because of their recorded policy/access blockers. Credential and journal files are 0600 in 0700 directories; no credential values or session URLs are published in these records.

## Replacement and withdrawal acceptance: 2026-10-10

- [x] Owner exclusion of politics/military applied to the replacement brief; the old draft advanced to revision 8 with approval revoked.
- [x] Old video aKaJ3qBAhCc set to Private and saved in Studio; official API confirmed private/processed at 06:36:33.598 UTC. Historical ID/receipt preserved. The old job is needs_reconciliation because the schema lacks a withdrawn/private state; the actual withdrawal result is known.
- [x] Independent sourced AI-agent education draft 823d5dbf-9b3f-4e3c-a7ab-edf9ca7ed317 generated through real Codex, reviewed, rendered and approved at revision 4: four PNGs and a 46.10-second H.264/AAC MP4.
- [x] Job 78fb0a72-f850-4bd3-a48b-0f9629e4e264 submitted once; [X8dDltMseM4](https://www.youtube.com/watch?v=X8dDltMseM4) confirmed matching-channel public/processed at 06:37:59.454 UTC and Public/Published in Studio Shorts.
- [x] Watch-page title, RadarXAI author, AI disclosure and signed-in progress to 36/46 seconds checked.
- [x] 2026-10-12: refreshed official OAuth read-only channel check passed; signed-in watch page reached 46/46 seconds with Replay and the RadarXAI author. No new upload or expanded grant.
- [ ] Subjective quality, anonymous/geographic playback and remaining-channel publication.

See [replacement run](ai-agent-education-run-2026-10-10.zh-CN.md). Historical checks above describe what was observed at publication time; they do not imply the old video remains public. No broader OAuth scope or permanent deletion was performed.

## Remaining channel and production work

- [ ] Complete account setup and authorized publication tests for Xiaohongshu, Reddit, X, WeChat, TikTok, Bilibili, YouTube, Kuaishou and other selected channels.
- [x] Exercise official YouTube API submission/reconciliation for two distinct approved videos and reversible withdrawal of the old one; Postiz remains unconfigured.
- [x] Validate a dedicated local Supabase CLI stack, incremental relational migrations, private Storage, actual pg_cron dispatch and durable pgmq jobs. Hosted Supabase deployment remains stage two.
- [ ] Evaluate maintained China publishers against actual accounts before adding their adapters; pin reviewed versions.
- [ ] Run repeated original-content cycles and record actual performance/cost.
- [x] Implement official regional RSS discovery and verify a real four-country collection.
- [x] Integrate independent source retrieval and real Codex web research. Automatic platform analytics remain channel-dependent; manual observations are supported.
- [x] Preserve all requested platform targets; the local-product scope supports native handoff when an authorized API is unavailable, as explicitly requested by the owner.
- [ ] Start stage-two implementation only after the stage-one gate is achieved.

Implementation, local tests, account creation, live publication, cloud persistence and cloud deployment are independent milestones. Do not merge them into one “complete” status.

## Historical initial local evidence

- TypeScript, production build and 32 tests passed. Tests include actual 1080px PNG generation and an MP4 with video/audio confirmed by ffprobe; review fixtures exercise delayed dispatch, changed approval, stale media revision, concurrent processes, unknown outcomes and Supabase CAS. Supabase CAS uses mocked HTTP, not a live project.
- A real Codex CLI invocation generated a sourced master draft plus X, Xiaohongshu and YouTube variants using saved local authentication. The initial sandbox invocation failed; the authorized host invocation succeeded. No publishing credentials were used.
- Chrome in the requested profile loaded the actual workbench, displayed the generated draft, approved its text, and produced three real Xiaohongshu PNG cards. Attaching media advanced the revision and cleared approval as required.
- At this initial checkpoint no live platform post had been submitted, no account was accepted, and no provider API credential or cloud database was configured. Browser operations stopped when the WeChat URL was rejected by Computer Use. The later YouTube acceptance above supersedes its publishing status.

## Historical 83-test implementation checkpoint: 2026-10-10

83/83 tests passed with no skips, strict TypeScript and production build passed, and the real local HTTP smoke passed. Added regional RSS discovery (all four requested feeds returned 39 candidates), a provenance-based X automation gate, paragraph/word-aware media, and explicit official YouTube OAuth/upload/reconciliation CLI. YouTube/Supabase/Postiz contract requests remain mocked; OAuth testing uses a local loopback with fake token replies.

The actual Codex draft has four platform variants, four Xiaohongshu PNGs and a 47.96-second portrait narrated MP4, internally approved at revision 7. The later live YouTube run completed the real Desktop OAuth grant, a single upload and official public/processed readback plus separate Studio/player checks. YouTube is now Connected; the other three verified accounts remain Blocked. See [run evidence](news-run-2026-10-10.zh-CN.md) and the scoped acceptance above. The 83-test implementation checks preceded this live delivery; this documentation update did not rerun them.

## Current Web workflow acceptance

The original design requirements below are implemented in the local Web application. Check marks require executed evidence, not just code. This list combines executed product API/database/model evidence and the explicitly identified Chrome checks; it does not claim every button was clicked. See [local system delivery](local-system-delivery.zh-CN.md) for the tested paths and limitations. Complete local application functionality and each channel's permission/live-delivery acceptance remain separate.

- [x] Start local Supabase DB/Auth/Storage/pgmq/pg_cron without a hosted project; verify actual service health and loopback-only listening.
- [x] Verify local setup/start/stop/status/upgrade and backup/restore operations. API/worker run independently of the browser. Service stop/start and missed-run SQL behavior were tested; a physical Mac reboot/sleep cycle was not performed.
- [x] Keep real local data and resettable test instances separate; replay migrations only against an explicitly disposable test target.
- [x] Restore database plus actual media bytes into an isolated instance; check hashes, references and receipts, keep publishing paused, and reconcile unknown external submissions.
- [x] Represent known private/unlisted/deleted visibility separately from unknown submission outcomes and preserve historical publication evidence.

- [x] Create, edit, pause and run discovery schedules with a prompt, selected assets, explicit time/timezone, missed-run policy and durable run history.
- [x] View 0–20 sourced, deduplicated hot questions for each run and select a question for fine-grained creation.
- [x] Persist a master revision first, then independently generate and validate the requested platform versions.
- [x] Refine through the Web product API and review/apply a proposal: the real XHS-only title change preserved the master and all other platform fields; stale-response/atomic-apply behavior is covered by database tests.
- [x] Propagate master updates to untouched drafts, preserve customized fields, surface conflicts and stale facts, and invalidate only the affected publication approvals.
- [x] Upload and reuse images from one asset library in schedules and generation/refinement; verify selected reference images actually reach the model.
- [x] Create an independent video script only after an explicit product action (API acceptance); render separately and never automatically rerender after a master update.
- [x] Recover immutable content/media revisions and inspect exact historical publication snapshots, target accounts, IDs and URLs from the Web.

### Current executed evidence

- 143/143 automated tests passed with no skips, plus real local Supabase task/operation SQL checks, production build and HTTP smoke.
- A real Codex task fetched W3C evidence, consumed one selected reference image, and generated a master plus Xiaohongshu/Reddit/X/YouTube drafts. An independent discovery run returned two sourced candidates.
- Frequency transitions preserve the same task and its input; actual scheduled dispatch and persistent queue recovery were tested in disposable database workspaces.
- A separate explicitly requested video script was generated and rendered through the product API: 19.23-second 1080×1920 H.264/AAC MP4. The selected image is visible in an inspected frame.
- An isolated cold restore checked 15 Storage objects, 109 legacy media files, 76 content/run artifacts, business-table counts, hashes, loopback-only ports and paused/no-replay state. Restored new video and legacy snapshot paths served matching bytes through a separate API. Only that temporary API/stack was stopped afterward.
- Current read-only refresh of both pre-existing YouTube videos confirmed the withdrawn video as `delivered/private` and the replacement as `published/public`; both retain one original attempt and the same remote IDs. No new video was submitted.
- Full Chrome click-through acceptance is still separate: earlier specified-profile form/frequency/layout checks passed; the remaining browser session was blocked by automatic approval review while an unrelated private page was foreground. The user was asked to foreground the local page. API/database/model validation does not count as completed Chrome interaction.

- Real editor acceptance completed: r3→r4 synchronized all four platform adaptations, preserving the intentionally customized XHS title with a visible conflict. A reviewed title-only XHS proposal applied atomically at expected r4 to produce r5; the master and all untargeted fields stayed identical. Seven downloaded files and r1–r5 history were checked.
- Final r7 attaches the existing explicit video and reference image. X, Reddit and Xiaohongshu each have one `awaiting_operator` job with five steps, exact immutable export, working media downloads and same-job continuation. No new external post was sent.
- [ ] Complete the remaining end-to-end Chrome click-through after the owner foregrounds the local application in the specified profile.

- Final `local:upgrade` applied migrations 001–006 as a no-op and created a fresh complete backup with 15 Storage objects, 109 media files, 104 content/run artifacts and two encrypted upload journals. Final build/start/HTTP smoke passed; database/pgmq/cron are healthy. Restart retained draft r7 and the three native handoff jobs with zero attempts. Publishing remains paused and both acceptance task schedules are disabled.


## Subsequent portable Docker implementation

The deployed target now uses Docker for all local services. See [Docker runtime delivery](docker-runtime.md) for current source contracts, actual ARM bilingual CPU render and fresh D0 recovery evidence, supported private backup transfer and remaining acceptance gates. Historical native runtime/model/publication evidence above is not Docker acceptance. Authenticated Linux Codex structured/image execution has passed in Docker. Final source verification passed 176 tests, strict TypeScript and a production build; live PostgreSQL cancellation/schema checks and Docker public-source fetching also passed. Docker/Chrome acceptance now includes source-backed article generation, merge-preserving synchronization, scoped refinement, scheduled discovery and upload restart recovery. Final rebuilt-image acceptance passed with all 13 services, a fresh standalone Sol-generated script and decoded/download-hash-verified video, the separate model catalog, read-only YouTube verification and the requested Chrome profile. The 48-hour burn-in is still pending.


## Original execution-layer iteration on k: 2026-10-14

The original BeeCMS-inspired iteration adds durable account fencing, immutable finance image renditions, optional isolated browser fixtures and nullable queued metrics. Read [the phase evidence and remaining gates](beecms-iteration-2026-10-14.md). The existing WechatSync native-draft and Postiz provider-draft adapters are implemented; older statements that no draft adapters exist describe historical checkpoints. Real-platform draft acceptance is still distinct from the fake-extension transport test.

Implementation/testing now targets k's isolated `.docker-k-acceptance` Docker runtime. Backup/restore verified 1,042 files and retained unresolved submission barriers without restoring browser profiles or authorization. Optional Chromium transfer, independent owner-profile checks, fresh model authorization, real finance adapters and 48-hour burn-in remain unpassed. No external post was submitted.


## Automation and local knowledge upgrade on k: 2026-10-14

The [executed upgrade](automation-knowledge-upgrade-2026-10-14.zh-CN.md) passed strict TypeScript, production build and 299 Docker tests (zero failures; one historical macOS-say test skipped). Migrations 016/017 and isolated rollback SQL acceptance passed. Actual Supabase/pgmq knowledge→discovery→single child→snapshot retry→revision approval→three mock native drafts passed with zero duplicate writes and zero public posts. Live local Web upload/import/search, configuration, activity and API restart recovery passed. The encrypted 1,045-file backup/default restore retained knowledge hashes with queues/cron/account owners stopped and no model or delivery authorization restored. Existing accounts/drafts/jobs remained identical to the pre-upgrade state.

This is local implementation/fixture acceptance. Native radar Chrome identity and target YouTube Studio channel were independently verified, but the Mac subsequently locked; Linux device authorization timed out, current YouTube API check returned unavailable, Postiz and extension pairing are unconfigured, and optional Chromium image transfer/smoke remain blocked. No new real-platform draft or publication was performed. Stage two, clean first-machine installation, native client, PDF/Office knowledge parsing and 48-hour burn-in are not accepted.

## 2026-10-21 工作台、插件与日志升级

现有本地实例已门控升级为 `20261021-workbench-v20`，9/9 应用服务 Ready，最终检查 Pod 重启数为 0。当前源码 digest 与部署版本一致：`97878d8606ab10d40c8f866e34d6863bd1ed1e0003477af9ba7a205a0b55362f`。升级前备份与普通 Pod 的数据库、物理文件预检通过；本轮没有新增数据库迁移、服务或依赖，也没有运行第二套 Compose 应用。

Docker 主测试 579 项：578 通过、1 个 legacy 视频环境测试跳过、0 失败。严格 Node/Browser TypeScript、构建通过。真实 Supabase 隔离验收覆盖 2 次 API 重启、1,000 个期次、采集和批次幂等、83 条月历记录的 50+33 分页，平台请求 0。v20 FFmpeg 完整解码两个既有合成验收 MP4；renderer/TTS 镜像 ID 沿用已验收版本，本轮不宣称重新跑过完整内容生成与视频渲染。

Chrome 品牌插件 2.0.12 已在指定 profile 实际激活，72 项单测、7 项集成通过，1 项数据库环境子项跳过；类型检查、打包与在线下载 hash 校验通过。实际点击插件内安全重载后仍显示 2.0.12，并保留未知记录写入屏障。owner 仍绑定旧扩展 ID，未迁移配对、清理 journal 或执行真实平台写入；后续步骤见 [账号记录](accounts.md)。

原工作区 6 jobs、5 drafts、6 accounts、2 videos 的数量与业务 hash 前后一致，公开发布与创作调度保持暂停。v20 连续运行观察已于 2026-10-21 17:01:20（UTC+8）通过 UI 显式启动；截至 17:33:20 为 running、33 次采样、约 0.53 小时，尚未通过 48 小时验收。完整规格、平台支持表、证据位置和剩余事项见 [Coding Spec](workbench-coding-spec-2026-10-21.zh-CN.md) 与 [交付报告](workbench-delivery-2026-10-21.zh-CN.md)。
