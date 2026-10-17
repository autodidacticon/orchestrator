#!/usr/bin/env bash
set -euo pipefail
# The cluster-level acceptance test: build, load into kind, apply the kind overlay, and assert over the API.
# Each milestone adds its assertions below the M1 ones. See deploy/README.md "Smoke test".
#
#   deploy/smoke.sh            run against the kind cluster $KIND_CLUSTER (default orch)
#   deploy/smoke.sh --dry-run  print each step's command and execute nothing

KIND_CLUSTER="${KIND_CLUSTER:-orch}"
# kind names a cluster's kubeconfig context kind-<name>; every kubectl call is pinned to it.
KUBE_CONTEXT="${KUBE_CONTEXT:-kind-$KIND_CLUSTER}"
IMAGE="${IMAGE:-orchestrator:dev}"
NAMESPACE=orch
LOCAL_PORT="${LOCAL_PORT:-18080}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-300s}"
# How long to wait for the daemon's first tick to park a launch.
STATUS_TIMEOUT_S="${STATUS_TIMEOUT_S:-120}"
API="http://127.0.0.1:${LOCAL_PORT}"

DRY_RUN=0
case "${1:-}" in
  '') ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Print a step's command, then run it unless this is a dry run.
step() {
  echo "+ $*"
  if [ "$DRY_RUN" = 0 ]; then "$@"; fi
}

PF_PID=''
cleanup() {
  if [ -n "$PF_PID" ]; then kill "$PF_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

# Retry a command once a second until it succeeds or $1 seconds pass.
retry() {
  local deadline=$(( $(date +%s) + $1 )); shift
  until "$@"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then return 1; fi
    sleep 1
  done
}

# 1. Build the image.
step docker build -t "$IMAGE" .

# 2. Load it into the kind cluster.
step kind load docker-image "$IMAGE" --name "$KIND_CLUSTER"

# 3. Apply the kind overlay.
step kubectl --context "$KUBE_CONTEXT" apply -k deploy/overlays/kind

# 4. Wait for the rollout. The clone init container backs off until git-origin serves, so wait for that first.
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout status deployment/git-origin --timeout="$ROLLOUT_TIMEOUT"
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout status deployment/orchestrator --timeout="$ROLLOUT_TIMEOUT"

# 5. Port-forward to the Service.
echo "+ kubectl --context $KUBE_CONTEXT -n $NAMESPACE port-forward service/orchestrator $LOCAL_PORT:8080 &"
if [ "$DRY_RUN" = 0 ]; then
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" port-forward service/orchestrator "$LOCAL_PORT:8080" >/dev/null &
  PF_PID=$!
fi
step retry 30 curl -fsS -o /dev/null "$API/healthz"

# 6. Assertions.

# Succeeds when /v1/status satisfies the jq filter $1.
status_is() {
  curl -fsS "$API/v1/status" | jq -e "$1" >/dev/null
}

# M1: the daemon runs in pull mode and has parked a claimable launch for the overlay's task.
M1='.runner.mode == "pull" and (.claimable | length > 0)'
step retry "$STATUS_TIMEOUT_S" status_is "$M1"

if [ "$DRY_RUN" = 1 ]; then echo "smoke: dry run, nothing executed"; else echo "smoke: ok"; fi
