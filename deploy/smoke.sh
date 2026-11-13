#!/usr/bin/env bash
set -euo pipefail
# The cluster-level acceptance test: build, load into kind, install CloudNativePG, apply the kind overlay, load the
# graph, and assert over the API. Each milestone adds its assertions below the M1 ones. See deploy/README.md "Smoke test".
#
#   deploy/smoke.sh                run against the kind cluster $KIND_CLUSTER (default orch)
#   deploy/smoke.sh --fresh        delete and recreate the kind cluster first
#   deploy/smoke.sh --dry-run      print each step's command and execute nothing
#   deploy/smoke.sh --break NAME   falsify one restart-drill assertion on purpose, to show the script fails:
#                                  pvc (a claim named orchestrator-smoke-break) or claimable (claim the parked launch
#                                  just before the restart)
#
# Every assertion prints "smoke: pass: <name>" when it holds; the first that does not prints "smoke: FAIL: <name>" and
# the script exits 1.

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
# How long the verifier may take to publish the task the script works.
PUBLISH_TIMEOUT_S="${PUBLISH_TIMEOUT_S:-300}"
# How long Postgres stays frozen in the outage drill. CloudNativePG's liveness probe (3 x 10s) restarts a Postgres that
# stays unresponsive for about 30s, which would end the daemon's session and so the daemon; stay well under it.
OUTAGE_S="${OUTAGE_S:-10}"
# The CloudNativePG operator, installed before the overlay, whose Cluster needs its CRD.
CNPG_MANIFEST="${CNPG_MANIFEST:-https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.1.yaml}"
API="http://127.0.0.1:${LOCAL_PORT}"
# The task the script works itself until it is published, and the task whose launch stays parked.
WORK_TASK=SMOKE
PARKED_TASK=SMOKE-PARKED
WORKER_ID=smoke

DRY_RUN=0
FRESH=0
BREAK=''
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --fresh) FRESH=1 ;;
    --break)
      BREAK="${2:-}"; shift
      case "$BREAK" in pvc | claimable) ;; *) echo "usage: --break pvc|claimable" >&2; exit 2 ;; esac
      ;;
    *) echo "usage: $0 [--dry-run] [--fresh] [--break pvc|claimable]" >&2; exit 2 ;;
  esac
  shift
done

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

# One named assertion: print the command, run it unless this is a dry run, and name the outcome.
check() {
  local name="$1"; shift
  local cmd="$*"
  echo "+ ${cmd//$'\n'/ }"
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  if "$@"; then
    echo "smoke: pass: $name"
  else
    echo "smoke: FAIL: $name" >&2
    exit 1
  fi
}

kc() { kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }

