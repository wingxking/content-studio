# Content Studio

A portable local content workbench with sourced articles, independent video projects, durable operations and recoverable publication records. Supabase, API, role workers, Linux Codex, CPU TTS and renderer run in Docker Compose with private bind-mounted files. Cloud deployment remains a later phase.

## Run the Docker installation

See [Docker operation and acceptance](docs/docker-runtime.md). Existing installations can be captured once after a verified backup. Portable logical backups can then restore on another computer without host Node, Codex, Supabase CLI or macOS services. A clean installer without an existing private Supabase configuration is not yet provided.

```sh
sh scripts/docker.sh restore --source /absolute/private-backup --root /absolute/new-data-root
sh scripts/docker.sh database --root /absolute/new-data-root
sh scripts/docker.sh migrate --root /absolute/new-data-root
sh scripts/docker.sh build --root /absolute/new-data-root
sh scripts/docker.sh start --root /absolute/new-data-root
sh scripts/docker.sh status --root /absolute/new-data-root
```

The restored Web port defaults to **http://127.0.0.1:15310**; ports and UID/GID are configurable. Use Chrome profile `radarxai@gmail.com` for this owner's account acceptance. New computers authenticate their own Linux Codex container once. Process health and authenticated model readiness are distinct. Services continue independently of the browser while Docker runs.

The former `npm run local:*` commands are legacy Mac migration/recovery tooling. Keep the old instance intact until isolated migration passes.

## Web workflow

1. Create a **content** or **discovery** task. Enter title, instructions, optional audience/angle/source material, model, reference images and target platforms.
2. Select **once**, **daily**, or **weekly** in the same task. Change frequency later without recreating the task. Save or run immediately.
3. Discovery produces zero to twenty sourced questions. Choose one and refine its creation brief. The system does not claim a verified global “number-one” trend.
4. Content generation saves the master checkpoint first, then each platform draft. Completed stages and local files remain available if a later stage fails. Retry continues the same run.
5. Edit the master or an individual platform draft. A master edit schedules adaptation; independent platform fields are preserved and conflicts are shown. Web Codex refinement creates a reviewable proposal that can be accepted or rejected.
6. Upload/reuse assets. Reference images are actually passed to Codex. Publishing attachments are selected separately.
7. For a video, explicitly create a separate script, edit it, then explicitly render. The renderer uses reviewed footage, CPU Kokoro narration, MoneyPrinterTurbo stages and readable captions to produce an MP4. Choosing a video platform alone never renders a video.
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
- Immutable LocalFS media selected by stable asset IDs. Historical Storage objects remain readable during migration; alias resolution preserves historic paths and approval hashes.

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

Docker/Compose and the private repository/config/data root are the deployed host requirements. Images include Node, Linux Codex, FFmpeg/ffprobe, librsvg, CPU TTS and renderer. Cloud implementation, production Web OAuth and multi-user authorization remain stage two.
