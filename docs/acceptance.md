# Stage-one acceptance and remaining work

Date: 2026-10-10, Asia/Singapore. Stage one is not complete until live publishing works for the agreed initial platform set. Stage two is gated and has not started.

## Required local acceptance

- [x] Real Codex generation from a supplied source brief; exactly one valid variant per requested platform.
- [x] Review/edit/approve cycle; content or media changes invalidate approval.
- [ ] Real PNG cards and MP4 containing video plus audio; inspect visual and narration output.
- [ ] Account metadata and intended account identity match the requested Chrome profile.
- [ ] Approved content schedules to one target account without duplicate delivery.
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

No live account has been accepted for publication in this delivery yet. A manual receipt is operator-attested; a provider PUBLISHED response is provider-reported. Neither alone is proof of public visibility. See [accounts](accounts.md) for exact access handoff tasks.

## Remaining product work

- [ ] Complete account setup and authorized publication tests for Xiaohongshu, Reddit, X, WeChat, TikTok, Bilibili, YouTube, Kuaishou and other selected channels.
- [ ] Configure a documented publisher and exercise live API submission/reconciliation.
- [ ] Validate a dedicated Supabase project if cloud database persistence is selected.
- [ ] Evaluate maintained China publishers against actual accounts before adding their adapters; pin reviewed versions.
- [ ] Run repeated original-content cycles and record actual performance/cost.
- [ ] Automate source discovery and analytics only after their permitted API/collector routes are verified.
- [ ] Decide whether the initial complete stage-one platform set can be smaller than all requested destinations.
- [ ] Start stage-two implementation only after the stage-one gate is achieved.

Implementation, local tests, account creation, live publication, cloud persistence and cloud deployment are independent milestones. Do not merge them into one “complete” status.

## Verified local evidence

- TypeScript, production build and 32 tests passed. Tests include actual 1080px PNG generation and an MP4 with video/audio confirmed by ffprobe; review fixtures exercise delayed dispatch, changed approval, stale media revision, concurrent processes, unknown outcomes and Supabase CAS. Supabase CAS uses mocked HTTP, not a live project.
- A real Codex CLI invocation generated a sourced master draft plus X, Xiaohongshu and YouTube variants using saved local authentication. The initial sandbox invocation failed; the authorized host invocation succeeded. No publishing credentials were used.
- Chrome in the requested profile loaded the actual workbench, displayed the generated draft, approved its text, and produced three real Xiaohongshu PNG cards. Attaching media advanced the revision and cleared approval as required.
- No live platform post was submitted; no account is marked accepted; no provider API credential or cloud database was configured. Browser operations stopped when the WeChat URL was rejected by Computer Use.