PF_PID=''
FROZEN=''
OUTAGE_WRITE_PID=''
cleanup() {
  if [ -n "$FROZEN" ]; then thaw_postgres "$FROZEN" || true; fi
  if [ -n "$OUTAGE_WRITE_PID" ]; then kill "$OUTAGE_WRITE_PID" 2>/dev/null || true; fi
  if [ -n "$PF_PID" ]; then kill "$PF_PID" 2>/dev/null || true; fi
  if [ "$BREAK" = pvc ] && [ "$DRY_RUN" = 0 ]; then kc delete pvc orchestrator-smoke-break --ignore-not-found --wait=false >/dev/null 2>&1 || true; fi
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

# Print /v1/status through the jq filter $1.
status_get() {
  curl -fsS "$API/v1/status" | jq -cr "$1"
}

# Succeeds when the claim list could be read and no claim in the namespace belongs to the daemon (Postgres and
# git-origin keep their own).
no_orchestrator_claim() {
  local claims
  claims="$(kc get pvc -o name)" || return 1
  echo "$claims" | sed 's/^/    /'
  ! grep -q orchestrator <<<"$claims"
}

# The daemon pod and the Postgres instance pod (one instance), by name.
daemon_pod() { kc get pod -l app.kubernetes.io/name=orchestrator --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'; }
postgres_pod() { kc get pod -l cnpg.io/cluster=postgres,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}'; }

# Run one SQL statement in the CloudNativePG cluster's database, unaligned with | between columns.
psql_q() {
  kc exec "$(postgres_pod)" -c postgres -- psql -d orchestrator -X -v ON_ERROR_STOP=1 -tA -c "$1"
}

# Origin's integration head, read in git-origin's bare repository.
origin_head() { kc exec deploy/git-origin -c git-daemon -- git --git-dir=/srv/git/fixture.git rev-parse refs/heads/main; }

# The daemon's view of the integration head after a restart: its fresh clone's main.
clone_head() { kc exec "$(daemon_pod)" -c orchestrator -- git -C /data/repo rev-parse refs/heads/main; }

# The tasks named by Orchestrator-Task trailers on the first-parent history of $1 in the bare origin.
origin_trailer_tasks() {
  kc exec deploy/git-origin -c git-daemon -- git --git-dir=/srv/git/fixture.git log --format='%(trailers:key=Orchestrator-Task,valueonly)' "$1" | sed '/^$/d'
}

# The sha the verifier published for task $1, from the transition event that marked it done.
published_sha() {
  curl -fsS "$API/v1/events?kinds=transition&limit=500" \
    | jq -er --arg t "$1" '[.events[] | select(.taskId == $t and .payload.to == "done")] | last | .payload.publishedSha'
}

# Work $WORK_TASK as a pull-mode worker would: claim its launch, commit in the pod's worktree, submit. A task already
# submitted or done (a rerun on a kept cluster) is left alone.
work_one_task() {
  if status_is ".byStatus.done + .byStatus.submitted | index(\"$WORK_TASK\")"; then
    echo "    $WORK_TASK is already submitted or done"
    return 0
  fi
  local claim launch token worktree
  claim="$(curl -fsS -X POST -H 'content-type: application/json' \
    --data "{\"workerId\":\"$WORKER_ID\",\"taskId\":\"$WORK_TASK\"}" "$API/v1/claims")" || return 1
  launch="$(jq -er .launchId <<<"$claim")"; token="$(jq -er .token <<<"$claim")"; worktree="$(jq -er .worktree <<<"$claim")"
  echo "    claimed launch $launch, worktree $worktree"
  kc exec "$(daemon_pod)" -c orchestrator -- sh -ec '
    cd "$1"
    git diff --quiet HEAD -- README.md || exit 0
    echo "A line appended by deploy/smoke.sh." >> README.md
    git add README.md
    git commit -q -m "Append a line to README.md"' sh "$worktree"
  jq -n '{kind: "submit", seq: 1, summary: "Append a line to README.md (deploy/smoke.sh acting as the worker).",
          acceptance: [{criterion: "README.md has one more line than before.", evidence: "deploy/smoke.sh appended one line and committed it."}]}' \
    | curl -fsS -X POST -H 'content-type: application/json' -H "Authorization: Bearer $token" --data-binary @- \
      "$API/v1/launches/$launch/report" | jq -e '.accepted == true' >/dev/null
}

# --- The restart drill's snapshot and assertions. ---

# The claimable task ids from the API, sorted, one per line.
api_claimable() { status_get '.claimable | sort | .[]'; }
# Task states from the API as id|state lines, sorted.
api_states() { status_get '[.byStatus | to_entries[] | .key as $k | .value[] | "\(.)|\($k)"] | sort | .[]'; }
# The same from Postgres: launch counts by status, claimable launches, task states.
pg_launch_counts() { psql_q "select status, count(*) from launches where run_id = '$RUN_ID' group by 1 order by 1"; }
pg_claimable_tasks() { psql_q "select task_id from launches where run_id = '$RUN_ID' and status = 'claimable' order by 1"; }
pg_claimable_launches() { psql_q "select launch_id from launches where run_id = '$RUN_ID' and status = 'claimable' order by 1"; }
pg_states() { psql_q "select id || '|' || (entry->'status'->>'kind') from overlay where run_id = '$RUN_ID' order by 1"; }

# Succeeds when $2 (a function name) prints exactly $1.
same() {
  local want="$1" got; got="$("$2")" || return 1
  if [ "$got" != "$want" ]; then
    printf '    expected:\n%s\n    got:\n%s\n' "$(sed 's/^/      /' <<<"$want")" "$(sed 's/^/      /' <<<"$got")"
    return 1
  fi
  printf '%s\n' "$got" | sed 's/^/    /'
}

# Succeeds when the launch.reprepared events after sequence $1 name exactly the launches in $2, one event each.
reprepared_once_each() {
  local got
  got="$(curl -fsS "$API/v1/events?after=$1&kinds=launch.reprepared&limit=500" | jq -r '[.events[].launchId] | sort | .[]')" || return 1
  echo "    launch.reprepared after seq $1: $(tr '\n' ' ' <<<"$got")"
  [ -n "$2" ] && [ "$got" = "$2" ]
}

# Succeeds when $1 equals the output of the function $2.
head_is() {
  local got; got="$("$2")" || return 1
  echo "    $2: $got"
  [ "$got" = "$1" ]
}

# Succeeds when the first-parent history of origin's main carries task $1's trailer commit.
origin_carries_task() {
  local tasks; tasks="$(origin_trailer_tasks refs/heads/main)" || return 1
  echo "    Orchestrator-Task trailers on origin main: $(tr '\n' ' ' <<<"$tasks")"
  grep -qxF "$1" <<<"$tasks"
}

# --- The Postgres-outage drill. ---

# Send SIGSTOP (or SIGCONT) to every postgres process of pod $1. The instance manager (pid 1) keeps running and the
# daemon's session stays open, so the daemon is not fenced; its batches just stop flushing.
signal_postgres() {
  kc exec "$1" -c postgres -- sh -c '
    n=0
    for p in /proc/[0-9]*; do
      [ "$(cat "$p/comm" 2>/dev/null)" = postgres ] || continue
      kill "-$0" "${p#/proc/}" && n=$((n + 1))
    done
    echo "    sent SIG$0 to $n postgres processes"
    [ "$n" -gt 0 ]' "$2"
}
freeze_postgres() { FROZEN="$1"; signal_postgres "$1" STOP; }
thaw_postgres() { signal_postgres "$1" CONT && FROZEN=''; }

# The daemon pod's uid and its container's restart count.
daemon_identity() {
  kc get pod -l app.kubernetes.io/name=orchestrator -o jsonpath='{range .items[*]}{.metadata.uid} {.status.containerStatuses[?(@.name=="orchestrator")].restartCount}{"\n"}{end}'
}

# A harmless write (an operator.claim event for a task that does not exist; answered 404) whose response waits until
# the record is durable, so it stays pending while Postgres is frozen. Prints the HTTP status when it completes.
outage_write() {
  curl -sS -o /dev/null -w '%{http_code}\n' --max-time 300 -X POST -H 'content-type: application/json' \
    --data "{\"workerId\":\"$WORKER_ID-outage\",\"taskId\":\"$WORK_TASK-NO-SUCH-TASK\"}" "$API/v1/claims"
}

readyz_code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$API/readyz"; }

# Sample /readyz and /v1/status once a second for $1 seconds into $OUTAGE_SAMPLES (readyz lagMs pendingBatches).
OUTAGE_SAMPLES=''
sample_outage() {
  local i rz lag
  OUTAGE_SAMPLES=''
  for i in $(seq 1 "$1"); do
    sleep 1
    rz="$(readyz_code || true)"
    lag="$(curl -fsS --max-time 5 "$API/v1/status" | jq -r '"\(.storeLagMs) \(.storePendingBatches)"')" || lag='unanswered -'
    echo "    t+${i}s readyz=$rz storeLagMs/pending=$lag"
    OUTAGE_SAMPLES+="$rz $lag"$'\n'
  done
}

readyz_failed_during_outage() { awk 'NF == 0 { next } $1 != 200 { bad = 1 } END { exit !bad }' <<<"$OUTAGE_SAMPLES"; }
status_answered_during_outage() { awk 'NF == 0 { next } { n++ } $2 == "unanswered" { bad = 1 } END { exit bad || n == 0 }' <<<"$OUTAGE_SAMPLES"; }
# The lag is above zero at the first sample and rises at every later one.
lag_rose_during_outage() {
  awk 'NF == 0 { next } { n++; lag = $2 + 0 } n == 1 && lag <= 0 { bad = 1 } n > 1 && lag <= prev { bad = 1 } { prev = lag } END { exit bad || n < 2 }' <<<"$OUTAGE_SAMPLES"
}
lag_is_zero() { status_is '.storeLagMs == 0 and .storePendingBatches == 0'; }
readyz_ok() { [ "$(readyz_code)" = 200 ]; }
outage_write_completed() {
  local code; code="$(cat "$OUTAGE_WRITE_OUT")"
  echo "    the pending write answered $code"
  [ "$code" = 404 ]
}

if [ "$FRESH" = 1 ]; then
  # 0. Start from an empty kind cluster.
  step kind delete cluster --name "$KIND_CLUSTER"
  step kind create cluster --name "$KIND_CLUSTER"
fi

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
check 'M1: pull mode with a claimable launch' retry "$STATUS_TIMEOUT_S" status_is '.runner.mode == "pull" and (.claimable | length > 0)'

# M2: the daemon has no volume claim.
check 'M2: no orchestrator volume claim' no_orchestrator_claim

# M2 restart drill. Run the graph until one task is published and one launch is claimable.
step retry "$STATUS_TIMEOUT_S" status_is "(.claimable | index(\"$WORK_TASK\")) or (.byStatus.done + .byStatus.submitted | index(\"$WORK_TASK\"))"
step work_one_task
check "drill: $WORK_TASK published" retry "$PUBLISH_TIMEOUT_S" status_is ".byStatus.done | index(\"$WORK_TASK\")"
check "drill: $PARKED_TASK claimable" retry "$STATUS_TIMEOUT_S" status_is ".claimable | index(\"$PARKED_TASK\")"

# Record the claimable set, the task states and the integration head from the API, and the launches from Postgres.
RUN_ID=dry-run GRAPH_REV=unknown SEQ0=0 HEAD0=dry-run
API_CLAIMABLE0='' API_STATES0='' PG_COUNTS0='' PG_CLAIMABLE0='' PG_LAUNCHES0='' PG_STATES0=''
if [ "$DRY_RUN" = 0 ]; then
  RUN_ID="$(basename "$(status_get .runDir)")"
  GRAPH_REV="$(status_get .graphRev)"
  SEQ0="$(status_get .latestSeq)"
  HEAD0="$(published_sha "$WORK_TASK")"
  API_CLAIMABLE0="$(api_claimable)"
  API_STATES0="$(api_states)"
  PG_COUNTS0="$(pg_launch_counts)"
  PG_CLAIMABLE0="$(pg_claimable_tasks)"
  PG_LAUNCHES0="$(pg_claimable_launches)"
  PG_STATES0="$(pg_states)"
  echo "smoke: before the restart: run $RUN_ID, graph $GRAPH_REV, latest seq $SEQ0, integration head $HEAD0"
  echo "    claimable (API): $(tr '\n' ' ' <<<"$API_CLAIMABLE0")"
  echo "    claimable launches (psql): $(tr '\n' ' ' <<<"$PG_LAUNCHES0")"
  echo "    task states (API): $(tr '\n' ' ' <<<"$API_STATES0")"
  echo "    launches by status (psql): $(tr '\n' ' ' <<<"$PG_COUNTS0")"
fi
check 'drill: API and psql agree on the claimable set before the restart' same "$API_CLAIMABLE0" pg_claimable_tasks
check 'drill: API and psql agree on the task states before the restart' same "$API_STATES0" pg_states

if [ "$BREAK" = pvc ]; then
  echo "smoke: --break pvc: creating a volume claim named orchestrator-smoke-break"
  step kc create -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: orchestrator-smoke-break
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Mi
EOF
fi
if [ "$BREAK" = claimable ]; then
  echo "smoke: --break claimable: claiming $PARKED_TASK's parked launch before the restart"
  step curl -fsS -o /dev/null -X POST -H 'content-type: application/json' --data "{\"workerId\":\"$WORKER_ID-break\",\"taskId\":\"$PARKED_TASK\"}" "$API/v1/claims"
fi

# Delete the daemon pod and wait for its replacement: a fresh clone and an empty run directory.
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" delete pod -l app.kubernetes.io/name=orchestrator --wait=true
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout status deployment/orchestrator --timeout="$ROLLOUT_TIMEOUT"
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" wait --for=condition=Ready pod -l app.kubernetes.io/name=orchestrator --timeout="$ROLLOUT_TIMEOUT"
forward
check 'drill: the same accepted graph and a claimable launch after the restart' retry "$STATUS_TIMEOUT_S" status_is ".graphRev == \"$GRAPH_REV\" and (.claimable | length > 0)"

check 'drill: claimable set unchanged (API)' same "$API_CLAIMABLE0" api_claimable
check 'drill: claimable set unchanged (psql)' same "$PG_CLAIMABLE0" pg_claimable_tasks
check 'drill: task states unchanged (API)' same "$API_STATES0" api_states
check 'drill: task states unchanged (psql)' same "$PG_STATES0" pg_states
check 'drill: launches by status unchanged (psql)' same "$PG_COUNTS0" pg_launch_counts
check 'drill: integration head equals origin main' head_is "$HEAD0" origin_head
check "drill: the daemon's clone is at origin's head" head_is "$HEAD0" clone_head
check "drill: origin main carries $WORK_TASK's Orchestrator-Task commit" origin_carries_task "$WORK_TASK"
check 'drill: one launch.reprepared per claimable launch' reprepared_once_each "$SEQ0" "$PG_LAUNCHES0"
check 'drill: no orchestrator volume claim' no_orchestrator_claim

# M2 Postgres-outage drill: freeze Postgres for $OUTAGE_S seconds with a write pending. /readyz fails, /v1/status
# still answers with storeLagMs rising; after the thaw the lag returns to zero and the daemon has not restarted.
PGPOD=dry-run IDENTITY0=dry-run OUTAGE_WRITE_OUT=/dev/null
if [ "$DRY_RUN" = 0 ]; then
  OUTAGE_WRITE_OUT="$(mktemp -t smoke-outage.XXXXXX)"
  PGPOD="$(postgres_pod)"
  IDENTITY0="$(daemon_identity)"
  echo "smoke: before the outage: daemon pod uid and restarts: $IDENTITY0; Postgres pod $PGPOD"
fi
check 'outage: lag is zero before the outage' retry 60 lag_is_zero
step freeze_postgres "$PGPOD"
echo "+ outage_write > $OUTAGE_WRITE_OUT &"
if [ "$DRY_RUN" = 0 ]; then outage_write >"$OUTAGE_WRITE_OUT" & OUTAGE_WRITE_PID=$!; fi
step sample_outage "$OUTAGE_S"
step thaw_postgres "$PGPOD"
check 'outage: /readyz failed while Postgres was stopped' readyz_failed_during_outage
check 'outage: /v1/status answered while Postgres was stopped' status_answered_during_outage
check 'outage: storeLagMs rose while Postgres was stopped' lag_rose_during_outage
check 'outage: the lag returned to zero after the restore' retry 120 lag_is_zero
check 'outage: /readyz passes again' retry 60 readyz_ok
if [ "$DRY_RUN" = 0 ]; then wait "$OUTAGE_WRITE_PID" || true; OUTAGE_WRITE_PID=''; fi
check 'outage: the pending write completed' outage_write_completed
check 'outage: the daemon did not restart' same "$IDENTITY0" daemon_identity
if [ "$DRY_RUN" = 0 ]; then rm -f "$OUTAGE_WRITE_OUT"; fi

if [ "$DRY_RUN" = 1 ]; then echo "smoke: dry run, nothing executed"; else echo "smoke: ok"; fi
