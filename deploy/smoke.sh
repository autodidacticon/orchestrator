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
#   deploy/smoke.sh --real-agent KEY_FILE
#                                  also run the real-agent step last: Claude workers with the Anthropic key in KEY_FILE
#                                  (a regular file outside the repository) work SMOKE-REAL on the run's default model
#
# Every assertion prints "smoke: pass: <name>" when it holds; the first that does not prints "smoke: FAIL: <name>" and
# the script exits 1. An assertion or step that does not run prints "smoke: skip: <name> (<why>)".

usage() { echo "usage: $0 [--dry-run] [--fresh] [--break pvc|claimable|restart] [--real-agent <key file>]" >&2; exit 2; }

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
# The task one worker pod works until it is published, and the task whose launch stays parked through the drills.
WORK_TASK=SMOKE
PARKED_TASK=SMOKE-PARKED
# The tasks the worker Deployment works after the drills, with PARKED_TASK. Every smoke task, for the M3 assertions.
M3_TASKS='SMOKE-M3-A SMOKE-M3-B'
ALL_TASKS="$WORK_TASK $PARKED_TASK $M3_TASKS"
WORKER_ID=smoke
# The pod that works WORK_TASK: orchestrator-worker with ORCH_WORKER_TASK and ORCH_WORKER_MAX_LAUNCHES=1.
SMOKE_WORKER_POD=smoke-worker
# The daemon's Service URL inside the cluster, as deploy/base/worker.yaml names it.
DAEMON_URL=http://orchestrator.orch.svc:8080
# How long the worker Deployment may take to finish the run once it is scaled up.
FINISH_TIMEOUT_S="${FINISH_TIMEOUT_S:-600}"
# --break pvc: a claim whose name does not mention the orchestrator, mounted into the daemon pod.
BREAK_CLAIM=data-smoke-break
# The run's access (runner.access in the kind overlay's orchestrator.yaml). Startup recovery prepares a local parked
# launch's lost worktree again; a remote parked launch has no worktree on the daemon and is kept as it is.
RUN_ACCESS="$(sed -n 's/^  access: *\([a-z]*\).*/\1/p' "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/overlays/kind/orchestrator.yaml" | head -n1)"
RUN_ACCESS="${RUN_ACCESS:-local}"

