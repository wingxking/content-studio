# Content Studio

- Stage one runs locally on one Mac with Codex. Stage two must remain gated until stage-one acceptance is complete.
- Use Chrome profile `radarxai@gmail.com` for Google, Supabase, and test-platform account operations. Verify the profile in Chrome before sign-in; never use another account silently.
- Use Supabase whenever a database is required. Do not add SQLite, MongoDB, or a separate PostgreSQL deployment.
- Keep strict TypeScript, no `any`, named exports, and small scoped changes.
- Prefer maintained upstream publishing integrations. Do not add speculative unofficial platform API calls or claim browser handoff equals automatic publishing.
- Never store credentials, cookies, browser profiles, OAuth tokens, or raw Codex chat logs in tracked files.
- Record account blockers with precise operator instructions in docs/accounts.md.
- Generate content separately from publishing. Approval binds the content revision and target account. Unknown publish outcomes require reconciliation, not automatic resubmission.
- Confirm publication with a remote identifier and platform URL; a queued job or upload alone is not a published post.
- Read docs/architecture.md and docs/acceptance.md before expanding scope.
