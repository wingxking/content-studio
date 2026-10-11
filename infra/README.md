# Docker runtime

The host needs Docker Engine with Compose v2 and a POSIX shell. `scripts/docker.sh` builds and runs the lifecycle utility in a small Docker image; no host Node, Codex, Supabase CLI, ffmpeg, or launchd is required.

The initial same-image local cutover copies a **stopped** Content Studio Supabase volume into a new bind root. It retains the original containers and volumes. The six Supabase services use the source's pinned images and privately captured configuration, preserving Auth, Storage, extension versions, roles and JWT configuration. It is not a fresh generic Supabase installer.

```sh
scripts/docker.sh capture --root .docker --source-project content-studio-local --port 14310
scripts/docker.sh database
scripts/docker.sh migrate
scripts/docker.sh build
scripts/docker.sh start
scripts/docker.sh status
scripts/docker.sh backup
scripts/docker.sh restore --source .docker-backups/BACKUP_DIRECTORY --root .docker-restored --port 15310
```

`capture` requires source containers to be stopped after a verified backup. It refuses a nonempty destination. `database` and `migrate` leave all workspaces and owned Cron schedules paused. Restore creates a fresh database and restores a full logical dump and roles; it does not copy raw PGDATA between machines or architectures. Both capture and restore keep application services stopped until explicitly started. A backup stops writers, pauses scheduling, dumps the full database and roles, stops services, and hashes the media, aliases, upload receipts, revisions, private delivery state and service configuration. Private backups must be kept outside synced/public folders.

`STUDIO_DOCKER_ROOT` configures host binds. `.docker/config/compose.env` controls the Compose project, UID/GID and loopback web/Supabase/database ports. Container paths are consistently `/data`; original literal media references remain in database revisions and resolve using relocation mappings or verified LocalFS aliases. New selections use `studio-asset:<UUID>` references. Default deployment ports are isolated from the old baseline.

Application, renderer, Codex and TTS image manifests support ARM64 and AMD64. Execution acceptance on a second architecture remains a separate check. Node and CPU TTS images are pinned by manifest digest; Codex is pinned to `0.162.1`, and the renderer pins its upstream source hash. The model container receives only its dedicated authentication/cache mounts. The delivery worker alone receives the private YouTube/Google directories. Renderer sees prepared video inputs read-only and writes only its output subtree. TTS seeds and verifies its separate model/voice cache.

Container health confirms process availability. Model `/readyz` separately checks Codex authorization; completion of a model job and rendered CPU video must be checked separately before enabling scheduling. No live publication is needed for migration acceptance.

Portable backups encrypt the complete logical database dump, database roles, Supabase configuration, Codex authentication/cache, and delivery credentials/journals with AES-256-GCM. The separate 32-byte key defaults to `<bind-root>/backup.key`; transfer it through a separate private channel and supply `--key-file` during restore. The key is never included in the backup. Public media, receipts, aliases and renderer/TTS caches remain ordinary hashed files. The manifest inventories ciphertext hashes and contains only journal IDs, not session URLs or credentials.

```sh
scripts/docker.sh backup --target /private/backup-location/studio-transfer
scripts/docker.sh restore --source /private/backup-location/studio-transfer \
  --key-file /private/key-location/studio-backup.key --root .docker-restored \
  --port 15310 --supabase-port 57421 --database-port 57422
```

By default, restore omits Codex authentication/cache and delivery credentials/journal contents. It creates UUID-only protected upload markers in both delivery storage and the shared publication journal catalog. These markers prevent a restored job from starting another upload; the delivery worker requires explicit private journal restoration and reconciliation. Add `--restore-private` only when intentionally transferring those credentials and journals. Supabase credentials and roles are necessary for the restored local database and are restored from their encrypted files.

Restore retains revision content and approval paths. It preserves completed operation/task history and checkpoints, clears all engine leases, archives pending `studio_jobs` messages, and marks only interrupted work as failed with an explicit operator retry message. Submitting publications become `needs_reconciliation` without changing job IDs or approved snapshots. Cron and publication remain paused. The Supabase GraphQL wrapper and pgmq extension-owned queue tables are exported separately because PostgreSQL's normal extension dump omits them; their exact function grants and queue/archive history are restored before quarantine. No application worker starts during restore.
