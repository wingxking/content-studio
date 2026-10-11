# Content Studio

- Stage one runs locally entirely in Docker and must be portable across computers. Stage two remains gated until local acceptance is complete.
- The deployed runtime uses Compose: Supabase, API, role workers, Linux Codex executor, CPU TTS and renderer. Native scripts are legacy migration/recovery tools only. Never accept required launchd, macOS say, host Node/Codex/Supabase CLI, Keychain or fixed user paths as final runtime. Preserve the old instance until isolated migration/recovery passes. See docs/docker-runtime.md for supported startup/transfer and executed evidence.
- Follow docs/docker-dual-pipeline-architecture.zh-CN.md for the latest target, upstream choices and D0-D6 gates; docs/local-system-delivery.zh-CN.md records the implemented baseline. The new target supersedes older default Storage-copy/native-worker design choices. Cloud work remains feasibility research only until local acceptance; keep test instances separate from real content.
- Default original media and generated files to LocalFS under an ignored, non-synced local bind root. Keep business state and revision authority in Supabase. Existing Storage assets remain readable until hash/reference verification and backup/restore pass; do not introduce a second authoritative media copy.
- Article and video are independent domains, workspaces, jobs and tools, sharing evidence, immutable physical assets and infrastructure. Video creation and rendering remain explicit actions; article linkage is optional and revision-bound.
- Prefer maintained upstream execution/tool capabilities. Evaluate pg-boss behind an isolated migration gate; never run two engines or schedule owners for the same work. Article/video deliveries share one account-serialization domain; unknown submission outcomes require reconciliation.
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
- Keep shared prompt policy in `src/core/content-prompts.ts`; task research, article generation, discovery, refinement and explicit video-script workers execute it. Keep prompt builders reusable and distinguish them from durable job execution. Generated safety assessment is model-reported, not independent moderation or publication clearance.
