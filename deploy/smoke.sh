#!/usr/bin/env bash
set -euo pipefail
# The cluster-level acceptance test: build, load into kind, install CloudNativePG, apply the kind overlay, load the
# graph, and assert over the API. Each milestone adds its assertions below the M1 ones. See deploy/README.md "Smoke test".
#
#   deploy/smoke.sh                run against the kind cluster $KIND_CLUSTER (default orch)
#   deploy/smoke.sh --fresh        delete and recreate the kind cluster first, then restore the current kubectl context
#   deploy/smoke.sh --dry-run      print each step's command and execute nothing
#   deploy/smoke.sh --break NAME   falsify one drill assertion on purpose, to show the script fails: pvc (mount a
#                                  claim named data-smoke-break into the daemon pod), claimable (claim the parked
#                                  launch just before the restart) or restart (stop the daemon with SIGTERM in place of
#                                  deleting the Postgres pod, so that its container restarts for another reason)
#
# Every assertion prints "smoke: pass: <name>" when it holds; the first that does not prints "smoke: FAIL: <name>" and
# the script exits 1. An assertion or step that does not run prints "smoke: skip: <name> (<why>)".

usage() { echo "usage: $0 [--dry-run] [--fresh] [--break pvc|claimable|restart]" >&2; exit 2; }

KIND_CLUSTER="${KIND_CLUSTER:-orch}"
# kind names a cluster's kubeconfig context kind-<name>; every kubectl call is pinned to it. KUBE_CONTEXT may be set,
# but only to that name: kind loads the image into KIND_CLUSTER, and kubectl must talk to the same cluster.
KUBE_CONTEXT="${KUBE_CONTEXT:-kind-$KIND_CLUSTER}"
if [ "$KUBE_CONTEXT" != "kind-$KIND_CLUSTER" ]; then
  echo "smoke: KUBE_CONTEXT=$KUBE_CONTEXT does not name the kind cluster KIND_CLUSTER=$KIND_CLUSTER (expected kind-$KIND_CLUSTER)" >&2
  exit 2
fi
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
# The Postgres-restart drill: how long the daemon may take to exit once the old Postgres pod is gone, and how long from
# then until the daemon is ready again (the new Postgres pod starts, then the container's crash-loop back-off of
# 10s, 20s, 40s...). Measured on kind: about 12s.
PG_EXIT_TIMEOUT_S="${PG_EXIT_TIMEOUT_S:-60}"
PG_READY_TIMEOUT_S="${PG_READY_TIMEOUT_S:-120}"
# How long the follower of the daemon's log may take to end once its container has restarted.
PG_LOG_TIMEOUT_S="${PG_LOG_TIMEOUT_S:-30}"
# The CloudNativePG operator, installed before the overlay, whose Cluster needs its CRD.
CNPG_MANIFEST="${CNPG_MANIFEST:-https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.1.yaml}"
API="http://127.0.0.1:${LOCAL_PORT}"
# The task the script works itself until it is published, and the task whose launch stays parked.
WORK_TASK=SMOKE
PARKED_TASK=SMOKE-PARKED
WORKER_ID=smoke
# --break pvc: a claim whose name does not mention the orchestrator, mounted into the daemon pod.
BREAK_CLAIM=data-smoke-break

DRY_RUN=0
FRESH=0
BREAK=''
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --fresh) FRESH=1 ;;
    --break)
      BREAK="${2:-}"; shift || true
      case "$BREAK" in pvc | claimable | restart) ;; *) usage ;; esac
      ;;
    *) usage ;;
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

# A check or step that does not run says so, and why, on stdout.
skip() { echo "smoke: skip: $1 ($2)"; }

