#!/bin/sh
# Kubernetes is a deployment adapter; Supabase and the backup format remain Compose-owned.
set -eu
project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
action=${1:-status}
[ "$#" -eq 0 ] || shift
root=${STUDIO_DOCKER_ROOT:-$project/.docker}
namespace=content-studio-k8s
source_context=${STUDIO_SOURCE_DOCKER_CONTEXT:-orbstack}
context=orbstack
evidence=
backup=
allow_unready_model=false
previous=
for argument in "$@"; do
  [ "$argument" != '--allow-unready-model' ] || allow_unready_model=true
  case "$previous" in
    --root) root=$argument ;;
    --namespace) namespace=$argument ;;
    --context) context=$argument ;;
    --docker-context) source_context=$argument ;;
    --evidence) evidence=$argument ;;
    --backup|--source|--target) backup=$argument ;;
  esac
  previous=$argument
done
case "$root" in /*) ;; *) echo 'Use an absolute private bind root.' >&2; exit 1 ;; esac
case "$namespace" in *[!a-z0-9-]*|'') echo 'Invalid namespace.' >&2; exit 1 ;; esac
private=$root/config/kubernetes/$namespace
ops_image=content-studio-operations:local
# An older stop must never scale down or hide a newly started release. Keep one
# host-shell owner for every mutation of this root, including candidate files.
# This ephemeral owner stays outside every portable-backup tree so a restore
# cannot inherit a lock belonging to another host or a finished backup.
lifecycle_lock=$root/.kubernetes-lifecycle-lock
lifecycle_owner=
restore_context_needed=false
old_context=
restore_context() {
  [ "$restore_context_needed" = true ] || return 0
  if [ -n "$old_context" ]; then kubectl config use-context "$old_context" >/dev/null; else kubectl config unset current-context >/dev/null 2>&1 || true; fi
  restore_context_needed=false
}
finish_lifecycle() {
  lifecycle_result=$?
  trap - EXIT INT TERM
  restore_context || true
  # A replacement lock has a different random owner file. Never remove it.
  if [ -n "$lifecycle_owner" ] && [ -f "$lifecycle_owner" ]; then
    rm -f "$lifecycle_owner"
    rmdir "$lifecycle_lock" 2>/dev/null || true
  fi
  exit "$lifecycle_result"
}
lock_lifecycle() {
  umask 077
  mkdir -p "$root"
  if ! mkdir "$lifecycle_lock" 2>/dev/null; then
    owner_description='initializing or interrupted operation'
    for owner_file in "$lifecycle_lock"/owner.*; do
      [ -f "$owner_file" ] || continue
      owner_pid=unknown; owner_action=unknown; owner_namespace=unknown
      { IFS= read -r owner_pid; IFS= read -r owner_action; IFS= read -r owner_namespace; } < "$owner_file" || true
      owner_description="$owner_action in $owner_namespace (PID $owner_pid)"
      break
    done
    printf 'Another Kubernetes lifecycle operation owns this root: %s. Wait for it to finish; status remains available.\n' "$owner_description" >&2
    printf 'If that process exited unexpectedly, inspect running lifecycle processes and %s before removing a stale lock.\n' "$lifecycle_lock" >&2
    exit 1
  fi
  if ! lifecycle_owner=$(mktemp "$lifecycle_lock/owner.XXXXXXXX"); then
    rmdir "$lifecycle_lock" 2>/dev/null || true
    echo 'Could not record Kubernetes lifecycle ownership.' >&2
    exit 1
  fi
  printf '%s\n%s\n%s\n' "$$" "$action" "$namespace" > "$lifecycle_owner"
}
node_operation() (
  set -- "$ops_image" node /workspace/scripts/kubernetes.mjs "$@"
  [ -z "$evidence" ] || set -- --mount "type=bind,src=$evidence,dst=$evidence,readonly" "$@"
  if [ -n "$backup" ] && [ -d "$backup" ]; then set -- --mount "type=bind,src=$backup,dst=$backup,readonly" "$@"; fi
  set -- --mount "type=bind,src=$project,dst=/workspace,readonly" --mount "type=bind,src=$root,dst=$root" "$@"
  docker --context "$source_context" run --rm --pull never --user "$(id -u):$(id -g)" --entrypoint '' "$@"
)
ensure_operations() {
  if ! docker --context "$source_context" image inspect "$ops_image" >/dev/null 2>&1; then
    docker --context "$source_context" build --quiet --target operations -t "$ops_image" -f "$project/infra/Dockerfile" "$project" >/dev/null
  fi
}
kube() { kubectl --context "$context" --namespace "$namespace" "$@"; }
source_compose() {
  STUDIO_DOCKER_ROOT=$root STUDIO_PROJECT_DIR=$project docker --context "$source_context" compose --project-directory "$project" --env-file "$root/config/compose.env" -f "$project/infra/compose.yml" "$@"
}
stop_kubernetes() {
  for service in api article-worker video-worker delivery-worker model-runner renderer tts draft-bridge $(kube get deployment knowledge-tools --ignore-not-found -o jsonpath='{.metadata.name}'); do kube scale "deployment/$service" --replicas=0; done
  if [ -n "$(kube get pods -l app.kubernetes.io/part-of=content-studio -o name)" ]; then kube wait --for=delete pod -l app.kubernetes.io/part-of=content-studio --timeout=120s; fi
  for service in api draft-companion; do kube patch "service/$service" --type=merge --patch '{"spec":{"type":"ClusterIP"}}' >/dev/null; done
  node_operation record-runtime --root "$root" --namespace "$namespace" --phase stopped
}
start_kubernetes() {
  # Fence Compose commands even if a later rollout is only partially ready.
  node_operation record-runtime --root "$root" --namespace "$namespace" --phase active
  for service in api article-worker video-worker delivery-worker model-runner renderer tts draft-bridge $(kube get deployment knowledge-tools --ignore-not-found -o jsonpath='{.metadata.name}'); do kube scale "deployment/$service" --replicas=1; done
  for service in api article-worker video-worker delivery-worker model-runner renderer tts draft-bridge $(kube get deployment knowledge-tools --ignore-not-found -o jsonpath='{.metadata.name}'); do
    if [ "$service" = model-runner ] && [ "$action" = start ] && [ "$allow_unready_model" = true ]; then
      echo 'Fixture model authorization remains unready; rendering acceptance does not claim model generation.'
    else kube rollout status "deployment/$service" --timeout=420s; fi
  done
}
assert_compose_stopped() {
  running=$(source_compose ps --status running --services)
  for service in api article-worker video-worker delivery-worker model-runner renderer tts draft-bridge knowledge-tools browser browser-publisher; do
    if printf '%s\n' "$running" | grep -qx "$service"; then echo 'Original Compose application still owns this workspace; cutover refused.' >&2; exit 1; fi
  done
}
assert_other_instances_stopped() {
  workspace=$(node_operation settings --root "$root" --namespace "$namespace" --key workspaceId)
  active=$(kubectl --context "$context" get deployments --all-namespaces -l "studio.content/workspace=$workspace" -o 'jsonpath={range .items[*]}{.metadata.namespace}{" "}{.spec.replicas}{"\n"}{end}' | awk -v current="$namespace" '$1 != current && $2 + 0 > 0 { print $1 }')
  [ -z "$active" ] || { echo 'Another Kubernetes application owns this workspace; stop it before continuing.' >&2; exit 1; }
}
case "$action" in
  configure|render|enable|validate|preflight|start|stop|backup|cutover|rollback)
    trap finish_lifecycle EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    lock_lifecycle
    ;;
esac
ensure_operations
case "$action" in
  validate|preflight|start|stop|status|backup|cutover|rollback)
    node_operation assert-scope --root "$root" --namespace "$namespace" --context "$context" --docker-context "$source_context"
    ;;
esac
case "$action" in
  configure|render) node_operation "$action" "$@" ;;
  enable)
    # OrbStack may select its new context automatically. Preserve the previous selection.
    old_context=$(kubectl config current-context 2>/dev/null || true)
    restore_context_needed=true
    orb start k8s
    kubectl --context "$context" wait node --all --for=condition=Ready --timeout=120s >/dev/null
    restore_context
    echo 'OrbStack cluster activated; the previous global Kubernetes context was preserved.'
    ;;
  validate)
    node_operation render "$@"
    if kube get namespace "$namespace" >/dev/null 2>&1; then
      kube apply --dry-run=server -k "$private" >/dev/null
      echo 'Kubernetes server-side manifest validation passed; secret data was not printed.'
    else
      kube apply --dry-run=client --validate=true -k "$private" >/dev/null
      echo 'Kubernetes schema validation passed; namespace is absent, so server admission remains a preflight gate.'
    fi
    ;;
  preflight)
    node_operation render "$@"
    kube create namespace "$namespace" --dry-run=client -o json | kube apply -f - >/dev/null
    existing_replicas=$(kube get deployments -o 'jsonpath={range .items[*]}{.spec.replicas}{"\n"}{end}')
    if printf '%s\n' "$existing_replicas" | grep -q '[1-9]'; then echo 'Preflight requires stopped applications; it will not reset a live deployment.' >&2; exit 1; fi
    kube apply -k "$private" >/dev/null
    kube apply -f "$private/secret.json" >/dev/null
    node_operation prepare-preflight "$@"
    kube delete pod studio-preflight --ignore-not-found --wait=true >/dev/null
    kube apply -f "$private/probe.json" >/dev/null
    if ! kube wait pod/studio-preflight --for=jsonpath='{.status.phase}'=Succeeded --timeout=180s; then
      echo 'Pod preflight did not pass. Compose remains the active runtime; inspect safe Pod events.' >&2
      exit 1
    fi
    node_operation record-preflight "$@"
    kube delete pod studio-preflight --wait=true >/dev/null
    ;;
  start)
    node_operation gate-start "$@"
    assert_other_instances_stopped
    node_operation render "$@" --expose
    kube apply -f "$private/secret.json" >/dev/null
    kube apply -k "$private" >/dev/null
    start_kubernetes
    ;;
  stop) stop_kubernetes; echo 'Application stopped; Supabase, PVs and files retained.' ;;
  status) kube get deployments,pods,services,pvc ;;
  backup)
    [ -n "$backup" ] || { echo 'Provide --target absolute-backup-directory.' >&2; exit 1; }
    assert_other_instances_stopped
    stop_kubernetes
    # Existing wrapper owns encrypted format-3 backup and all Supabase restore safeguards.
    DOCKER_CONTEXT=$source_context sh "$project/scripts/docker.sh" backup --root "$root" --target "$backup"
    DOCKER_CONTEXT=$source_context sh "$project/scripts/docker.sh" database --root "$root"
    node_operation verify-backup --root "$root" --source "$backup"
    echo 'Backup verified; only Supabase was restarted. Application and publishing stay paused.'
    ;;
  cutover)
    [ -n "$backup" ] && [ -n "$evidence" ] || { echo 'Provide --evidence and --backup with completed fixture validation and a verified backup.' >&2; exit 1; }
    node_operation gate-cutover "$@"
    assert_other_instances_stopped
    # Cutover is deliberately separate from preflight/start. Never starts another schedule owner.
    source_compose --profile evidence stop api article-worker video-worker delivery-worker draft-bridge model-runner renderer tts knowledge-tools
    assert_compose_stopped
    node_operation render "$@" --expose
    kube apply -f "$private/secret.json" >/dev/null
    kube apply -k "$private" >/dev/null
    start_kubernetes
    echo 'Kubernetes application adopted the original files and workspace; existing paused schedules remain paused.'
    ;;
  rollback)
    node_operation settings --root "$root" --namespace "$namespace" --key mode | grep -qx owner || { echo 'Rollback is only for the owner configuration.' >&2; exit 1; }
    application_image=$(node_operation adopted-image --root "$root" --namespace "$namespace" --component application)
    model_image=$(node_operation adopted-image --root "$root" --namespace "$namespace" --component model)
    renderer_image=$(node_operation adopted-image --root "$root" --namespace "$namespace" --component renderer)
    tts_image=$(node_operation adopted-image --root "$root" --namespace "$namespace" --component tts)
    docker --context "$source_context" image inspect "$application_image" "$model_image" "$renderer_image" "$tts_image" >/dev/null
    knowledge_image=$(node_operation adopted-image --root "$root" --namespace "$namespace" --component knowledge)
    if [ "$knowledge_image" != undefined ]; then docker --context "$source_context" image inspect "$knowledge_image" >/dev/null; fi
    stop_kubernetes
    node_operation record-runtime --root "$root" --namespace "$namespace" --orchestrator compose --phase stopped
    (export STUDIO_APPLICATION_IMAGE=$application_image STUDIO_MODEL_IMAGE=$model_image STUDIO_RENDERER_IMAGE=$renderer_image STUDIO_TTS_IMAGE=$tts_image; if [ "$knowledge_image" != undefined ]; then export STUDIO_KNOWLEDGE_IMAGE=$knowledge_image; source_compose --profile evidence up -d --no-deps --wait knowledge-tools; fi; source_compose up -d --no-deps --wait api article-worker video-worker delivery-worker model-runner renderer tts draft-bridge)
    node_operation record-runtime --root "$root" --namespace "$namespace" --orchestrator compose --phase active
    echo 'The verified release resumed in Compose on the same database and files. Old code requires backup restoration; publishing stays paused.'
    ;;
  *) echo 'Usage: sh scripts/kubernetes.sh configure|enable|render|validate|preflight|start|stop|status|backup|cutover|rollback --root PATH --namespace NAME --context orbstack [configuration flags]' >&2; exit 1 ;;
esac
