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

## Executed k baseline and original adapter boundary

Key authentication to `k@k.softshell-court.ts.net` and Docker runtime execution were verified on 2026-10-14. The accepted checkout path resolves to `/Users/k/x/content-studio`. Noninteractive SSH may omit Docker from PATH; prepend `$HOME/.docker/bin:/Applications/Docker.app/Contents/Resources/bin` for lifecycle commands. Use the existing isolated root `/Users/k/x/content-studio/.docker-k-acceptance`, project `content-studio-k-test`, web port 4310, Supabase 56421, database 56422 and companion 19527. Recheck health and source SHA each run; a past check is not current state.

The owner explicitly chose **original implementation only** for the BeeCMS-inspired plan. Do not copy private BeeCMS adapters or its login state. The new optional Python/Playwright fixture executor and finance presets are original code. Live finance platforms stay disabled until a separately authorized and reviewed workflow passes acceptance. Chromium image transport is an actual compatibility blocker; unit fixtures cannot replace the explicit Docker browser smoke. See `docs/beecms-iteration-2026-10-14.md` for phase boundaries.

Google sign-in on k was reported complete by the owner; it still needs an independent visible profile/target check before account work. Default restore intentionally excluded Linux Codex and delivery authentication. Keep model login and platform API authorization separate from Chrome login. Never retain supplied authentication material.

Before backup/restore acceptance, remove only test-created download artifacts and keep fixture workspaces identifiable. Preserve encrypted minimum browser attempt journals even when restoring without account authorization; restored leases expire, unresolved submission barriers remain, and metric polling stays stopped. Do not restart schedules or publish queues merely because tests passed.