# One named assertion: print the command, run it unless this is a dry run, and name the outcome.
check() {
  local name="$1"; shift
  local cmd="$*"
  echo "+ ${cmd//$'\n'/ }"
  if [ "$DRY_RUN" = 1 ]; then skip "$name" 'dry run: nothing is executed'; return 0; fi
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
BREAK_PATCHED=''
PG_LOG_PID='' PG_LOG=''
cleanup() {
  if [ -n "$FROZEN" ]; then thaw_postgres "$FROZEN" || true; fi
  if [ -n "$PG_LOG_PID" ]; then kill "$PG_LOG_PID" 2>/dev/null || true; fi
  if [ -n "$PG_LOG" ]; then rm -f "$PG_LOG"; fi
  if [ -n "$OUTAGE_WRITE_PID" ]; then kill "$OUTAGE_WRITE_PID" 2>/dev/null || true; fi
  if [ -n "$PF_PID" ]; then kill "$PF_PID" 2>/dev/null || true; fi
  if [ -n "$BREAK_PATCHED" ]; then unmount_break_claim || true; fi
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

# kind create cluster makes its new context the current one. Put back the context that was current before, or none.
PREV_CONTEXT=''
save_context() { PREV_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"; }
restore_context() {
  if [ -n "$PREV_CONTEXT" ]; then
    kubectl config use-context "$PREV_CONTEXT" >/dev/null
  else
    kubectl config unset current-context >/dev/null
  fi
  echo "    current kubectl context: ${PREV_CONTEXT:-(none)}"
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

# The daemon pod and the Postgres instance pod (one instance), by name.
daemon_pod() { kc get pod -l app.kubernetes.io/name=orchestrator --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'; }
postgres_pod() { kc get pod -l cnpg.io/cluster=postgres,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}'; }

# Succeeds when every daemon pod could be read and none of them has a volume backed by a claim, whatever its name
# (a persistentVolumeClaim volume or a generic ephemeral one). Postgres and git-origin keep their own claims.
daemon_mounts_no_claim() {
  local pods claims
  pods="$(kc get pod -l app.kubernetes.io/name=orchestrator -o json)" || return 1
  [ "$(jq '.items | length' <<<"$pods")" -gt 0 ] || { echo "    no daemon pod"; return 1; }
  jq -r '.items[] | .metadata.name as $p | .spec.volumes[] | "    \($p): volume \(.name): \(del(.name) | keys | join(","))"' <<<"$pods"
  claims="$(jq -r '.items[] | .spec.volumes[] | select(.persistentVolumeClaim or .ephemeral) | .name' <<<"$pods")"
  if [ -n "$claims" ]; then echo "    volumes backed by a claim: $(tr '\n' ' ' <<<"$claims")"; return 1; fi
}

# --break pvc: create the claim and mount it into the daemon container. The patch rolls the daemon (Recreate).
mount_break_claim() {
  kc create -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $BREAK_CLAIM
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Mi
EOF
  BREAK_PATCHED=1
  kc patch deployment orchestrator --type strategic -p "{\"spec\":{\"template\":{\"spec\":{
    \"volumes\":[{\"name\":\"$BREAK_CLAIM\",\"persistentVolumeClaim\":{\"claimName\":\"$BREAK_CLAIM\"}}],
    \"containers\":[{\"name\":\"orchestrator\",\"volumeMounts\":[{\"name\":\"$BREAK_CLAIM\",\"mountPath\":\"/smoke-break\"}]}]}}}}"
}
# On exit: remove the mount and the volume again (kubectl apply -k would not), then the claim.
unmount_break_claim() {
  kc patch deployment orchestrator --type strategic -p "{\"spec\":{\"template\":{\"spec\":{
    \"volumes\":[{\"name\":\"$BREAK_CLAIM\",\"\$patch\":\"delete\"}],
    \"containers\":[{\"name\":\"orchestrator\",\"volumeMounts\":[{\"mountPath\":\"/smoke-break\",\"\$patch\":\"delete\"}]}]}}}}" >/dev/null
  kc delete pvc "$BREAK_CLAIM" --ignore-not-found --wait=false >/dev/null
  echo "smoke: --break pvc: removed $BREAK_CLAIM from the daemon Deployment and deleted the claim" >&2
}

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
    skip "working $WORK_TASK" 'it is already submitted or done on this kept cluster'
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

# Every durable event of the comma-separated kinds $1 after sequence ${2:-0}, one JSON object per line, page by page.
events_of() {
  local after="${2:-0}" page n
  while :; do
    page="$(curl -fsS "$API/v1/events?after=$after&kinds=$1&limit=500")" || return 1
    jq -c '.events[]' <<<"$page"
    n="$(jq '.events | length' <<<"$page")"
    [ "$n" -ge 500 ] || return 0
    after="$(jq '.events[-1].seq' <<<"$page")"
  done
}

# The launch events that move a launch into or out of the claimable state.
LAUNCH_KINDS=launch.claimable,launch.claimed,launch.released,launch.ended,launch.revoked,launch.failed

# The claimable launches from the API as launchId|taskId lines, sorted: a launch whose latest such event is
# launch.claimable. /v1/status lists only task ids, so it must name the same tasks.
api_claimable() {
  local events got tasks
  events="$(events_of "$LAUNCH_KINDS")" || return 1
  got="$(jq -rs 'group_by(.launchId) | map(last | select(.kind == "launch.claimable") | "\(.launchId)|\(.taskId)") | sort | .[]' <<<"$events")"
  tasks="$(status_get '.claimable | sort | .[]')" || return 1
  if [ "$(cut -d'|' -f2 <<<"$got" | sort)" != "$tasks" ]; then
    echo "    /v1/status lists claimable tasks $(tr '\n' ' ' <<<"$tasks"), the events name $(tr '\n' ' ' <<<"$got")" >&2
    return 1
  fi
  printf '%s\n' "$got"
}
# Task states from the API as id|state lines, sorted.
api_states() { status_get '[.byStatus | to_entries[] | .key as $k | .value[] | "\(.)|\($k)"] | sort | .[]'; }
# The same from Postgres: launch counts by status, claimable launches, task states.
pg_launch_counts() { psql_q "select status, count(*) from launches where run_id = '$RUN_ID' group by 1 order by 1"; }
# Claimable launches as launchId|taskId (to compare with the API) and as launchId|taskId|md5(token): a launch replaced
# by another for the same task, or given a new token, changes the line.
pg_claimable() { psql_q "select launch_id || '|' || task_id from launches where run_id = '$RUN_ID' and status = 'claimable' order by 1"; }
pg_claimable_tokens() { psql_q "select launch_id || '|' || task_id || '|' || md5(token) from launches where run_id = '$RUN_ID' and status = 'claimable' order by 1"; }
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

# Succeeds when startup recovery has dealt with every launch in $2 (launchId|... lines): each has a launch.reprepared,
# launch.ended, launch.revoked or launch.failed event after sequence $1. /readyz passes before recovery runs, and the
# claimable rows read the same until it has.
recovery_settled() {
  local done_ids id
  if [ -z "$2" ]; then echo "    no recorded claimable launch to wait for"; return 1; fi
  done_ids="$(events_of launch.reprepared,launch.ended,launch.revoked,launch.failed "$1" | jq -r '.launchId')" || return 1
  for id in $(cut -d'|' -f1 <<<"$2"); do
    grep -qxF "$id" <<<"$done_ids" || return 1
  done
  echo "    recovery events after seq $1 name every recorded claimable launch"
}

# Succeeds when the launch.reprepared events after sequence $1 name exactly the launches in $2, one event each.
reprepared_once_each() {
  local got
  got="$(events_of launch.reprepared "$1" | jq -r '.launchId' | sort)" || return 1
  echo "    launch.reprepared after seq $1: $(tr '\n' ' ' <<<"$got")"
  [ -n "$2" ] && [ "$got" = "$(cut -d'|' -f1 <<<"$2")" ]
}

# Succeeds when $1 equals the output of the function $2.
head_is() {
  local got; got="$("$2")" || return 1
  echo "    $2: $got"
  [ "$got" = "$1" ]
}

# Succeeds when $1 differs from the output of the function $2.
differs() {
  local got; got="$("$2")" || return 1
  echo "    $2: before $1, now $got"
  [ -n "$got" ] && [ "$got" != "$1" ]
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
daemon_uid() { kc get pod -l app.kubernetes.io/name=orchestrator -o jsonpath='{.items[*].metadata.uid}'; }
daemon_restarts() { kc get pod -l app.kubernetes.io/name=orchestrator -o jsonpath='{.items[0].status.containerStatuses[?(@.name=="orchestrator")].restartCount}'; }

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

# Just before the thaw: the write's curl is still running and has printed nothing, and a batch is pending.
OUTAGE_WRITE_PENDING=''
note_write_pending() {
  local alive=no out pending
  if kill -0 "$OUTAGE_WRITE_PID" 2>/dev/null; then alive=yes; fi
  out="$(cat "$OUTAGE_WRITE_OUT")"
  pending="$(status_get .storePendingBatches || echo unanswered)"
  echo "    before the thaw: write request running=$alive, its answer='$out', storePendingBatches=$pending"
  OUTAGE_WRITE_PENDING=no
  if [ "$alive" = yes ] && [ -z "$out" ] && [ "$pending" != unanswered ] && [ "$pending" -gt 0 ]; then OUTAGE_WRITE_PENDING=yes; fi
}
write_was_pending() { [ "$OUTAGE_WRITE_PENDING" = yes ]; }

# Every /readyz sample answered (200 before the lag passes one flush retry, then 503), and at least one answered 503.
readyz_503_during_outage() {
  awk 'NF == 0 { next } $1 == 503 { seen = 1 } $1 != 200 && $1 != 503 { bad = 1 } END { exit bad || !seen }' <<<"$OUTAGE_SAMPLES"
}
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

# --- The Postgres-restart drill. ---

PG_T0=0
PG_READY_S=''
PG_LAST_STATE=''
# The daemon container's last termination as "<exit code> <reason>".
daemon_last_termination() {
  kc get pod -l app.kubernetes.io/name=orchestrator -o jsonpath='{.items[0].status.containerStatuses[?(@.name=="orchestrator")].lastState.terminated.exitCode} {.items[0].status.containerStatuses[?(@.name=="orchestrator")].lastState.terminated.reason}'
}
# Succeeds when the daemon container has restarted since the count $1 was read, and records its last termination.
daemon_restarted_since() {
  local n; n="$(daemon_restarts)" || return 1
  { [ -n "$n" ] && [ "$n" -gt "$1" ]; } || return 1
  PG_LAST_STATE="$(daemon_last_termination)" || return 1
  echo "    daemon container restart count: $1 -> $n; last termination (exit code, reason): $PG_LAST_STATE"
}
# Follow the running daemon container's log into a file, in the background, from now on. The follower ends when that
# container exits, so the file ends with its last lines. `kubectl logs --previous` and lastState would describe the
# latest exit instead, which is a crash-looping start that could not reach Postgres yet, not the one that matters.
follow_daemon_log() {
  local pod; pod="$(daemon_pod)" || return 1
  PG_LOG="$(mktemp -t smoke-daemon-log.XXXXXX)"
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" logs -f "$pod" -c orchestrator --tail=0 >"$PG_LOG" 2>&1 &
  PG_LOG_PID=$!
}
daemon_log_ended() { ! kill -0 "$PG_LOG_PID" 2>/dev/null; }
# Succeeds when the daemon restarted because it lost its Postgres session. The container's last termination is exit
# code 1 with reason Error: an out-of-memory kill reads OOMKilled, and a liveness-probe kill or a SIGTERM ends in a
# clean shutdown (0) or a signal (137, 143). And the last line the exited container logged is the store's fatal exit
# with reason fenced: the session, and with it the run lock, was lost.
daemon_exited_on_lost_session() {
  local last ok=1
  retry "$PG_LOG_TIMEOUT_S" daemon_log_ended || { echo "    the log follower did not end within ${PG_LOG_TIMEOUT_S}s"; ok=0; }
  PG_LOG_PID=''
  last="$(jq -Rrc 'fromjson? | objects | "\(.msg) reason=\(.reason // "-")"' <"$PG_LOG" | tail -n 1)"
  echo "    last termination (exit code, reason): $PG_LAST_STATE; the exited container's last log line: ${last:-(none)}"
  [ "$PG_LAST_STATE" = '1 Error' ] || ok=0
  [ "$last" = 'store fatal: exiting reason=fenced' ] || ok=0
  [ "$ok" = 1 ]
}
# --break restart: stop the daemon with SIGTERM in place of deleting the Postgres pod. It shuts down cleanly, exits 0,
# and its container restarts.
stop_daemon_process() {
  kc exec "$(daemon_pod)" -c orchestrator -- sh -c 'kill -TERM 1'
  PG_T0=$(date +%s)
}
# Remove the brief of every claimable launch in $1 (launchId|... lines) from its worktree in the daemon pod. Startup
# recovery then prepares each again and records launch.reprepared, the sign that it has dealt with that launch. A
# container restart keeps the pod's emptyDir, so without this recovery would leave the worktrees alone and record nothing.
remove_parked_briefs() {
  local run_dir id
  [ -n "$1" ] || { echo "    no claimable launch to remove the brief of"; return 1; }
  run_dir="$(status_get .runDir)" || return 1
  for id in $(cut -d'|' -f1 <<<"$1"); do
    kc exec "$(daemon_pod)" -c orchestrator -- rm -f "$run_dir/worktrees/$id/.orchestrator/brief.json" || return 1
    echo "    removed $run_dir/worktrees/$id/.orchestrator/brief.json"
  done
}
# Wait until the daemon pod is Ready again and /readyz answers 200 through a new port-forward, then record how long
# it took since the old Postgres pod was gone.
daemon_ready_again() {
  kc wait --for=condition=Ready pod -l app.kubernetes.io/name=orchestrator --timeout=5s >/dev/null 2>&1 || return 1
  forward >/dev/null 2>&1 || return 1
  readyz_ok || return 1
  PG_READY_S=$(( $(date +%s) - PG_T0 ))
}
# Retry daemon_ready_again for at most PG_READY_TIMEOUT_S seconds from the moment the old Postgres pod was gone.
ready_within_limit() {
  local left=$(( PG_READY_TIMEOUT_S - ($(date +%s) - PG_T0) ))
  if [ "$left" -lt 1 ]; then left=1; fi
  retry "$left" daemon_ready_again || { echo "    not ready ${PG_READY_TIMEOUT_S}s after Postgres was gone"; return 1; }
  echo "    the daemon was ready ${PG_READY_S}s after the old Postgres pod was gone (limit ${PG_READY_TIMEOUT_S}s)"
  [ "$PG_READY_S" -le "$PG_READY_TIMEOUT_S" ]
}
# Delete the Postgres instance pod and wait until it is gone. CloudNativePG's smart shutdown waits for open sessions,
# the daemon's included, for up to the Cluster's smartShutdownTimeout (180s by default) before it stops Postgres.
delete_postgres_pod() {
  local pod t; pod="$(postgres_pod)"
  t=$(date +%s)
  kc delete pod "$pod" --wait=true
  PG_T0=$(date +%s)
  echo "    the Postgres pod $pod took $((PG_T0 - t))s to shut down"
}

# --- The last check: the recorded claimable launch still hands out the recorded launch id and token. ---

# Claim $PARKED_TASK and succeed when the claim names a launch recorded before the first restart, with the token
# recorded for it (compared by md5 in Postgres). The launch is released again afterwards.
claim_returns_recorded_launch() {
  local claim launch token hash ok=1
  claim="$(curl -fsS -X POST -H 'content-type: application/json' \
    --data "{\"workerId\":\"$WORKER_ID-final\",\"taskId\":\"$PARKED_TASK\"}" "$API/v1/claims")" || return 1
  launch="$(jq -er .launchId <<<"$claim")"; token="$(jq -er .token <<<"$claim")"
  case "$token" in *[!0-9A-Za-z_-]*) echo "    unexpected token characters"; ok=0 ;; esac
  hash="$(psql_q "select md5('$token')")" || ok=0
  echo "    the claim returned launch $launch with token md5 $hash"
  grep -qxF "$launch|$PARKED_TASK|$hash" <<<"$PG_TOKENS0" || ok=0
  curl -fsS -o /dev/null -X POST -H 'content-type: application/json' --data '{"reason":"deploy/smoke.sh final claim check"}' \
    "$API/v1/launches/$launch/release" || true
  [ "$ok" = 1 ]
}

if [ "$FRESH" = 1 ]; then
  # 0. Start from an empty kind cluster; kind switches the current context, so put the previous one back.
  step save_context
  step kind delete cluster --name "$KIND_CLUSTER"
  step kind create cluster --name "$KIND_CLUSTER"
  step restore_context
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

# M2: the daemon pod has no volume backed by a claim.
check 'M2: the daemon pod mounts no volume claim' daemon_mounts_no_claim

# M2 restart drill. Run the graph until one task is published and one launch is claimable.
step retry "$STATUS_TIMEOUT_S" status_is "(.claimable | index(\"$WORK_TASK\")) or (.byStatus.done + .byStatus.submitted | index(\"$WORK_TASK\"))"
step work_one_task
check "drill: $WORK_TASK published" retry "$PUBLISH_TIMEOUT_S" status_is ".byStatus.done | index(\"$WORK_TASK\")"
check "drill: $PARKED_TASK claimable" retry "$STATUS_TIMEOUT_S" status_is ".claimable | index(\"$PARKED_TASK\")"

if [ "$BREAK" = pvc ]; then
  # Before the snapshot: the patch rolls the daemon once, and the drill below restarts it once more.
  # The snapshot waits for that rollout's recovery, so its launch.reprepared events fall before the recorded sequence.
  echo "smoke: --break pvc: mounting a claim named $BREAK_CLAIM into the daemon pod"
  BREAK_SEQ=0 BREAK_LAUNCHES=''
  if [ "$DRY_RUN" = 0 ]; then BREAK_SEQ="$(status_get .latestSeq)"; BREAK_LAUNCHES="$(api_claimable)"; fi
  step mount_break_claim
  step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout status deployment/orchestrator --timeout="$ROLLOUT_TIMEOUT"
  step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" wait --for=condition=Ready pod -l app.kubernetes.io/name=orchestrator --timeout="$ROLLOUT_TIMEOUT"
  forward
  step retry "$STATUS_TIMEOUT_S" recovery_settled "$BREAK_SEQ" "$BREAK_LAUNCHES"
  step retry "$STATUS_TIMEOUT_S" status_is ".claimable | index(\"$PARKED_TASK\")"
fi

# Record the claimable launches, the task states and the integration head from the API, and the launches from Postgres.
RUN_ID=dry-run GRAPH_REV=unknown SEQ0=0 HEAD0=dry-run UID0=dry-run
API_CLAIMABLE0='' API_STATES0='' PG_COUNTS0='' PG_CLAIMABLE0='' PG_TOKENS0='' PG_STATES0=''
if [ "$DRY_RUN" = 0 ]; then
  RUN_ID="$(basename "$(status_get .runDir)")"
  GRAPH_REV="$(status_get .graphRev)"
  # latestSeq is the durable sequence number: the restarted daemon serves the same events below it.
  SEQ0="$(status_get .latestSeq)"
  HEAD0="$(published_sha "$WORK_TASK")"
  UID0="$(daemon_uid)"
  API_CLAIMABLE0="$(api_claimable)"
  API_STATES0="$(api_states)"
  PG_COUNTS0="$(pg_launch_counts)"
  PG_CLAIMABLE0="$(pg_claimable)"
  PG_TOKENS0="$(pg_claimable_tokens)"
  PG_STATES0="$(pg_states)"
  echo "smoke: before the restart: run $RUN_ID, graph $GRAPH_REV, latest seq $SEQ0, integration head $HEAD0, daemon pod $UID0"
  echo "    claimable launches (API): $(tr '\n' ' ' <<<"$API_CLAIMABLE0")"
  echo "    claimable launches with token md5 (psql): $(tr '\n' ' ' <<<"$PG_TOKENS0")"
  echo "    task states (API): $(tr '\n' ' ' <<<"$API_STATES0")"
  echo "    launches by status (psql): $(tr '\n' ' ' <<<"$PG_COUNTS0")"
fi
check 'drill: API and psql agree on the claimable launches before the restart' same "$API_CLAIMABLE0" pg_claimable
check 'drill: API and psql agree on the task states before the restart' same "$API_STATES0" pg_states

if [ "$BREAK" = claimable ]; then
  echo "smoke: --break claimable: claiming $PARKED_TASK's parked launch before the restart"
  step curl -fsS -o /dev/null -X POST -H 'content-type: application/json' --data "{\"workerId\":\"$WORKER_ID-break\",\"taskId\":\"$PARKED_TASK\"}" "$API/v1/claims"
fi

# Delete the daemon pod and wait for its replacement: a fresh clone and an empty run directory.
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" delete pod -l app.kubernetes.io/name=orchestrator --wait=true
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout status deployment/orchestrator --timeout="$ROLLOUT_TIMEOUT"
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" wait --for=condition=Ready pod -l app.kubernetes.io/name=orchestrator --timeout="$ROLLOUT_TIMEOUT"
forward
check 'drill: a new daemon pod' differs "$UID0" daemon_uid
check 'drill: the same accepted graph and a claimable launch after the restart' retry "$STATUS_TIMEOUT_S" status_is ".graphRev == \"$GRAPH_REV\" and (.claimable | length > 0)"
check 'drill: startup recovery settled every recorded claimable launch' retry "$STATUS_TIMEOUT_S" recovery_settled "$SEQ0" "$PG_CLAIMABLE0"

check 'drill: claimable set unchanged (API)' same "$API_CLAIMABLE0" api_claimable
check 'drill: claimable set unchanged (psql)' same "$PG_TOKENS0" pg_claimable_tokens
check 'drill: task states unchanged (API)' same "$API_STATES0" api_states
check 'drill: task states unchanged (psql)' same "$PG_STATES0" pg_states
check 'drill: launches by status unchanged (psql)' same "$PG_COUNTS0" pg_launch_counts
check 'drill: integration head equals origin main' head_is "$HEAD0" origin_head
check "drill: the daemon's clone is at origin's head" head_is "$HEAD0" clone_head
check "drill: origin main carries $WORK_TASK's Orchestrator-Task commit" origin_carries_task "$WORK_TASK"
check 'drill: one launch.reprepared per claimable launch' reprepared_once_each "$SEQ0" "$PG_CLAIMABLE0"
check 'drill: the daemon pod mounts no volume claim' daemon_mounts_no_claim

# M2 Postgres-outage drill: freeze Postgres for $OUTAGE_S seconds with a write pending. /readyz answers 503,
# /v1/status still answers with storeLagMs rising; after the thaw the lag returns to zero and the daemon has not restarted.
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
step note_write_pending
step thaw_postgres "$PGPOD"
check 'outage: the write was pending while Postgres was stopped' write_was_pending
check 'outage: /readyz answered 503 while Postgres was stopped' readyz_503_during_outage
check 'outage: /v1/status answered while Postgres was stopped' status_answered_during_outage
check 'outage: storeLagMs rose while Postgres was stopped' lag_rose_during_outage
check 'outage: the lag returned to zero after the restore' retry 120 lag_is_zero
check 'outage: /readyz passes again' retry 60 readyz_ok
if [ "$DRY_RUN" = 0 ]; then wait "$OUTAGE_WRITE_PID" || true; OUTAGE_WRITE_PID=''; fi
check 'outage: the pending write completed' outage_write_completed
check 'outage: the daemon did not restart' same "$IDENTITY0" daemon_identity
if [ "$DRY_RUN" = 0 ]; then rm -f "$OUTAGE_WRITE_OUT"; fi

# M2 Postgres-restart drill: delete the Postgres pod. The daemon loses its session and the run lock, exits, and its
# container restarts until Postgres is back; it then takes the lock again, recovers, and serves the same state.
PG_LAUNCHES1='' PG_STATES1='' API_CLAIMABLE1='' API_STATES1='' RESTARTS1=0 UID1=dry-run SEQ1=0
if [ "$DRY_RUN" = 0 ]; then
  SEQ1="$(status_get .latestSeq)"
  API_CLAIMABLE1="$(api_claimable)"
  API_STATES1="$(api_states)"
  PG_LAUNCHES1="$(pg_claimable_tokens)"
  PG_STATES1="$(pg_states)"
  RESTARTS1="$(daemon_restarts)"
  UID1="$(daemon_uid)"
  echo "smoke: before the Postgres restart: daemon pod $UID1 with $RESTARTS1 restarts, latest seq $SEQ1"
  echo "    claimable launches with token md5 (psql): $(tr '\n' ' ' <<<"$PG_LAUNCHES1")"
fi
step remove_parked_briefs "$PG_LAUNCHES1"
step follow_daemon_log
if [ "$BREAK" = restart ]; then
  echo "smoke: --break restart: stopping the daemon with SIGTERM in place of deleting the Postgres pod"
  skip delete_postgres_pod '--break restart stops the daemon instead'
  step stop_daemon_process
else
  step delete_postgres_pod
fi
check 'pg-restart: the daemon container restarted' retry "$PG_EXIT_TIMEOUT_S" daemon_restarted_since "$RESTARTS1"
check 'pg-restart: the daemon exited because its Postgres session was lost' daemon_exited_on_lost_session
check "pg-restart: the daemon is ready again within ${PG_READY_TIMEOUT_S}s of Postgres going away" ready_within_limit
check 'pg-restart: startup recovery prepared every claimable launch again' retry "$STATUS_TIMEOUT_S" recovery_settled "$SEQ1" "$PG_LAUNCHES1"
check 'pg-restart: one launch.reprepared per claimable launch' reprepared_once_each "$SEQ1" "$PG_LAUNCHES1"
check 'pg-restart: the same daemon pod (its container restarted)' same "$UID1" daemon_uid
check 'pg-restart: claimable set unchanged (API)' same "$API_CLAIMABLE1" api_claimable
check 'pg-restart: claimable set unchanged (psql)' same "$PG_LAUNCHES1" pg_claimable_tokens
check 'pg-restart: task states unchanged (API)' same "$API_STATES1" api_states
check 'pg-restart: task states unchanged (psql)' same "$PG_STATES1" pg_states

# Across both restarts a claim of the parked task hands out the launch id and token recorded before the first one.
check "final: a claim of $PARKED_TASK returns the recorded launch id and token" claim_returns_recorded_launch

if [ "$DRY_RUN" = 1 ]; then echo "smoke: dry run, nothing executed"; else echo "smoke: ok"; fi
