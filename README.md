# Content Studio

A local content workbench for one Mac and Codex. The Web UI manages reusable creation/discovery tasks, one-time/daily/weekly execution, sourced master drafts, platform adaptations, assets, independent video projects, and publication receipts.

Cloud deployment remains a later phase. Local installation still needs network access for Codex models, public sources, and authorized platform APIs.

The latest requested upgrade is [local Docker with independent article/video pipelines](docs/docker-dual-pipeline-architecture.zh-CN.md): bind-mounted local files, separate workspaces/workers, and selectively reused upstream components. This is the target design and migration plan. The startup, storage and runtime descriptions below document the existing baseline; the new Docker/LocalFS/pg-boss/video stack has not yet been implemented or accepted.

## Start locally

```sh
npm ci
npm run local:setup
npm run build
npm run local:start
npm run local:status
```

Open **http://127.0.0.1:4310** in **Chrome profile `radarxai@gmail.com`**. Setup uses the existing Docker Desktop and Supabase CLI. First installation downloads the pinned Supabase images and can take considerable time. The local stack has its own project ID, ports, network and persistent volumes; no hosted Supabase project is required.

The API and a separate worker run under macOS `launchd`. Closing the browser or Codex chat does not stop a task. The Mac must be awake and Docker available; missed recurring schedules resume at the most recent eligible occurrence, without replaying an unlimited backlog. A once task with no date is manual-only. “Save and run” consumes a once task's scheduled occurrence.

The application discovers the installed Codex model catalog and prefers the official desktop-bundled Codex executable. It uses existing local Codex sign-in. Authentication/model availability is confirmed by a real successful run, not just finding an executable.

## Web workflow

1. Create a **content** or **discovery** task. Enter title, instructions, optional audience/angle/source material, model, reference images and target platforms.
2. Select **once**, **daily**, or **weekly** in the same task. Change frequency later without recreating the task. Save or run immediately.
3. Discovery produces zero to twenty sourced questions. Choose one and refine its creation brief. The system does not claim a verified global “number-one” trend.
4. Content generation saves the master checkpoint first, then each platform draft. Completed stages and local files remain available if a later stage fails. Retry continues the same run.
5. Edit the master or an individual platform draft. A master edit schedules adaptation; independent platform fields are preserved and conflicts are shown. Web Codex refinement creates a reviewable proposal that can be accepted or rejected.
6. Upload/reuse assets. Reference images are actually passed to Codex. Publishing attachments are selected separately.
7. For a video, explicitly create a separate script, edit it, then explicitly render. The renderer uses selected images, readable text cards and macOS narration to produce an MP4. Choosing a video platform alone never renders a video.
8. Select actual accounts and click **authorize and publish this revision**. Supported authorized APIs run in the worker; other destinations show a native portal, copy buttons, downloads and numbered instructions. Record the actual platform URL and ID after native publication.
9. Continue failed/unfinished deliveries from their existing records. A remote outcome that is unknown is reconciled before any retry. Uploaded private/unlisted YouTube videos are distinguished from public publication.

## Publishing capabilities

- **YouTube:** existing Desktop OAuth, exact channel verification, durable resumable-upload journal, and official API readback. Web publishing requires a real attached MP4 and explicit visibility/disclosure settings. Browser sign-in alone is not API authorization.
- **Postiz:** configured and authorized X/LinkedIn text integrations only. Trend-derived X automation is blocked.
- **X trends, Xiaohongshu, Reddit and other native paths:** owner completes the permitted creator workflow. The app provides content, media and precise handoff steps; it does not claim that a handoff is automatic publication. Reddit automated access needs the platform's required App approval.

Existing live-publication evidence is retained in [acceptance](docs/acceptance.md) and the [previous YouTube run](docs/ai-agent-education-run-2026-10-10.zh-CN.md). It is separate from the current local-system validation. No public test post is implied by starting the server, running content generation or approving an editorial proposal.

## Data and recovery

Supabase Postgres is the local database, with private Supabase Storage, `pg_cron` scheduling and a durable `pgmq` queue. Tasks, runs, revision records, operations, assets and video projects have dedicated tables. The existing draft/account/publication aggregate retains its optimistic CAS contract during this migration; it is not yet a fully normalized multi-tenant cloud model.

Ignored `.studio/` holds runtime configuration, local content exports, cached/generated media, restricted OAuth files and upload journals. New files include:

- `content/<draft-id>/master.md`, platform `.md` files, source material and immutable `revision-N/` snapshots.
- `runs/<run-id>/master.md`, platform `.md` files and a structured run package, including partial completed work.
- Local media and its private Storage copy, linked through stable asset IDs for new selections.

Never commit `.studio/`, credentials, raw Codex logs, cookies or browser profiles. The Web browser never receives the Supabase service-role key.

```sh
npm run local:backup
npm run local:restore -- /absolute/backup-folder --target /new/isolated-folder
npm run local:upgrade
npm run local:stop
```

Backup stops this project's application services and pauses publishing/schedulers. It includes database data, actual Storage bytes, local artifact files, integrity checks and separately encrypted private journals. The private recovery key stays outside the backup; preserve it securely. Restore targets a new isolated stack, defaults to paused, and never replays active queue rows or repeats an uncertain remote upload. Use `--restore-private` only when restoring the locally encrypted authorization/journal bundle is intended. After inspecting a backup/upgrade, restart with `local:start`; resume publishing explicitly from the Web queue when appropriate.

## Verify and architecture

```sh
npm run typecheck
npm test
npm run build
npm run test:http
node --import tsx tests/task-database-smoke.ts
```

The database smoke test requires the running local stack and uses a disposable workspace. Tests, a built page, account registration and successful publication are separate evidence categories. See [local implementation and validation](docs/local-system-delivery.zh-CN.md) for current results.

- [Local-first build baseline and cloud migration plan](docs/local-first-build-review.zh-CN.md)
- [Web product design](docs/web-product-design.zh-CN.md)
- [Technical architecture](docs/web-technical-architecture.zh-CN.md)
- [Platform policies](docs/platform-policies-v2.zh-CN.md)
- [Account setup and blockers](docs/accounts.md)

Node.js 24+, Docker Desktop, Supabase CLI and authenticated Codex are required. Video rendering also needs FFmpeg/ffprobe, librsvg and macOS `say`. Cloud implementation, production Web OAuth, multi-user authorization and replacing the Mac/Codex adapters remain stage two.
