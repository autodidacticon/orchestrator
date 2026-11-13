#!/usr/bin/env bash
set -euo pipefail
# The cluster-level acceptance test: build, load into kind, install CloudNativePG, apply the kind overlay, load the
# graph, and assert over the API. Each milestone adds its assertions below the M1 ones. See deploy/README.md "Smoke test".
#
#   deploy/smoke.sh            run against the kind cluster $KIND_CLUSTER (default orch)
#   deploy/smoke.sh --dry-run  print each step's command and execute nothing

KIND_CLUSTER="${KIND_CLUSTER:-orch}"
# kind names a cluster's kubeconfig context kind-<name>; every kubectl call is pinned to it.
KUBE_CONTEXT="${KUBE_CONTEXT:-kind-$KIND_CLUSTER}"
IMAGE="${IMAGE:-orchestrator:dev}"
NAMESPACE=orch
LOCAL_PORT_SET="${LOCAL_PORT:-}"
LOCAL_PORT="${LOCAL_PORT:-18080}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-300s}"
# How long to wait for the daemon's first tick to park a launch.
STATUS_TIMEOUT_S="${STATUS_TIMEOUT_S:-120}"
# The CloudNativePG operator, installed before the overlay, whose Cluster needs its CRD.
CNPG_MANIFEST="${CNPG_MANIFEST:-https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.1.yaml}"
API="http://127.0.0.1:${LOCAL_PORT}"

DRY_RUN=0
case "${1:-}" in
  '') ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

# Succeeds when something already listens on 127.0.0.1:$1.
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Without an explicit LOCAL_PORT, step past a default port another process holds (a local proxy answering /healthz
# with 404 would otherwise look like the daemon). A dry run probes nothing.
if [ -z "${LOCAL_PORT_SET:-}" ] && [ "$DRY_RUN" = 0 ]; then
  while port_busy "$LOCAL_PORT"; do
    echo "smoke: port $LOCAL_PORT is in use, trying $((LOCAL_PORT + 1))" >&2
    LOCAL_PORT=$((LOCAL_PORT + 1))
    if [ "$LOCAL_PORT" -gt 18180 ]; then echo "smoke: no free local port in 18080..18180; set LOCAL_PORT" >&2; exit 1; fi
  done
  API="http://127.0.0.1:${LOCAL_PORT}"
fi

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

# Port-forward to the Service, replacing an earlier forward: a forward follows one pod.
forward() {
  if [ -n "$PF_PID" ]; then kill "$PF_PID" 2>/dev/null || true; PF_PID=''; fi
  echo "+ kubectl --context $KUBE_CONTEXT -n $NAMESPACE port-forward service/orchestrator $LOCAL_PORT:8080 &"
  if [ "$DRY_RUN" = 0 ]; then
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" port-forward service/orchestrator "$LOCAL_PORT:8080" >/dev/null &
    PF_PID=$!
  fi
  if ! step retry 30 curl -fsS -o /dev/null "$API/healthz"; then
    echo "smoke: $API/healthz did not answer 200 through the port-forward; if another process holds port $LOCAL_PORT, set LOCAL_PORT" >&2
    return 1
  fi
  # A forward that failed to bind exits at once, while another listener on the port may still answer.
  if [ "$DRY_RUN" = 0 ] && ! kill -0 "$PF_PID" 2>/dev/null; then
    echo "smoke: the port-forward exited; port $LOCAL_PORT is held by another process, set LOCAL_PORT" >&2
    return 1
  fi
}

# Send the overlay's graph with PUT /v1/graph and require it accepted. The graph lives in the store, not in a mount.
put_graph() {
  jq -Rs '{content: .}' deploy/overlays/kind/graph.yaml \
    | curl -fsS -X PUT -H 'content-type: application/json' --data-binary @- "$API/v1/graph" \
    | jq -e '.accepted == true' >/dev/null
}

# Succeeds when /v1/status satisfies the jq filter $1.
status_is() {
  curl -fsS "$API/v1/status" | jq -e "$1" >/dev/null
}

# Succeeds when no volume claim in the namespace belongs to the daemon (Postgres and git-origin keep their own).
no_orchestrator_claim() {
  ! kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get pvc -o name | grep -q orchestrator
}

# 1. Build the image.
step docker build -t "$IMAGE" .

# 2. Load it into the kind cluster.
step kind load docker-image "$IMAGE" --name "$KIND_CLUSTER"

# 3. Install the CloudNativePG operator and wait for it.
step kubectl --context "$KUBE_CONTEXT" apply --server-side -f "$CNPG_MANIFEST"
step kubectl --context "$KUBE_CONTEXT" -n cnpg-system rollout status deployment/cnpg-controller-manager --timeout="$ROLLOUT_TIMEOUT"

# 4. Apply the kind overlay.
step kubectl --context "$KUBE_CONTEXT" apply -k deploy/overlays/kind

# 5. Wait for Postgres (the daemon reads its application Secret), then the rollouts. The clone init container backs off until git-origin serves.
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" wait --for=condition=Ready cluster/postgres --timeout="$ROLLOUT_TIMEOUT"
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout status deployment/git-origin --timeout="$ROLLOUT_TIMEOUT"
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout status deployment/orchestrator --timeout="$ROLLOUT_TIMEOUT"

# 6. Port-forward to the Service.
forward

# 7. Load the graph.
step retry 30 put_graph

# 8. Assertions.

# M1: the daemon runs in pull mode and has parked a claimable launch for the overlay's task.
M1='.runner.mode == "pull" and (.claimable | length > 0)'
step retry "$STATUS_TIMEOUT_S" status_is "$M1"

# M2: the daemon has no volume claim.
step no_orchestrator_claim

# M2: a new pod (a fresh clone, an empty run directory) serves the same accepted graph and the parked launch from Postgres.
GRAPH_REV=unknown
if [ "$DRY_RUN" = 0 ]; then GRAPH_REV="$(curl -fsS "$API/v1/status" | jq -r .graphRev)"; fi
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" delete pod -l app.kubernetes.io/name=orchestrator --wait=true
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" wait --for=condition=Ready pod -l app.kubernetes.io/name=orchestrator --timeout="$ROLLOUT_TIMEOUT"
forward
M2=".graphRev == \"$GRAPH_REV\" and (.claimable | length > 0)"
step retry "$STATUS_TIMEOUT_S" status_is "$M2"

if [ "$DRY_RUN" = 1 ]; then echo "smoke: dry run, nothing executed"; else echo "smoke: ok"; fi
