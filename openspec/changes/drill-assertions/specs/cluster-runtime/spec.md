## MODIFIED Requirements

### Requirement: Smoke test
`deploy/smoke.sh` SHALL be executable in git, start with `set -euo pipefail`, and in order: build the image, load it into the kind cluster `KIND_CLUSTER` (default `orch`), install the CloudNativePG operator from `CNPG_MANIFEST` and wait for it, apply `deploy/overlays/kind`, wait for `cluster/postgres`, `git-origin` and `orchestrator`, port-forward the Service to `127.0.0.1:$LOCAL_PORT` (default 18080, stepping to the next free port when `LOCAL_PORT` is unset and the default is held) and wait for `/healthz`, send the overlay's `graph.yaml` with `PUT /v1/graph`, and poll `/v1/status` until the assertions hold or `STATUS_TIMEOUT_S` elapses. Every `kubectl` call that talks to a cluster SHALL pass `--context "$KUBE_CONTEXT"`. `KUBE_CONTEXT` defaults to `kind-$KIND_CLUSTER`; any other value SHALL exit 2 before any step. The script SHALL leave the current kubectl context as it found it. Under `--fresh`, `kind create cluster` changes it, so the script SHALL restore the previous context, or unset it if none was set, with `kubectl config` calls that carry no `--context`. The accepted arguments are `--dry-run`, `--fresh` and `--break pvc|claimable` (see "Smoke test options"); `--dry-run` SHALL print each step, execute nothing, and exit 0; any other argument SHALL exit 2 with usage. M1 asserts pull mode and a claimable launch. M2 asserts that the daemon pod has no volume backed by a claim, then runs the restart, outage and Postgres-restart drills.

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

