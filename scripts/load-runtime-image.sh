#!/bin/sh
# Transfer a reviewed local image through the selected Docker APIs, without a tar copy.
set -eu
project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_context=
target_context=
image=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) source_context=${2:?Provide the source Docker context}; shift 2 ;;
    --target) target_context=${2:?Provide the target Docker context}; shift 2 ;;
    --image) image=${2:?Provide a pinned image}; shift 2 ;;
    *) echo 'Usage: load-runtime-image.sh --source context --target context --image pinned-tag' >&2; exit 1 ;;
  esac
done
case "$source_context:$target_context" in *[!a-zA-Z0-9_.:-]*|:|:*|*:) echo 'Provide exact Docker context names.' >&2; exit 1 ;; esac
case "$image" in ''|*:latest|*[!a-zA-Z0-9_./:@-]*) echo 'Provide a pinned image reference.' >&2; exit 1 ;; esac
[ "$source_context" != "$target_context" ] || { echo 'Source and target contexts must differ.' >&2; exit 1; }
size=$(docker --context "$source_context" image inspect "$image" --format '{{.Size}}')
available_kib=$(df -Pk "$project" | awk 'NR==2 {print $4}')
case "$size:$available_kib" in *[!0-9:]*|:|:*|*:) echo 'Could not verify image size and free disk capacity.' >&2; exit 1 ;; esac
required_kib=$(( (size * 2 + 8589934592 + 1023) / 1024 ))
[ "$available_kib" -ge "$required_kib" ] || { echo 'Image import refused: retain 8 GiB plus twice the uncompressed image size as disk headroom.' >&2; exit 1; }
temporary=$(mktemp -d "${TMPDIR:-/tmp}/studio-image-transfer.XXXXXX")
producer=
probe=content-studio-image-probe-$(basename "$temporary")
cleanup() {
  if [ -n "$producer" ]; then kill "$producer" 2>/dev/null || true; wait "$producer" 2>/dev/null || true; fi
  docker --context "$target_context" rm --force "$probe" >/dev/null 2>&1 || true
  rm -f "$temporary/image.pipe"; rmdir "$temporary"
}
trap cleanup EXIT INT TERM
mkfifo "$temporary/image.pipe"
docker --context "$source_context" save "$image" > "$temporary/image.pipe" &
producer=$!
docker --context "$target_context" load < "$temporary/image.pipe"
wait "$producer"; producer=
docker --context "$target_context" run --rm --name "$probe" --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint /bin/true "$image"
echo 'Pinned runtime image transferred and its root filesystem started; source image and volumes retained.'
