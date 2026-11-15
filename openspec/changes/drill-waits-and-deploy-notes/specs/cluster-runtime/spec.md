## MODIFIED Requirements

### Requirement: Smoke test
`deploy/smoke.sh` SHALL be executable in git, start with `set -euo pipefail`, and in order: build the image, load it into the kind cluster `KIND_CLUSTER` (default `orch`), install the CloudNativePG operator from `CNPG_MANIFEST` and wait for it, apply `deploy/overlays/kind`, wait for `cluster/postgres`, `git-origin` and `orchestrator`, port-forward the Service to `127.0.0.1:$LOCAL_PORT` (default 18080, stepping to the next free port when `LOCAL_PORT` is unset and the default is held) and wait for `/healthz`, send the overlay's `graph.yaml` with `PUT /v1/graph`, and poll `/v1/status` until the assertions hold or `STATUS_TIMEOUT_S` elapses. Every `kubectl` call that talks to a cluster SHALL pass `--context "$KUBE_CONTEXT"`. `KUBE_CONTEXT` defaults to `kind-$KIND_CLUSTER`; any other value SHALL exit 2 before any step. The script SHALL leave the current kubectl context as it found it. Under `--fresh`, `kind create cluster` changes it, so the script SHALL restore the previous context, or unset it if none was set, with `kubectl config` calls that carry no `--context`. The accepted arguments are `--dry-run`, `--fresh` and `--break pvc|claimable|restart` (see "Smoke test options"); `--dry-run` SHALL print each step, execute nothing, and exit 0; any other argument SHALL exit 2 with usage. M1 asserts pull mode and a claimable launch. M2 asserts that the daemon pod has no volume backed by a claim, then runs the restart, outage and Postgres-restart drills.

#### Scenario: Dry run prints the steps in order
- **WHEN** `deploy/smoke.sh --dry-run` runs with every tool stubbed out
- **THEN** it prints the build, load, operator install, apply, waits, port-forward, graph upload, M1 poll, claim check, pod deletion and M2 poll in that order, executes nothing, and exits 0

#### Scenario: No daemon claim
- **WHEN** `deploy/smoke.sh` has run against a cluster
- **THEN** no volume of the daemon pod is a `persistentVolumeClaim` or `ephemeral` volume, whatever the claim is named

#### Scenario: Cluster name is honoured
- **WHEN** `KIND_CLUSTER=dev deploy/smoke.sh --dry-run` runs
- **THEN** the load step names `--name dev` and every `kubectl` step carries `--context kind-dev`

#### Scenario: Context and cluster disagree
- **WHEN** `KIND_CLUSTER=dev KUBE_CONTEXT=kind-orch deploy/smoke.sh --dry-run` runs
- **THEN** it names both values on stderr and exits 2 without printing a step

#### Scenario: Fresh cluster restores the context
- **WHEN** `deploy/smoke.sh --fresh` runs while the current context is `prod`
- **THEN** `kubectl config use-context prod` runs right after `kind create cluster`; with no current context, `kubectl config unset current-context` runs instead

#### Scenario: Unknown argument
- **WHEN** `deploy/smoke.sh --verbose` runs
- **THEN** it prints usage to stderr and exits 2

### Requirement: Smoke worker step
The kind overlay's graph SHALL hold one ready task, `SMOKE`, and `SMOKE-PARKED`, which depends on it. `deploy/smoke.sh` SHALL work `SMOKE` as a pull-mode worker: claim its launch, commit in the pod's worktree with `kubectl exec`, and submit with the launch token. It SHALL then wait until `SMOKE` is done and `SMOKE-PARKED` is claimable.

#### Scenario: One published, one parked
- **WHEN** the worker step and the waits have passed
- **THEN** `/v1/status` lists `SMOKE` in `byStatus.done` and `SMOKE-PARKED` in `claimable`

#### Scenario: A rerun on a kept cluster
- **WHEN** the script runs again against a cluster where `SMOKE` is already done
- **THEN** it skips the worker step, printing `smoke: skip: working SMOKE` with the reason, and runs the drill against the existing run

### Requirement: Smoke assertions are named
Every assertion in `deploy/smoke.sh` SHALL print `smoke: pass: <name>` when it holds. The first assertion that does not hold SHALL print `smoke: FAIL: <name>` to stderr, and the script SHALL exit 1. A full pass SHALL end with `smoke: ok`. Under `--dry-run`, an assertion SHALL print its command and run nothing. No assertion or step SHALL be skipped silently: one that does not run SHALL print `smoke: skip: <name> (<why>)` on stdout. No environment variable SHALL turn an assertion off.

#### Scenario: A false assertion fails the run
- **WHEN** a restart-drill assertion does not hold
- **THEN** the script prints `smoke: FAIL:` with that assertion's name and exits 1 without running later steps

#### Scenario: A dry run says what it skips
- **WHEN** `deploy/smoke.sh --dry-run` runs
- **THEN** every assertion's command is followed by `smoke: skip: <its name> (dry run: nothing is executed)`, and stderr stays empty