### Requirement: Smoke restart drill
Before deleting the daemon pod, `deploy/smoke.sh` SHALL record a snapshot. From the API it records the claimable launches as launch id and task id, the task states, `latestSeq`, the integration head (the `publishedSha` of `SMOKE`'s `transition` to `done`), and the daemon pod's uid. The API lists claimable launches by task only, so their launch ids SHALL be read from the launch events: a launch is claimable when its latest `launch.claimable`, `launch.claimed`, `launch.released`, `launch.ended`, `launch.revoked` or `launch.failed` event is `launch.claimable`, and those launches' tasks SHALL equal `/v1/status` `claimable`. Through `psql` on the CloudNativePG instance pod it records the run's launch counts by status, the claimable launches as launch id, task id and the md5 of the token, and the task states. After the rollout it SHALL wait until startup recovery has handled every recorded claimable launch (a `launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed` event for it after the recorded sequence), because `/readyz` passes before recovery runs, and only then SHALL it assert the scenarios below.

#### Scenario: A new pod
- **WHEN** the replacement pod is ready
- **THEN** its uid differs from the recorded one

#### Scenario: State survives the restart
- **WHEN** recovery has settled
- **THEN** the claimable launches (launch id and task id from the API; launch id, task id and token md5 from `psql`) and the task states equal the recorded ones, and the launch counts by status are unchanged

#### Scenario: A replaced launch fails the claimable assertion
- **WHEN** the parked launch was claimed before the restart, so recovery ends it and parks a new launch for the same task
- **THEN** `drill: claimable set unchanged (API)` fails, although the claimable task ids are the same

#### Scenario: Integration head is origin's
- **WHEN** recovery has settled
- **THEN** origin's `main` and the pod's clone are at the recorded head, and origin's history of `main` carries a commit with the `Orchestrator-Task: SMOKE` trailer

#### Scenario: Parked launches are prepared again once each
- **WHEN** recovery has settled
- **THEN** the events after the recorded sequence hold exactly one `launch.reprepared` for each claimable launch, and none for any other launch

#### Scenario: No daemon claim after the restart
- **WHEN** recovery has settled
- **THEN** no volume of the new daemon pod is backed by a claim, whatever its name

### Requirement: Smoke Postgres-outage drill
After the restart drill, `deploy/smoke.sh` SHALL stop Postgres for `OUTAGE_S` seconds (default 10) without closing the daemon's session, keep one write pending meanwhile, and sample `/readyz` and `/v1/status` once a second. It SHALL NOT scale the cluster to zero, because the journal sink treats a lost session as fatal; a real Postgres restart is the Postgres-restart drill.

#### Scenario: Postgres is frozen, not removed
- **WHEN** the outage drill starts
- **THEN** every `postgres` process of the instance pod receives SIGSTOP, and SIGCONT after `OUTAGE_S` seconds or on exit, staying under CloudNativePG's liveness window of about 30s

#### Scenario: A write is pending
- **WHEN** the last sample has been taken and Postgres is still stopped
- **THEN** the `POST /v1/claims` for a task that does not exist is still running and has answered nothing, and `storePendingBatches` is above zero

#### Scenario: Readiness fails, status answers
- **WHEN** Postgres is stopped
- **THEN** every `/readyz` sample answers 200 or 503, at least one answers 503 (no answer, `000`, does not count), every `/v1/status` sample answers, and `storeLagMs` is above zero at the first sample and rises at every later one

#### Scenario: Recovery without a restart
- **WHEN** Postgres is resumed
- **THEN** `storeLagMs` and `storePendingBatches` return to zero, `/readyz` answers 200, the pending write answers 404, and the daemon pod's uid and container restart count equal the ones recorded before the outage

### Requirement: Smoke test options
Besides `--dry-run`, `deploy/smoke.sh` SHALL accept two options. `--fresh` saves the current kubectl context, deletes and recreates the kind cluster `KIND_CLUSTER` before the first step, and restores the saved context. `--break pvc` creates a claim named `data-smoke-break`, mounts it into the daemon container by patching the Deployment, waits for that rollout's recovery, and only then records the restart-drill snapshot; on exit it removes the volume and mount from the Deployment and deletes the claim. `--break claimable` claims `SMOKE-PARKED`'s launch after the snapshot and before the restart. Each `--break` value SHALL fail the restart drill at its own named assertion, every assertion before it passing. Any other argument, or any other `--break` value, SHALL exit 2 with usage.

#### Scenario: Breaking the claim assertion
- **WHEN** `deploy/smoke.sh --break pvc` runs against a cluster
- **THEN** it prints `smoke: FAIL: drill: the daemon pod mounts no volume claim` and exits 1, and the Deployment carries no `data-smoke-break` volume afterwards

#### Scenario: Breaking the claimable set
- **WHEN** `deploy/smoke.sh --break claimable` runs against a cluster
- **THEN** it prints `smoke: FAIL: drill: claimable set unchanged (API)` and exits 1

#### Scenario: Unknown break
- **WHEN** `deploy/smoke.sh --break nothing` runs
- **THEN** it prints usage to stderr and exits 2

## ADDED Requirements

### Requirement: Smoke Postgres-restart drill
After the outage drill, `deploy/smoke.sh` SHALL record the claimable launches and task states, the daemon pod's uid and its restart count, and delete the Postgres instance pod. The daemon SHALL be seen to exit before readiness is awaited, because the pod is still Ready just after the deletion.

#### Scenario: The daemon exits on the lost session
- **WHEN** the old Postgres pod is gone (`kubectl delete pod --wait=true` has returned, after CloudNativePG's smart shutdown)
- **THEN** within `PG_EXIT_TIMEOUT_S` (default 60) seconds the daemon container's restart count is above the recorded one

#### Scenario: Ready again within a stated time
- **WHEN** the daemon has exited
- **THEN** within `PG_READY_TIMEOUT_S` (default 120) seconds of the old Postgres pod being gone, the daemon pod is Ready and `/readyz` answers 200 through a new port-forward

#### Scenario: Same state after the Postgres restart
- **WHEN** the daemon is ready again and `SETTLE_S` (default 5) seconds have passed
- **THEN** the daemon pod's uid is the recorded one, and the claimable launches (launch id and task id from the API; launch id, task id and token md5 from `psql`) and the task states from both equal the recorded ones

#### Scenario: The parked launch keeps its id and token
- **WHEN** all three drills have passed
- **THEN** a claim of `SMOKE-PARKED` returns a launch id and a token whose md5 match a claimable launch recorded before the first restart, and the script releases that launch again