DRY_RUN=0
FRESH=0
BREAK=''
# --real-agent: the key file's absolute path. The file is read only by the real-agent step, never under --dry-run.
REAL_AGENT_KEY=''
# The repository root as a physical path, for the key file rule: the key must not live inside the repository.
REPO_PHYS="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --fresh) FRESH=1 ;;
    --break)
      BREAK="${2:-}"; shift || true
      case "$BREAK" in pvc | claimable | restart) ;; *) usage ;; esac
      ;;
    --real-agent)
      REAL_AGENT_KEY="${2:-}"; shift || true
      if [ -z "$REAL_AGENT_KEY" ]; then echo "smoke: --real-agent needs the path of a file that holds the Anthropic key" >&2; exit 2; fi
      # Read against the caller's working directory, before the script changes directory.
      case "$REAL_AGENT_KEY" in /*) ;; *) REAL_AGENT_KEY="$PWD/$REAL_AGENT_KEY" ;; esac
      if [ -L "$REAL_AGENT_KEY" ] || [ ! -f "$REAL_AGENT_KEY" ] || [ ! -r "$REAL_AGENT_KEY" ]; then
        echo "smoke: --real-agent $REAL_AGENT_KEY is not a readable regular file (a symbolic link is refused)" >&2; exit 2
      fi
      KEY_DIR_PHYS="$(cd -P "$(dirname "$REAL_AGENT_KEY")" && pwd -P)"
      case "$KEY_DIR_PHYS/" in
        "$REPO_PHYS"/*) echo "smoke: --real-agent $REAL_AGENT_KEY is inside the repository $REPO_PHYS; keep the key file outside it" >&2; exit 2 ;;
      esac
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
WORKER_LOG_DIR='' WORKER_LOG_PIDS=''
cleanup() {
  for pid in $WORKER_LOG_PIDS; do kill "$pid" 2>/dev/null || true; done
  if [ -n "$WORKER_LOG_DIR" ]; then rm -rf "$WORKER_LOG_DIR"; fi
  if [ -n "$FROZEN" ]; then thaw_postgres "$FROZEN" || true; fi
  if [ -n "$PG_LOG_PID" ]; then kill "$PG_LOG_PID" 2>/dev/null || true; fi
  if [ -n "$PG_LOG" ]; then rm -f "$PG_LOG"; fi
  if [ -n "$OUTAGE_WRITE_PID" ]; then kill "$OUTAGE_WRITE_PID" 2>/dev/null || true; fi
  if [ -n "$PF_PID" ]; then kill "$PF_PID" 2>/dev/null || true; fi
  if [ -n "$BREAK_PATCHED" ]; then unmount_break_claim || true; fi
  # M4: a termination pod this pass started and that still exists would hold SMOKE-M3-A; delete it and wait.
  if [ -n "${TERM_STARTED:-}" ]; then
    kc delete pod "$TERM_POD" --ignore-not-found --grace-period=120 --wait=true >/dev/null 2>&1 || true
    echo "smoke: deleted the pod $TERM_POD" >&2
  fi
  # A run with --real-agent leaves no worker running, so no agent keeps spending after the script ends.
  if [ -n "$REAL_AGENT_KEY" ] && [ "$DRY_RUN" = 0 ]; then
    kc scale deployment/orchestrator-worker --replicas=0 >/dev/null 2>&1 || true
    echo "smoke: --real-agent: scaled orchestrator-worker to 0; run the next smoke on this cluster with --fresh" >&2
  fi
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

# Work $WORK_TASK with one worker pod: orchestrator-worker running the scripted agent, claiming only $WORK_TASK
# (ORCH_WORKER_TASK) and exiting after that launch (ORCH_WORKER_MAX_LAUNCHES=1). The run is remote, so the agent
# clones origin, commits on the launch branch, pushes it, and submits with its sha. The pod is kept after it exits:
# the M3 log assertion reads its log. A task already submitted or done (a rerun on a kept cluster) is left alone.
work_one_task() {
  if status_is ".byStatus.done + .byStatus.submitted | index(\"$WORK_TASK\")"; then
    skip "working $WORK_TASK" 'it is already submitted or done on this kept cluster'
    return 0
  fi
  kc delete pod "$SMOKE_WORKER_POD" --ignore-not-found --wait=true >/dev/null
  kc run "$SMOKE_WORKER_POD" --image="$IMAGE" --image-pull-policy=IfNotPresent --restart=Never \
    --labels=app.kubernetes.io/name=orchestrator-smoke-worker \
    --env="ORCH_API=$DAEMON_URL" --env=ORCH_WORKER_AGENT=scripted --env="ORCH_WORKER_TASK=$WORK_TASK" \
    --env=ORCH_WORKER_MAX_LAUNCHES=1 --env=ORCH_WORKER_CACHE=/tmp/orchestrator-cache --env="POD_NAME=$SMOKE_WORKER_POD" \
    --command -- orchestrator-worker >/dev/null
  retry "$PUBLISH_TIMEOUT_S" smoke_worker_exited || { echo "    $SMOKE_WORKER_POD did not exit within ${PUBLISH_TIMEOUT_S}s"; return 1; }
  kc logs "pod/$SMOKE_WORKER_POD" | sed 's/^/    /'
  [ "$(kc get pod "$SMOKE_WORKER_POD" -o jsonpath='{.status.phase}')" = Succeeded ] || return 1
  kc logs "pod/$SMOKE_WORKER_POD" | grep -qE "^worker [^ ]+ report accepted [^ ]+ $WORK_TASK\$"
}
smoke_worker_exited() {
  case "$(kc get pod "$SMOKE_WORKER_POD" -o jsonpath='{.status.phase}')" in Succeeded | Failed) return 0 ;; *) return 1 ;; esac
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
# The same from Postgres (the store's tables are in the schema orchestrator, store.schema's default): launch counts by status, claimable launches, task states.
pg_launch_counts() { psql_q "select status, count(*) from orchestrator.launches where run_id = '$RUN_ID' group by 1 order by 1"; }
# Claimable launches as launchId|taskId (to compare with the API) and as launchId|taskId|md5(token): a launch replaced
# by another for the same task, or given a new token, changes the line.
pg_claimable() { psql_q "select launch_id || '|' || task_id from orchestrator.launches where run_id = '$RUN_ID' and status = 'claimable' order by 1"; }
pg_claimable_tokens() { psql_q "select launch_id || '|' || task_id || '|' || md5(token) from orchestrator.launches where run_id = '$RUN_ID' and status = 'claimable' order by 1"; }
pg_states() { psql_q "select id || '|' || (entry->'status'->>'kind') from orchestrator.overlay where run_id = '$RUN_ID' order by 1"; }

# Succeeds when $2 (a function name) prints exactly $1.
same() {
  local want="$1" got; got="$("$2")" || return 1
  if [ "$got" != "$want" ]; then
    printf '    expected:\n%s\n    got:\n%s\n' "$(sed 's/^/      /' <<<"$want")" "$(sed 's/^/      /' <<<"$got")"
    return 1
  fi
  printf '%s\n' "$got" | sed 's/^/    /'
}

# Succeeds when startup recovery has dealt with every launch in $2 (launchId|... lines) recorded before sequence $1.
# Local access: each has a launch.reprepared, launch.ended, launch.revoked or launch.failed event after $1. /readyz
# passes before recovery runs, and the claimable rows read the same until it has.
# Remote access: recovery keeps a remote parked launch as it is (it has no worktree on the daemon to prepare again), so
# it records none of those events for any recorded launch. The wait is on the new daemon answering: /readyz passes,
# /v1/status serves latestSeq >= $1, and the claimable set reads consistently from the events and /v1/status. The
# unchanged launch id and token checks that follow carry the proof that each recorded launch is still parked.
recovery_settled() {
  local done_ids id latest
  if [ -z "$2" ]; then echo "    no recorded claimable launch to wait for"; return 1; fi
  done_ids="$(events_of launch.reprepared,launch.ended,launch.revoked,launch.failed "$1" | jq -r '.launchId')" || return 1
  if [ "$RUN_ACCESS" = remote ]; then
    readyz_ok || return 1
    latest="$(status_get .latestSeq)" || return 1
    [ "$latest" -ge "$1" ] || { echo "    latestSeq $latest is below the recorded seq $1"; return 1; }
    api_claimable >/dev/null || return 1
    for id in $(cut -d'|' -f1 <<<"$2"); do
      if grep -qxF "$id" <<<"$done_ids"; then echo "    remote run: recovery recorded an event for the parked launch $id after seq $1"; return 1; fi
    done
    echo "    remote run: /readyz passes, latestSeq $latest >= $1, and no launch.reprepared/ended/revoked/failed after seq $1 names a recorded claimable launch"
    return 0
  fi
  for id in $(cut -d'|' -f1 <<<"$2"); do
    grep -qxF "$id" <<<"$done_ids" || return 1
  done
  echo "    recovery events after seq $1 name every recorded claimable launch"
}

# Local access: succeeds when the launch.reprepared events after sequence $1 name exactly the launches in $2, one
# event each. Remote access: recovery never prepares a remote parked launch again, so there is no launch.reprepared
# after $1 at all (and $2 names at least one launch).
reprepared_once_each() {
  local got
  got="$(events_of launch.reprepared "$1" | jq -r '.launchId' | sort)" || return 1
  echo "    launch.reprepared after seq $1: $(tr '\n' ' ' <<<"$got")"
  if [ "$RUN_ACCESS" = remote ]; then
    echo "    remote run: expecting none for the claimable launches $(cut -d'|' -f1 <<<"$2" | tr '\n' ' ')"
    [ -n "$2" ] && [ -z "$got" ]
    return
  fi
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
    --data "{\"workerId\":\"$WORKER_ID-outage\",\"taskId\":\"$WORK_TASK-NO-SUCH-TASK\",\"access\":\"remote\"}" "$API/v1/claims"
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
# Local access: remove the brief of every claimable launch in $1 (launchId|... lines) from its worktree in the daemon pod. Startup
# recovery then prepares each again and records launch.reprepared, the sign that it has dealt with that launch. A
# container restart keeps the pod's emptyDir, so without this recovery would leave the worktrees alone and record nothing.
remove_parked_briefs() {
  local run_dir id
  [ -n "$1" ] || { echo "    no claimable launch to remove the brief of"; return 1; }
  if [ "$RUN_ACCESS" = remote ]; then echo "    remote run: a parked launch has no worktree on the daemon; nothing to remove"; return 0; fi
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

# Claim $PARKED_TASK (with access remote, the run's access) and succeed when the claim names a launch recorded before
# the first restart, with the token recorded for it (compared by md5 in Postgres). The launch is released again
# afterwards, so a worker pod works it in the M3 step.
claim_returns_recorded_launch() {
  local claim launch token hash ok=1
  claim="$(curl -fsS -X POST -H 'content-type: application/json' \
    --data "{\"workerId\":\"$WORKER_ID-final\",\"taskId\":\"$PARKED_TASK\",\"access\":\"remote\"}" "$API/v1/claims")" || return 1
  launch="$(jq -er .launchId <<<"$claim")"; token="$(jq -er .token <<<"$claim")"
  case "$token" in *[!0-9A-Za-z_-]*) echo "    unexpected token characters"; ok=0 ;; esac
  hash="$(psql_q "select md5('$token')")" || ok=0
  echo "    the claim returned launch $launch with token md5 $hash"
  grep -qxF "$launch|$PARKED_TASK|$hash" <<<"$PG_TOKENS0" || ok=0
  curl -fsS -o /dev/null -X POST -H 'content-type: application/json' --data '{"reason":"deploy/smoke.sh final claim check"}' \
    "$API/v1/launches/$launch/release" || true
  [ "$ok" = 1 ]
}

# --- M3: the worker Deployment. ---

# Follow the log of every worker pod into its own file, in the background, from each container's first line. A worker
# exits 0 once the run is finished and the Deployment restarts it, so a later `kubectl logs` would show the restarted
# container, not the one that did the work.
follow_worker_logs() {
  local pod
  WORKER_LOG_DIR="$(mktemp -d -t smoke-worker-logs.XXXXXX)"
  for pod in $(kc get pod -l app.kubernetes.io/name=orchestrator-worker -o jsonpath='{.items[*].metadata.name}'); do
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" logs -f "$pod" -c worker --tail=-1 >"$WORKER_LOG_DIR/$pod.log" 2>&1 &
    WORKER_LOG_PIDS="$WORKER_LOG_PIDS $!"
    echo "    following $pod"
  done
  [ -n "$WORKER_LOG_PIDS" ]
}
worker_logs_ended() {
  local pid
  for pid in $WORKER_LOG_PIDS; do ! kill -0 "$pid" 2>/dev/null || return 1; done
}

# Succeeds when the first-parent history of origin's main carries an Orchestrator-Task trailer for every smoke task.
origin_carries_all_tasks() {
  local tasks t ok=1; tasks="$(origin_trailer_tasks refs/heads/main)" || return 1
  echo "    Orchestrator-Task trailers on origin main: $(tr '\n' ' ' <<<"$tasks")"
  for t in $ALL_TASKS; do grep -qxF "$t" <<<"$tasks" || { echo "    missing: $t"; ok=0; }; done
  [ "$ok" = 1 ]
}

# Succeeds when the worker logs (the $SMOKE_WORKER_POD pod's and each worker pod's, followed since the scale-up) hold
# exactly one `report accepted` line for each smoke task, and none for another task.
one_accepted_report_per_task() {
  local lines counts want t
  retry "$PG_LOG_TIMEOUT_S" worker_logs_ended || { echo "    a worker log follower did not end within ${PG_LOG_TIMEOUT_S}s"; return 1; }
  WORKER_LOG_PIDS=''
  lines="$( { kc logs "pod/$SMOKE_WORKER_POD"; cat "$WORKER_LOG_DIR"/*.log; } | grep -E '^worker [^ ]+ report accepted ' )" || return 1
  printf '%s\n' "$lines" | sed 's/^/    /'
  counts="$(awk '{ print $NF }' <<<"$lines" | sort | uniq -c | awk '{ print $2 "=" $1 }' | sort)"
  want="$(for t in $ALL_TASKS; do echo "$t=1"; done | sort)"
  echo "    accepted reports per task: $(tr '\n' ' ' <<<"$counts")"
  [ "$counts" = "$want" ]
}

# --- M4: the Claude worker image, a worker pod deleted mid-task, the usage it printed, the launch trailers, and the
# real-agent step. ---

# The Claude worker image (deploy/worker-claude/Dockerfile), built FROM $IMAGE.
WORKER_IMAGE="${WORKER_IMAGE:-orchestrator-worker-claude:dev}"
# The one-shot pod that runs the CLI of that image.
CLI_POD=smoke-claude-cli
# The termination step: the pod smoke-term works TERM_TASK with a stand-in agent and is deleted mid-task.
TERM_POD=smoke-term
TERM_TASK=SMOKE-M3-A
# The stand-in agent: append a line to README.md, print a Claude result object (its last standard output, with token
# counts, so the loop posts it), then the ready marker on standard error, and sleep. It holds no $: Kubernetes expands
# $(NAME) in an environment value.
TERM_COMMAND="echo smoke-term >> README.md && echo '{\"type\":\"result\",\"total_cost_usd\":0.01,\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}' && echo smoke-term-ready >&2 && sleep 600"
TERM_SEQ=0
# The real-agent step: the task it adds to the graph and how long a real agent may take to get it done.
REAL_TASK=SMOKE-REAL
REAL_TIMEOUT_S="${REAL_TIMEOUT_S:-900}"
REAL_NAMES=("M4: the real task is done" "M4: the real task's launch cost is above zero" "M4: the real task's commit carries its Orchestrator-Launch trailer")

pod_exited() {
  case "$(kc get pod "$1" -o jsonpath='{.status.phase}')" in Succeeded | Failed) return 0 ;; *) return 1 ;; esac
}

# Run the worker image's CLI in a one-shot pod; succeeds when the pod succeeds with a non-empty log.
worker_image_runs_claude() {
  local phase log
  kc delete pod "$CLI_POD" --ignore-not-found --wait=true >/dev/null
  kc run "$CLI_POD" --image="$WORKER_IMAGE" --image-pull-policy=IfNotPresent --restart=Never \
    --command -- sh -c 'claude --version && test -w "$HOME"' >/dev/null
  retry "$STATUS_TIMEOUT_S" pod_exited "$CLI_POD" || { echo "    $CLI_POD did not exit within ${STATUS_TIMEOUT_S}s"; return 1; }
  phase="$(kc get pod "$CLI_POD" -o jsonpath='{.status.phase}')"
  log="$(kc logs "pod/$CLI_POD")" || return 1
  printf '%s\n' "$log" | sed 's/^/    /'
  echo "    $CLI_POD: $phase"
  kc delete pod "$CLI_POD" --ignore-not-found --wait=false >/dev/null
  [ "$phase" = Succeeded ] && [ -n "$log" ]
}

# Why the termination step cannot run, or nothing. A leftover smoke-term pod is deleted first (with the grace the
# worker Deployment gives, so it hands its launch back); TERM_TASK must then have a claimable launch.
TERM_SKIP=''
term_precondition() {
  kc delete pod "$TERM_POD" --ignore-not-found --grace-period=120 --wait=true >/dev/null
  if ! status_is ".claimable | index(\"$TERM_TASK\")"; then TERM_SKIP="$TERM_TASK is not claimable"; fi
}

# Start smoke-term as work_one_task starts smoke-worker, with the command agent and the stand-in as its command.
start_term_pod() {
  TERM_SEQ="$(status_get .latestSeq)"
  TERM_STARTED=1
  kc run "$TERM_POD" --image="$IMAGE" --image-pull-policy=IfNotPresent --restart=Never \
    --labels=app.kubernetes.io/name=orchestrator-smoke-worker \
    --env="ORCH_API=$DAEMON_URL" --env=ORCH_WORKER_AGENT=command --env="ORCH_WORKER_COMMAND=$TERM_COMMAND" \
    --env="ORCH_WORKER_TASK=$TERM_TASK" --env=ORCH_WORKER_MAX_LAUNCHES=1 --env=ORCH_WORKER_CACHE=/tmp/orchestrator-cache \
    --env="POD_NAME=$TERM_POD" --command -- orchestrator-worker >/dev/null
}
term_agent_printed_ready() {
  local log; log="$(kc logs "pod/$TERM_POD" 2>/dev/null)" || return 1
  grep -qx 'smoke-term-ready' <<<"$log"
}
# Wait until the stand-in agent has printed its marker (so its result object is out); print the pod's log if not.
term_agent_ready() {
  retry "$STATUS_TIMEOUT_S" term_agent_printed_ready && return 0
  echo "    $TERM_POD did not print smoke-term-ready within ${STATUS_TIMEOUT_S}s; its log:"
  kc logs "pod/$TERM_POD" 2>&1 | sed 's/^/    /' || true
  return 1
}
# Delete smoke-term mid-task with the worker Deployment's grace (120s; a kubectl run pod has 30s) and wait until it is
# gone. Its log, followed from before the deletion, shows the hand-back.
delete_term_pod() {
  local log pid
  log="$(mktemp -t smoke-term-log.XXXXXX)"
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" logs -f "pod/$TERM_POD" >"$log" 2>&1 &
  pid=$!
  kc delete pod "$TERM_POD" --grace-period=120 --wait=true >/dev/null || { kill "$pid" 2>/dev/null; rm -f "$log"; return 1; }
  TERM_STARTED=''
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  sed 's/^/    /' "$log"
  rm -f "$log"
}

# The launch.released event of TERM_TASK by smoke-term after the step started: kept, reason podTerminating, and a
# headSha that is a commit in git-origin's repository.
term_released_kept() {
  local ev sha t
  ev="$(events_of launch.released "$TERM_SEQ" | jq -c --arg t "$TERM_TASK" --arg w "$TERM_POD" 'select(.taskId == $t and .payload.workerId == $w)' | tail -n 1)" || return 1
  [ -n "$ev" ] || return 1
  echo "    $ev"
  jq -e '.payload.kept == true and .payload.reason == "podTerminating" and (.payload.headSha | type == "string")' <<<"$ev" >/dev/null || return 1
  sha="$(jq -r .payload.headSha <<<"$ev")"
  t="$(kc exec deploy/git-origin -c git-daemon -- git --git-dir=/srv/git/fixture.git cat-file -t "$sha")" || return 1
  echo "    git cat-file -t $sha in git-origin: $t"
  [ "$t" = commit ]
}

# Succeeds when /v1/status cost.byTask[$1] is above zero.
task_cost_above_zero() {
  local v; v="$(status_get ".cost.byTask[\"$1\"] // 0")" || return 1
  jq -e '. > 0' <<<"$v" >/dev/null || return 1
  echo "    cost.byTask[\"$1\"]: $v"
}

# Every first-parent commit of origin's main with an Orchestrator-Task trailer (only task $1's, when given) also has
# an Orchestrator-Launch trailer whose value is the launchId of an agent.report event of that task.
trailers_name_reported_launches() {
  local lines reports task launch seen=0 ok=1
  lines="$(kc exec deploy/git-origin -c git-daemon -- git --git-dir=/srv/git/fixture.git log --first-parent \
    --format='%(trailers:key=Orchestrator-Task,valueonly,separator=%x20) %(trailers:key=Orchestrator-Launch,valueonly,separator=%x20)' refs/heads/main)" || return 1
  reports="$(events_of agent.report | jq -r '"\(.taskId) \(.launchId)"')" || return 1
  while read -r task launch; do
    [ -n "$task" ] || continue
    if [ -n "${1:-}" ] && [ "$task" != "$1" ]; then continue; fi
    seen=1
    echo "    $task ${launch:-(no Orchestrator-Launch trailer)}"
    if [ -z "$launch" ] || ! grep -qxF "$task $launch" <<<"$reports"; then echo "    no agent.report of $task names launch ${launch:-(none)}"; ok=0; fi
  done <<<"$lines"
  [ "$seen" = 1 ] || { echo "    no commit with an Orchestrator-Task trailer${1:+ for $1}"; return 1; }
  [ "$ok" = 1 ]
}

# The Secret anthropic-api-key with the key file's content, line ends removed. The key reaches kubectl on standard input
# only; this function's name and the file's path are all that is printed.
create_key_secret() {
  tr -d '\r\n' <"$1" \
    | kc create secret generic anthropic-api-key --from-file=ANTHROPIC_API_KEY=/dev/stdin --dry-run=client -o yaml \
    | kc apply -f - >/dev/null
}
no_worker_pods() { [ -z "$(kc get pod -l app.kubernetes.io/name=orchestrator-worker -o name)" ]; }
# Send the overlay's graph followed by graph fragments ($@) with PUT /v1/graph and require it accepted.
put_graph_with() {
  cat deploy/overlays/kind/graph.yaml "$@" | jq -Rs '{content: .}' \
    | curl -fsS -X PUT -H 'content-type: application/json' --data-binary @- "$API/v1/graph" \
    | jq -e '.accepted == true' >/dev/null
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
# Every task that depends on $WORK_TASK is parked before the snapshot, so the claimable set does not grow during the drills.
step retry "$STATUS_TIMEOUT_S" status_is "[\"$PARKED_TASK\", $(printf '"%s", ' $M3_TASKS | sed 's/, $//')] - .claimable | length == 0"

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
  step curl -fsS -o /dev/null -X POST -H 'content-type: application/json' --data "{\"workerId\":\"$WORKER_ID-break\",\"taskId\":\"$PARKED_TASK\",\"access\":\"remote\"}" "$API/v1/claims"
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

# M4 block A: the Claude worker image runs its CLI; then a worker pod is deleted mid-task. It hands its launch of
# SMOKE-M3-A back with keep, and the usage its stand-in agent printed is recorded. The M3 step then works SMOKE-M3-A
# from the kept head.
step docker build -f deploy/worker-claude/Dockerfile --build-arg "PROJECT_BASE=$IMAGE" -t "$WORKER_IMAGE" deploy/worker-claude
step kind load docker-image "$WORKER_IMAGE" --name "$KIND_CLUSTER"
check 'M4: the Claude worker image runs the claude CLI' worker_image_runs_claude
step term_precondition
if [ -n "$TERM_SKIP" ]; then
  skip 'M4: deleting the worker pod mid-task releases its launch with kept true' "$TERM_SKIP"
  skip 'M4: usage printed by the terminated agent is recorded' "$TERM_SKIP"
else
  step start_term_pod
  step term_agent_ready
  step delete_term_pod
  check 'M4: deleting the worker pod mid-task releases its launch with kept true' retry "$STATUS_TIMEOUT_S" term_released_kept
  check 'M4: usage printed by the terminated agent is recorded' retry "$STATUS_TIMEOUT_S" task_cost_above_zero "$TERM_TASK"
  step retry "$STATUS_TIMEOUT_S" status_is ".claimable | index(\"$TERM_TASK\")"
fi

# M3: the worker Deployment, scaled to 2, works the parked launches: $PARKED_TASK and the M3 tasks. Each pod claims with
# access remote, clones git-origin, runs the scripted agent, pushes the launch branch and submits; the verifier publishes.
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" scale deployment/orchestrator-worker --replicas=2
step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout status deployment/orchestrator-worker --timeout="$ROLLOUT_TIMEOUT"
step follow_worker_logs
check 'M3: the run is finished' retry "$FINISH_TIMEOUT_S" status_is '.finished == true'
check "M3: every smoke task is on origin's integration branch" origin_carries_all_tasks
check 'M3: worker logs show one accepted report per task' one_accepted_report_per_task

# M4 block B: every integration commit names the launch that reported it.
check 'M4: every integration commit carries its Orchestrator-Launch trailer' trailers_name_reported_launches

# The real-agent step, only with --real-agent: Claude workers on the key work SMOKE-REAL with the run's default model.
# It is the last step and changes the worker pool (scaled to 0, then Claude workers): add later steps above it.
if [ -z "$REAL_AGENT_KEY" ]; then
  for name in "${REAL_NAMES[@]}"; do skip "$name" 'needs --real-agent'; done
else
  step create_key_secret "$REAL_AGENT_KEY"
  step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" scale deployment/orchestrator-worker --replicas=0
  step retry "$FINISH_TIMEOUT_S" no_worker_pods
  step kubectl --context "$KUBE_CONTEXT" apply -k deploy/overlays/kind-claude
  step retry 30 put_graph_with deploy/overlays/kind-claude/real-task.yaml
  step retry "$STATUS_TIMEOUT_S" status_is ".claimable | index(\"$REAL_TASK\")"
  step kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" scale deployment/orchestrator-worker --replicas=1
  check "${REAL_NAMES[0]}" retry "$REAL_TIMEOUT_S" status_is ".byStatus.done | index(\"$REAL_TASK\")"
  check "${REAL_NAMES[1]}" retry "$STATUS_TIMEOUT_S" task_cost_above_zero "$REAL_TASK"
  check "${REAL_NAMES[2]}" trailers_name_reported_launches "$REAL_TASK"
fi

if [ "$DRY_RUN" = 1 ]; then echo "smoke: dry run, nothing executed"; else echo "smoke: ok"; fi
