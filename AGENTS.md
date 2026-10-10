# Content Studio

- Stage one runs locally on one Mac with Codex. Stage two must remain gated until stage-one acceptance is complete.
- The complete local upgrade uses Supabase CLI with the existing Docker-compatible runtime for local database, Auth, Storage, Cron and Queues. Hosted Supabase is not its default backend; preserve current workspace artifacts until a verified migration.
- Cloud work is feasibility and architecture research only until the local gate passes. Follow docs/local-first-build-review.zh-CN.md for the latest scope, migration boundaries and L0-L5 acceptance. Keep resettable local test instances separate from real local content.
- Use Chrome profile `radarxai@gmail.com` for Google, Supabase, and test-platform account operations. Verify the profile in Chrome before sign-in; never use another account silently.
- Use Supabase whenever a database is required. Do not add SQLite, MongoDB, or a separate PostgreSQL deployment.
- Keep strict TypeScript, no `any`, named exports, and small scoped changes.
- Prefer maintained upstream publishing integrations. Do not add speculative unofficial platform API calls or claim browser handoff equals automatic publishing.
- Never store credentials, cookies, browser profiles, OAuth tokens, or raw Codex chat logs in tracked files.
- Record account blockers with precise operator instructions in docs/accounts.md.
- Generate content separately from publishing. Approval binds the content revision and target account. Unknown publish outcomes require reconciliation, not automatic resubmission.
- Confirm publication with a remote identifier and platform URL; a queued job or upload alone is not a published post.
- Read docs/architecture.md and docs/acceptance.md before expanding scope.

- Enforce current platform policies before live delivery: X trend-topic drafts require genuine human publication, and X website automation is not an approved route. Reddit automated access needs App registration/approval; YouTube unattended delivery uses authorized Data API/OAuth. Check news/professional-content eligibility separately on Xiaohongshu. See docs/platform-policies-v2.zh-CN.md.

- For content research, discovery/scheduler prompts, generation and refinement, use `.agents/skills/content-editorial/SKILL.md` and `docs/content-growth-guidance.md`.
- The owner's editorial exclusions take precedence over reach: exclude gender discrimination, religion, war/armed conflict, politics/elections/geopolitics, and the additional sensitive themes defined in `src/core/content-prompts.ts`. Do not reframe an excluded topic as a neutral explainer.
- Keep shared prompt policy in `src/core/content-prompts.ts`; article generation executes it, while discovery/refinement/video builders are prompt exports until their respective workers are implemented. Generated safety assessment is model-reported, not independent moderation or publication clearance.
