# Content Studio

A local content production workbench for one Mac and Codex. Generate sourced articles and platform versions, review them, make image cards or narrated videos, then track deliveries and measured performance.

The local generation, review, media, and delivery-coordination foundation is implemented. Official regional trend RSS collection and an explicit official YouTube API uploader are implemented. Two reviewed videos were submitted once each through official YouTube OAuth/API. The first was subsequently withdrawn to Private at the owner’s request; the replacement AI-agent education video is public/processed and listed on the correct channel. Independent factual research and broader multi-platform acceptance remain unfinished. Stage one has not passed overall acceptance; stage two has not started. See [current progress and architecture in Chinese](docs/progress-and-architecture.zh-CN.md).

## Run

```sh
npm ci
npm run doctor
npm run dev
```

Open http://127.0.0.1:4310 in **Chrome profile `radarxai@gmail.com`**. The server listens only on loopback. Keep it running and the Mac awake for the 30-second queue dispatcher. Stopping the server or sleeping the Mac pauses execution; due work is processed when it resumes.

Use your existing local Codex authentication. The app detects the official desktop-bundled executable, avoiding a broken `codex` PATH shortcut found on this Mac. You can override its executable with `CODEX_BIN`. It does not copy authentication tokens or require an OpenAI API key for stage one.

## What works

- Official Google Trends RSS discovery for US, IN, GB and ZA; time-stamped regional candidates and unverified news references.
- Sourced brief → real Codex structured generation → master article and platform variants.
- Versioned editing and approval tied to content and actual media hashes.
- PNG card rendering with librsvg; actual narrated MP4 rendering with FFmpeg and macOS speech.
- Account metadata for 12 channels, target-specific scheduling, durable state, pause, duplicate prevention, and crash recovery.
- Documented Postiz API adapter for **X and LinkedIn text** when authorized integrations and an API key are configured.
- Official YouTube Desktop OAuth, channel verification, resumable upload journal and API status readback through explicit CLI commands; two real submissions on the verified RadarXAI channel; the old topic is now Private and the new education video is public.
- Native packages for other channels, with genuine human handoff where automation is prohibited and checked post-ID/URL receipts.
- X trend-derived content is blocked from automatic Postiz delivery at scheduling and final dispatch.
- Manually entered performance snapshots from measured account analytics.
- Optional **Supabase** persistence; no other database dependency.

`discover` automatically collects regional RSS candidates and related news URLs, preserving the observation time, feed date and separate traffic buckets. It never claims a global number-one trend or converts RSS headlines into verified facts. A researcher must independently verify the event and enter source excerpts before generation; the generator does not browse. Competitor analysis and automatic analytics remain unfinished.

The native route prepares content and records publication evidence. Review each platform's authorization and content eligibility before any creator-page operation. X trend posts require genuine human publication; Reddit agent access requires an approved App. Do not use Codex clicks or headless browsers to bypass those requirements. The explicit YouTube CLI uses authorized Data API OAuth, not Chrome cookies; its background queue does not automatically invoke uploads. The current [AI-agent education video](https://www.youtube.com/watch?v=X8dDltMseM4) is confirmed public/processed by the API and Public/Published in the intended Studio Shorts list. Its signed-in player reached 36/46 seconds; full playback and subjective quality acceptance remain separate. The former video aKaJ3qBAhCc is confirmed Private after Studio Save and official API readback. X, Reddit and Xiaohongshu remain unsubmitted; see the [replacement publication record](docs/ai-agent-education-run-2026-10-10.zh-CN.md).

## Planned Web workflow upgrade

The new design covers promptable discovery schedules, up to 20 sourced questions per run, a versioned master with independently editable platform adaptations, Web AI instructions with safe merges, a reusable asset library, explicitly created video drafts, and historical publishing snapshots. These new workflow features are planned, not implemented. The local Web Research & setup page links to all three documents:

- [Web product design and phased acceptance](docs/web-product-design.zh-CN.md)
- [Local and production technical architecture](docs/web-technical-architecture.zh-CN.md)
- [Current official product research](docs/research-web-workflows-2026-10-10.zh-CN.md)

## Production workflow

1. Run regional discovery, select a candidate and independently research primary/independent sources, or use your own original experiment. Enter the relevant source excerpts in the brief.
2. Generate or import the content package; review each platform's content and facts.
3. Approve the text; make media or attach your own files. Review the complete assets and approve the new revision.
4. Check the intended account in the requested Chrome profile. Store safe metadata and the current blocker in Channels & accounts.
5. Schedule an approved variant to that account. The queue submits configured API jobs and prepares native handoffs.
6. For authorized YouTube jobs, explicitly invoke the official uploader and reconcile its existing session/video. For other destinations, follow the recorded permitted route; genuinely human publication is required where policy prohibits automation. Verify the actual ID, account, URL and public visibility.
7. Record actual analytics later. Unavailable metrics remain null.

## Codex commands

```sh
npm run studio -- discover US,IN,GB,ZA 24
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
# After Google Cloud setup and an explicit OAuth grant:
npm run studio -- youtube-auth /absolute/path/to/desktop-client.json
npm run studio -- youtube-channel
npm run studio -- youtube-upload <job-id> config/youtube-upload-settings.json
npm run studio -- youtube-reconcile <job-id>
```

`config/content.schema.json` describes an import package. Angle/audience/source data are required; there is no fabricated sample content or default account that can accidentally be published.

## Dependencies and data

Node.js 24+, npm, authenticated Codex CLI. Media generation needs `rsvg-convert`, `ffmpeg`, `ffprobe`, and macOS `say`, which were found on this Mac. A particular speech voice may need installation through macOS if unavailable. `STUDIO_TTS_VOICE` selects an installed voice.

Local mode stores single-operator artifacts in ignored `.studio/`: state, discovery snapshots, media, private YouTube credentials and upload journals. Credential/journal files use mode 0600 and private directories 0700. Never track this directory or share session URLs. This is the local workspace mode, not a multi-tenant database. For database persistence, apply the Supabase migration and export `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and a UUID `STUDIO_WORKSPACE_ID` together. The server performs optimistic revision checks; the browser never receives the secret key. Migration application and remote Supabase persistence have not been live-verified. See [architecture](docs/architecture.md).

For Postiz, export `POSTIZ_API_KEY` and optionally `POSTIZ_BASE_URL`. Account credentials stay in Postiz or the native platform session. Do not put secrets, cookies, or browser profiles in tracked files.

## Verify

```sh
npm run typecheck
npm test
npm run build
# With the local server running:
npm run test:http
```

See [latest independent research](docs/research-industry-v2.zh-CN.md), [current platform policies](docs/platform-policies-v2.zh-CN.md), [current news evidence](docs/news-topic-2026-10-10.zh-CN.md), [research](docs/research.md), [accounts and access](docs/accounts.md), [architecture](docs/architecture.md), and [acceptance](docs/acceptance.md). Account registration, app review, public publishing, and stage-two independence must each be verified separately.