### Requirement: Smoke test options
Besides `--dry-run`, `deploy/smoke.sh` SHALL accept two options. `--fresh` saves the current kubectl context, deletes and recreates the kind cluster `KIND_CLUSTER` before the first step, and restores the saved context. `--break pvc` creates a claim named `data-smoke-break`, mounts it into the daemon container by patching the Deployment, waits for that rollout's recovery, and only then records the restart-drill snapshot; on exit it removes the volume and mount from the Deployment and deletes the claim. `--break claimable` claims `SMOKE-PARKED`'s launch after the snapshot and before the restart. `--break restart` sends SIGTERM to the daemon process in place of deleting the Postgres pod, so the daemon's container restarts for a reason other than a lost session, and prints a skip line for the deletion. Each `--break` value SHALL fail its drill at its own named assertion, every assertion before it passing. Any other argument, or any other `--break` value, SHALL exit 2 with usage.

#### Scenario: Breaking the claim assertion
- **WHEN** `deploy/smoke.sh --break pvc` runs against a cluster
- **THEN** it prints `smoke: FAIL: drill: the daemon pod mounts no volume claim` and exits 1, and the Deployment carries no `data-smoke-break` volume afterwards

#### Scenario: Breaking the claimable set
- **WHEN** `deploy/smoke.sh --break claimable` runs against a cluster
- **THEN** it prints `smoke: FAIL: drill: claimable set unchanged (API)` and exits 1

#### Scenario: Breaking the restart reason
- **WHEN** `deploy/smoke.sh --break restart` runs against a cluster
- **THEN** `pg-restart: the daemon container restarted` passes, and the script prints `smoke: FAIL: pg-restart: the daemon exited because its Postgres session was lost` and exits 1

#### Scenario: Unknown break
- **WHEN** `deploy/smoke.sh --break nothing` runs
- **THEN** it prints usage to stderr and exits 2

### Requirement: Deployment run id
The reference manifests SHALL set no fixed run id: neither `store.runId` in the ConfigMap nor `ORCH_RUN_ID` on the daemon. Each deployment SHALL get its id from its clone's origin (`REPO_URL`, with `git.pushIntegration` on). `deploy/README.md` SHALL state the order in which the id is chosen, its format, and when to set `store.runId` or `ORCH_RUN_ID`. It SHALL also state that an origin hash follows the URL as written apart from user information, give spellings of one repository that yield different run ids (with and without `.git`, with a trailing slash, scp-like against `ssh://`), and name `store.runId` and `ORCH_RUN_ID` as the way to pin the id. `deploy/smoke.sh` SHALL read the run id from `/v1/status`.

#### Scenario: Base manifest
- **WHEN** the base is rendered
- **THEN** the ConfigMap's `store` block is `{kind: postgres, flushDeadlineMs}` without `runId` or `url`, and the daemon container has no `ORCH_RUN_ID`

#### Scenario: Two deployments on one database
- **WHEN** two deployments of the manifest clone different repositories and use one Postgres database
- **THEN** their run ids differ, because each id is the hash of its own origin

#### Scenario: Two spellings of one origin
- **WHEN** one deployment's `REPO_URL` is `https://host/x.git` and a later one's is `https://host/x`, on one database, with no `store.runId` or `ORCH_RUN_ID`
- **THEN** they are two runs, as `deploy/README.md` states, and setting `store.runId` or `ORCH_RUN_ID` to one id makes them one

### Requirement: Smoke Postgres-restart drill
After the outage drill, `deploy/smoke.sh` SHALL record `latestSeq`, the claimable launches and task states, the daemon pod's uid and its restart count. A container restart keeps the pod's `emptyDir`, so startup recovery would leave the parked worktrees alone and record nothing; the script SHALL therefore remove `.orchestrator/brief.json` from each recorded claimable launch's worktree in the pod, so that recovery prepares each again and records `launch.reprepared`. It SHALL start following the daemon container's log into a file, and then delete the Postgres instance pod. The daemon SHALL be seen to exit before readiness is awaited, because the pod is still Ready just after the deletion. The comparisons SHALL wait on conditions with timeouts, never on a fixed sleep.

#### Scenario: The daemon exits on the lost session
- **WHEN** the old Postgres pod is gone (`kubectl delete pod --wait=true` has returned, after CloudNativePG's smart shutdown)
- **THEN** within `PG_EXIT_TIMEOUT_S` (default 60) seconds the daemon container's restart count is above the recorded one

#### Scenario: The restart reason is the lost session
- **WHEN** the restart has been seen
- **THEN** the container's last termination read at that moment is exit code 1 with reason `Error`, and the last line the exited container logged (from the log followed since before the deletion, which ends when that container exits) is `store fatal: exiting` with `reason: fenced`; any other termination or last line, such as an out-of-memory kill, a probe kill or a clean SIGTERM shutdown, fails the assertion

#### Scenario: Ready again within a stated time
- **WHEN** the daemon has exited
- **THEN** within `PG_READY_TIMEOUT_S` (default 120) seconds of the old Postgres pod being gone, the daemon pod is Ready and `/readyz` answers 200 through a new port-forward

#### Scenario: Recovery has finished before the comparison
- **WHEN** `/readyz` answers 200 again
- **THEN** within `STATUS_TIMEOUT_S` the events after the recorded sequence hold a `launch.reprepared` for every recorded claimable launch, exactly one each, and only then are the states compared

#### Scenario: Same state after the Postgres restart
- **WHEN** recovery has prepared every recorded claimable launch again
- **THEN** the daemon pod's uid is the recorded one, and the claimable launches (launch id and task id from the API; launch id, task id and token md5 from `psql`) and the task states from both equal the recorded ones

#### Scenario: The parked launch keeps its id and token
- **WHEN** all three drills have passed
- **THEN** a claim of `SMOKE-PARKED` returns a launch id and a token whose md5 match a claimable launch recorded before the first restart, and the script releases that launch again
