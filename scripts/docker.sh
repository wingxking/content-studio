#!/bin/sh
set -eu
STUDIO_PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "${1:-}" = knowledge-build ]; then
  STUDIO_AVAILABLE_KIB=$(df -Pk "$STUDIO_PROJECT_DIR" | awk 'NR==2 {print $4}')
  case "$STUDIO_AVAILABLE_KIB" in ''|*[!0-9]*) echo 'Could not verify host disk capacity.' >&2; exit 1 ;; esac
  [ "$STUDIO_AVAILABLE_KIB" -ge 15728640 ] || { echo 'Knowledge image build requires at least 15 GiB free on the host project filesystem.' >&2; exit 1; }
fi
STUDIO_BIND_ROOT=${STUDIO_DOCKER_ROOT:-"$STUDIO_PROJECT_DIR/.docker"}
STUDIO_BACKUP_ROOT=${STUDIO_BACKUP_ROOT:-"$STUDIO_PROJECT_DIR/.docker-backups"}
STUDIO_SOURCE_MOUNT=
STUDIO_KEY_MOUNT=
STUDIO_CLIENT_MOUNT=
STUDIO_DATA_SOURCE_MOUNT=
STUDIO_KNOWLEDGE_SOURCE_MOUNT=
STUDIO_TARGET_PARENT=
previous=
for argument in "$@"; do
  case "$previous" in
    --root) STUDIO_BIND_ROOT=$argument ;;
    --source) STUDIO_SOURCE_MOUNT=$argument ;;
    --key-file) STUDIO_KEY_MOUNT=$argument ;;
    --client-file) STUDIO_CLIENT_MOUNT=$argument ;;
    --data-source) STUDIO_DATA_SOURCE_MOUNT=$argument ;;
    --knowledge-source) STUDIO_KNOWLEDGE_SOURCE_MOUNT=$argument ;;
    --target) STUDIO_TARGET_PARENT=$(dirname -- "$argument") ;;
  esac
  previous=$argument
done
mkdir -p "$STUDIO_BIND_ROOT" "$STUDIO_BACKUP_ROOT"
STUDIO_BIND_ROOT=$(CDPATH= cd -- "$STUDIO_BIND_ROOT" && pwd)
STUDIO_BACKUP_ROOT=$(CDPATH= cd -- "$STUDIO_BACKUP_ROOT" && pwd)
# Reuse only an operations image containing this exact lifecycle source. Routine
# backup/start must also work when an upstream build registry is unavailable.
if ! docker run --rm --pull never --network none --entrypoint node --mount "type=bind,src=$STUDIO_PROJECT_DIR/scripts/docker.mjs,dst=/workspace/docker.mjs,readonly" content-studio-operations:local -e "const fs=require('node:fs');process.exit(fs.readFileSync('/opt/content-studio/docker.mjs').equals(fs.readFileSync('/workspace/docker.mjs'))?0:1)" >/dev/null 2>&1; then
  docker build --quiet --target operations -t content-studio-operations:local -f "$STUDIO_PROJECT_DIR/infra/Dockerfile" "$STUDIO_PROJECT_DIR" >/dev/null
fi
if [ -n "$STUDIO_TARGET_PARENT" ]; then
  mkdir -p "$STUDIO_TARGET_PARENT"
  STUDIO_TARGET_PARENT=$(CDPATH= cd -- "$STUDIO_TARGET_PARENT" && pwd)
fi
if [ -n "$STUDIO_SOURCE_MOUNT" ]; then
  STUDIO_SOURCE_MOUNT=$(CDPATH= cd -- "$STUDIO_SOURCE_MOUNT" && pwd)
fi
if [ -n "$STUDIO_DATA_SOURCE_MOUNT" ]; then
  STUDIO_DATA_SOURCE_MOUNT=$(CDPATH= cd -- "$STUDIO_DATA_SOURCE_MOUNT" && pwd)
fi
if [ -n "$STUDIO_KNOWLEDGE_SOURCE_MOUNT" ]; then
  STUDIO_KNOWLEDGE_SOURCE_MOUNT=$(CDPATH= cd -- "$STUDIO_KNOWLEDGE_SOURCE_MOUNT" && pwd)
fi
if [ -n "$STUDIO_KEY_MOUNT" ]; then
  STUDIO_KEY_MOUNT=$(CDPATH= cd -- "$(dirname -- "$STUDIO_KEY_MOUNT")" && pwd)/$(basename -- "$STUDIO_KEY_MOUNT")
fi
if [ -n "$STUDIO_CLIENT_MOUNT" ]; then
  STUDIO_CLIENT_MOUNT=$(CDPATH= cd -- "$(dirname -- "$STUDIO_CLIENT_MOUNT")" && pwd)/$(basename -- "$STUDIO_CLIENT_MOUNT")
fi
# Writable lifecycle destinations take priority; each exact destination is mounted once.
set -- content-studio-operations:local "$@"
STUDIO_MOUNT_DESTINATIONS='|'
for STUDIO_MOUNT_ENTRY in "rw:$STUDIO_BIND_ROOT" "rw:$STUDIO_BACKUP_ROOT" "rw:$STUDIO_TARGET_PARENT" "ro:$STUDIO_PROJECT_DIR" "ro:$STUDIO_SOURCE_MOUNT" "ro:$STUDIO_DATA_SOURCE_MOUNT" "ro:$STUDIO_KEY_MOUNT" "ro:$STUDIO_CLIENT_MOUNT" "ro:$STUDIO_KNOWLEDGE_SOURCE_MOUNT"; do
  STUDIO_MOUNT_MODE=${STUDIO_MOUNT_ENTRY%%:*}
  STUDIO_MOUNT_PATH=${STUDIO_MOUNT_ENTRY#*:}
  [ -n "$STUDIO_MOUNT_PATH" ] || continue
  case "$STUDIO_MOUNT_DESTINATIONS" in *"|$STUDIO_MOUNT_PATH|"*) continue ;; esac
  STUDIO_MOUNT_DESTINATIONS="$STUDIO_MOUNT_DESTINATIONS$STUDIO_MOUNT_PATH|"
  STUDIO_MOUNT_SPEC="type=bind,src=$STUDIO_MOUNT_PATH,dst=$STUDIO_MOUNT_PATH"
  if [ "$STUDIO_MOUNT_MODE" = ro ]; then STUDIO_MOUNT_SPEC="$STUDIO_MOUNT_SPEC,readonly"; fi
  set -- --mount "$STUDIO_MOUNT_SPEC" "$@"
done
docker run --rm --workdir "$STUDIO_PROJECT_DIR" --user 0:0 -e "STUDIO_HOST_UID=$(id -u)" -e "STUDIO_HOST_GID=$(id -g)" -e "STUDIO_PROJECT_DIR=$STUDIO_PROJECT_DIR" -e "STUDIO_DOCKER_ROOT=$STUDIO_BIND_ROOT" -e STUDIO_PYPI_MIRROR -e STUDIO_APT_ORIGIN --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock "$@"
