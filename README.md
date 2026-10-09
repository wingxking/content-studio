# Content Studio

A local content production workbench for one Mac and Codex. Generate sourced articles and platform versions, review them, make image cards or narrated videos, then track deliveries and measured performance.

Stage one is implemented locally; live multi-platform acceptance is still pending account access and publishing permissions. Stage two has not started.

## Run

```sh
npm ci
npm run doctor
npm run dev
```

Open http://127.0.0.1:4310 in **Chrome profile `radarxai@gmail.com`**. The server listens only on loopback. Keep it running and the Mac awake for the 30-second queue dispatcher. Stopping the server or sleeping the Mac pauses execution; due work is processed when it resumes.

Use your existing local Codex authentication. The app detects the official desktop-bundled executable, avoiding a broken `codex` PATH shortcut found on this Mac. You can override its executable with `CODEX_BIN`. It does not copy authentication tokens or require an OpenAI API key for stage one.

## What works

- Sourced brief → real Codex structured generation → master article and platform variants.
- Versioned editing and approval tied to content and actual media hashes.
- PNG card rendering with librsvg; actual narrated MP4 rendering with FFmpeg and macOS speech.
- Account metadata for 12 channels, target-specific scheduling, durable state, pause, duplicate prevention, and crash recovery.
- Documented Postiz API adapter for **X and LinkedIn text** when authorized integrations and an API key are configured.
- Native browser packages for other channels, with explicit operator handoff and checked post-ID/URL receipts.
- Performance snapshots from measured account analytics.
- Optional **Supabase** persistence; no other database dependency.

The native route prepares content and records publication evidence. It needs Codex Computer Use or the operator to perform the platform's creator flow; it is not an unattended website uploader. Postiz API acceptance is recorded as queued until status reconciliation returns a matching platform link. Neither route has yet passed live publication acceptance for this user's accounts.

## Production workflow

1. Research a topic using official sources or your own original experiment. Enter the relevant source excerpts in the brief.
2. Generate or import the content package; review each platform's content and facts.
3. Approve the text; make media or attach your own files. Review the complete assets and approve the new revision.
4. Check the intended account in the requested Chrome profile. Store safe metadata and the current blocker in Channels & accounts.
5. Schedule an approved variant to that account. The queue submits configured API jobs and prepares native handoffs.
6. Open/download the native package, use Codex Computer Use in Chrome, and verify the resulting post against the account's content list. Record its ID and URL.
7. Record actual analytics later. Unavailable metrics remain null.

## Codex commands

```sh
npm run studio -- generate config/first-brief.json
npm run studio -- status
npm run studio -- approve <draft-id>
npm run studio -- media <draft-id> youtube
npm run studio -- approve <draft-id>
npm run studio -- account <account.json>
npm run studio -- schedule <schedule.json>
npm run studio -- run
npm run studio -- export <job-id> /private/tmp/publishing-package
npm run studio -- receipt <job-id> <actual-platform-url> <actual-post-id>
npm run studio -- pause
```

`config/content.schema.json` describes an import package. Angle/audience/source data are required; there is no fabricated sample content or default account that can accidentally be published.

## Dependencies and data

Node.js 24+, npm, authenticated Codex CLI. Media generation needs `rsvg-convert`, `ffmpeg`, `ffprobe`, and macOS `say`, which were found on this Mac. A particular speech voice may need installation through macOS if unavailable. `STUDIO_TTS_VOICE` selects an installed voice.

Local mode stores single-operator workspace artifacts in ignored `.studio/`: `state.json` and media. This is the local workspace mode, not a multi-tenant database. For database persistence, apply the Supabase migration and export `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and a UUID `STUDIO_WORKSPACE_ID` together. The server performs optimistic revision checks; the browser never receives the secret key. Migration application and remote Supabase persistence have not been live-verified. See [architecture](docs/architecture.md).

For Postiz, export `POSTIZ_API_KEY` and optionally `POSTIZ_BASE_URL`. Account credentials stay in Postiz or the native platform session. Do not put secrets, cookies, or browser profiles in tracked files.

## Verify

```sh
npm run typecheck
npm test
npm run build
```

See [research](docs/research.md), [accounts and access](docs/accounts.md), [architecture](docs/architecture.md), and [acceptance](docs/acceptance.md). Account registration, app review, public publishing, and stage-two independence must each be verified separately.
