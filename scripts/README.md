# Local runtime operations

Use the repository's verified Node, Supabase CLI and Docker Desktop versions. Cloud login or linking is unnecessary.

```sh
node scripts/local.mjs setup
npm run build
node scripts/local.mjs start
node scripts/local.mjs status
node scripts/local.mjs backup
node scripts/local.mjs upgrade
node scripts/local.mjs stop
```

Setup starts `content-studio-local` on loopback API 55421, DB 55422 and Mailpit 55424. A project-scoped private Unix-socket adapter injects explicit loopback port bindings before the CLI creates containers; existing bindings are also inspected and repaired without removing named data volumes. Optional Studio/Realtime/analytics are disabled for the initial resource budget; Studio port 55423 is reserved. The official GHCR mirror is selected for the exact CLI-pinned image versions because ECR and Docker Hub returned service errors on this machine. It applies incremental migrations, imports an absent workspace from the preserved legacy file with publishing paused, checks Auth, verifies private Storage bytes, verifies queue send/read and waits for an actual cron execution. Credentials remain in ignored `.studio/runtime.env` (0600). Re-running setup preserves an existing workspace and pauses publishing.

Start registers only the project's API/Worker launchd jobs and refuses to replace another process on port 4310. It waits up to 60 seconds for the production homepage, database-backed API status and a fresh live worker readiness marker before reporting success. Build the production UI first. Stop unloads those jobs and stops only this local Supabase project, retaining its volumes. It does not stop Docker Desktop or unrelated projects. The Mac must remain awake and connected for scheduled external work.

Backup rejects an unmanaged API still occupying port 4310, stops managed application processes, pauses publishing and owned cron jobs through `cron.alter_job`, and saves a complete database dump, application data, actual Storage bytes, legacy media, content/run artifacts and integrity manifest in a private directory. Verify the backup before restarting. Private YouTube credentials/upload journals and ops files are encrypted separately; `.studio/backup.key` stays outside the backup. Preserve that key separately through a secure process if restoring credentials is required. Credentials are never printed.

```sh
node scripts/local.mjs restore .studio/backups/<backup> --target .studio/restore-instances/<new-name>
```

Restore refuses an existing target. It creates an independent project/ports/volumes using the recorded migrations, disables owned cron before replaying application rows, restores Storage bytes, legacy media and content/run artifacts, and verifies counts and hashes. Publishing and cron stay paused. It does not launch API/Worker or copy pgmq deliveries or active leases. Unfinished runs/operations are marked for explicit recovery. It writes relocation metadata for read-only media path mapping without editing approved snapshots. This single-owner restoration uses fresh local Auth services; the complete database dump remains available for forensic/full-service recovery. Default restore preserves private 0600 upload-journal presence markers containing only job IDs and a restore flag, so omitted private sessions cannot appear unsent. Private credentials and full journals require explicit `--restore-private` and the separate encryption key; reauthorize and reconcile existing submissions before considering another upload. Older backups with encrypted private state but no journal inventory require explicit private restoration. Restoring the database cannot undo remote publication. Inspect pending and unknown external submissions before resuming.

Upgrade makes a backup before applying incremental local migrations. It never calls `db reset` or `stop --no-backup`. Keep disposable test instances separate from real local content. Cloud deployment and production identity/configuration are a later phase.
