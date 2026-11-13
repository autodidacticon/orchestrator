## ADDED Requirements

### Requirement: Smoke worker step
The kind overlay's graph SHALL hold one ready task, `SMOKE`, and `SMOKE-PARKED`, which depends on it. `deploy/smoke.sh` SHALL work `SMOKE` as a pull-mode worker: claim its launch, commit in the pod's worktree with `kubectl exec`, and submit with the launch token. It SHALL then wait until `SMOKE` is done and `SMOKE-PARKED` is claimable.

#### Scenario: One published, one parked
- **WHEN** the worker step and the waits have passed
- **THEN** `/v1/status` lists `SMOKE` in `byStatus.done` and `SMOKE-PARKED` in `claimable`

#### Scenario: A rerun on a kept cluster
- **WHEN** the script runs again against a cluster where `SMOKE` is already done
- **THEN** it skips the worker step and runs the drill against the existing run

### Requirement: Smoke restart drill
Before deleting the daemon pod, `deploy/smoke.sh` SHALL record a snapshot. From the API it records the claimable set, the task states, `latestSeq`, and the integration head (the `publishedSha` of `SMOKE`'s `transition` to `done`). Through `psql` on the CloudNativePG instance pod it records the run's launch counts by status, claimable launches and task states. After the rollout it SHALL assert the scenarios below.

#### Scenario: State survives the restart
- **WHEN** the new daemon pod is ready
- **THEN** the claimable set and the task states equal the recorded ones, both from `/v1/status` and from `psql`, and the launch counts by status are unchanged

#### Scenario: Integration head is origin's
- **WHEN** the new daemon pod is ready
- **THEN** origin's `main` and the pod's clone are at the recorded head, and origin's history of `main` carries a commit with the `Orchestrator-Task: SMOKE` trailer

#### Scenario: Parked launches are prepared again once each
- **WHEN** the new daemon pod is ready
- **THEN** the events after the recorded sequence hold exactly one `launch.reprepared` for each claimable launch, and none for any other launch

#### Scenario: No daemon claim after the restart
- **WHEN** the new daemon pod is ready
- **THEN** `kubectl -n orch get pvc` succeeds and lists no claim matching `orchestrator`

### Requirement: Smoke Postgres-outage drill
After the restart drill, `deploy/smoke.sh` SHALL stop Postgres for `OUTAGE_S` seconds (default 10) without closing the daemon's session, keep one write pending meanwhile, and sample `/readyz` and `/v1/status` once a second. It SHALL NOT scale the cluster to zero, because the journal sink treats a lost session as fatal.

#### Scenario: Postgres is frozen, not removed
- **WHEN** the outage drill starts
- **THEN** every `postgres` process of the instance pod receives SIGSTOP, and SIGCONT after `OUTAGE_S` seconds or on exit, staying under CloudNativePG's liveness window of about 30s

#### Scenario: A write is pending
- **WHEN** Postgres is stopped
- **THEN** a `POST /v1/claims` for a task that does not exist is in flight, its response waiting for durability

#### Scenario: Readiness fails, status answers
- **WHEN** Postgres is stopped
- **THEN** `/readyz` answers non-200 at least once, every `/v1/status` sample answers, and `storeLagMs` is above zero at the first sample and rises at every later one

#### Scenario: Recovery without a restart
- **WHEN** Postgres is resumed
- **THEN** `storeLagMs` and `storePendingBatches` return to zero, `/readyz` answers 200, the pending write answers 404, and the daemon pod's uid and container restart count equal the ones recorded before the outage

### Requirement: Smoke assertions are named
Every assertion in `deploy/smoke.sh` SHALL print `smoke: pass: <name>` when it holds. The first assertion that does not hold SHALL print `smoke: FAIL: <name>` to stderr, and the script SHALL exit 1. A full pass SHALL end with `smoke: ok`. Under `--dry-run`, an assertion SHALL print its command and run nothing.

#### Scenario: A false assertion fails the run
- **WHEN** a restart-drill assertion does not hold
- **THEN** the script prints `smoke: FAIL:` with that assertion's name and exits 1 without running later steps

### Requirement: Smoke test options
Besides `--dry-run`, `deploy/smoke.sh` SHALL accept two options. `--fresh` deletes and recreates the kind cluster `KIND_CLUSTER` before the first step. `--break pvc` creates a claim named `orchestrator-smoke-break` before the restart and deletes it on exit. `--break claimable` claims `SMOKE-PARKED`'s launch before the restart. Each `--break` value falsifies one restart-drill assertion on purpose. Any other argument, or any other `--break` value, SHALL exit 2 with usage.

#### Scenario: Breaking the claim assertion
- **WHEN** `deploy/smoke.sh --break pvc` runs against a cluster
- **THEN** it prints `smoke: FAIL: drill: no orchestrator volume claim` and exits 1

#### Scenario: Breaking the claimable set
- **WHEN** `deploy/smoke.sh --break claimable` runs against a cluster
- **THEN** it prints `smoke: FAIL:` naming a restart-drill assertion and exits 1

#### Scenario: Unknown break
- **WHEN** `deploy/smoke.sh --break nothing` runs
- **THEN** it prints usage to stderr and exits 2
