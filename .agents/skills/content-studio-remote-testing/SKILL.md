---
name: content-studio-remote-testing
description: Synchronize Content Studio to device k, start its Docker runtime, and verify iteration changes and platform accounts in the owner's Chrome profile. Use for this project's remote testing and migration.
---

# Content Studio testing on k

The owner selected device `k` for subsequent iteration and runtime acceptance on 2026-10-14. The source repository is `https://github.com/wingxking/content-studio`, branch `main`; the remote checkout is `~/x/content-studio`. Authorized ChatGPT Connection access and SSH authentication are separate capabilities: verify the actual execution host and authenticated access before acting. Do not create a separate Codex chat unless requested.

The owner named the SSH identity `k-macmini_key` and requested it for SSH connections to this device. On the source Mac, `~/.ssh/config` selects `~/.ssh/k-macmini_key` for `k`, `k.softshell-court.ts.net` and `100.96.54.32`. Keep the private key local and outside Git/shared notes; install only its public key into the intended remote user's `authorized_keys` through authenticated access. This configuration does not prove the remote installation succeeded or configure other client computers.

Read `AGENTS.md`, `docs/docker-runtime.md`, `docs/acceptance.md` and `docs/accounts.md`. Preserve the source Mac instance until remote restoration and acceptance pass. Keep cloud work gated and test workspaces separate from real content.

## Synchronization and runtime

- On `k`, inspect the checkout's branch, remote and dirty state. Clone the repository when absent; otherwise fetch and pull `main` with `--ff-only`. Preserve unrelated changes; never reset or overwrite private runtime data. Compare the remote checkout SHA with GitHub and the intended source commit.
- Use Docker/Compose and `sh scripts/docker.sh`; host Node, Codex, Supabase CLI, launchd and Keychain are not runtime dependencies. Resolve paths on `k` rather than copying this Mac's absolute paths.
- A Git pull transfers source only. The current installer requires captured Supabase configuration or a verified portable backup; do not claim a fresh clone is runnable without it. Transfer the encrypted backup privately and its key separately. Default restore omits model/delivery authentication and keeps publishing and schedules paused. Do not transfer browser profiles or implicitly use `--restore-private`.
- Restore into a separate private, ignored, non-synced bind root. Follow the supported lifecycle: `restore`, `database`, `migrate`, `build`, `start`, `status`, each with the chosen `--root`. On an existing initialized instance, back up before migration, then migrate/build/start. Never run two schedule owners for the same workspace.
- Verify container health, model readiness and required authentication independently. Run unit/build checks in containers, then HTTP smoke and actual article/video browser flows on `k`. Keep fixture content isolated. Record commit, host, bind root, URL and executed results; distinguish process health, functional acceptance and outstanding time gates.

## Chrome and accounts

- On `k`, create or select a dedicated Chrome profile for `radarxai@gmail.com`. Verify the visible profile and destination account before Google, Supabase or platform login. Existing source-Mac sign-ins are historical evidence, not remote authorization.
- The owner will supply authentication when needed. Keep passwords, recovery codes, OTPs, cookies, OAuth tokens and profile directories out of skills, Git, shared notes and logs. Prefer owner entry in the native sign-in UI. Pause at any required MFA or consent handoff and resume after completion.
- Verify each platform's visible identity and permissions separately. Browser login does not establish API authorization, connector pairing or publishing eligibility. Re-pair an optional draft companion on `k`; establish Linux Codex and YouTube OAuth through the documented container flows when needed.
- Follow current platform policy and revision/account approvals. Do not publish as a test unless explicitly authorized. Confirm drafts in their native editor; public publication requires a remote ID and platform URL. Reconcile unknown outcomes before retrying.
- Record exact blockers and operator steps in `docs/accounts.md`; report remote setup incomplete until it is actually verified.
