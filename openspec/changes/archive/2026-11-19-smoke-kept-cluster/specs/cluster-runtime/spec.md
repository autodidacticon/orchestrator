## ADDED Requirements

### Requirement: Smoke finished-run check
A run of `deploy/smoke.sh` without `--fresh` SHALL first read `/v1/status` of the kept cluster's daemon through the API server's Service proxy, `/api/v1/namespaces/orch/services/orchestrator:api/proxy/v1/status`, after every argument is checked and before any other step. When it answers `finished: true`, the script SHALL print one line on stderr that names `--fresh` and exit 2, having changed nothing on the cluster.

#### Scenario: A finished run is refused
- **WHEN** `deploy/smoke.sh` runs without `--fresh` against a cluster whose `/v1/status` answers `finished: true`
- **THEN** it prints one line on stderr that names `--fresh`, exits 2, and makes no `docker`, `kind` or `kubectl apply` call; the status read is its only `kubectl` call, and its EXIT cleanup does not run, so `--real-agent` scales nothing

#### Scenario: No answer or an unfinished run goes on
- **WHEN** the status read fails (no cluster, namespace or daemon) or answers a `finished` that is not `true`
- **THEN** the script goes on to the image build

#### Scenario: Fresh and dry runs
- **WHEN** the script runs with `--fresh`, or with `--dry-run`
- **THEN** with `--fresh` the check does not run and the script prints `smoke: skip: finished-run check (--fresh starts a new cluster)`; with `--dry-run` and without `--fresh` it prints `+ finished_run_check` as its first step and does not run it

## MODIFIED Requirements

### Requirement: Smoke worker step
The kind overlay's graph SHALL hold one ready task, `SMOKE`, and three independent tasks that depend on it: `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`. `deploy/smoke.sh` SHALL work `SMOKE` with one worker pod, `smoke-worker`: `orchestrator-worker` run with `ORCH_WORKER_AGENT=scripted`, `ORCH_WORKER_TASK=SMOKE` and `ORCH_WORKER_MAX_LAUNCHES=1`, which claims with `access: remote`, clones origin, commits on the launch branch, pushes it and submits with its sha. The step SHALL fail unless the pod exits with phase `Succeeded` and its log shows `report accepted` for `SMOKE`; the pod SHALL be kept for the M3 log assertion. The script SHALL then wait until `SMOKE` is done and `SMOKE-PARKED` is claimable, and then until `SMOKE-M3-A` and `SMOKE-M3-B` are claimable too, so the claimable set does not change during the drills. No claim the script makes SHALL be a local one: the outage drill's pending write, `--break claimable` and the final claim of `SMOKE-PARKED` all claim with `access: remote`.

#### Scenario: One published, one parked
- **WHEN** the worker step and the waits have passed
- **THEN** `/v1/status` lists `SMOKE` in `byStatus.done` and `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B` in `claimable`, and the `smoke-worker` pod has succeeded

#### Scenario: A rerun on a kept cluster
- **WHEN** the script runs again against a cluster whose run is unfinished and where `SMOKE` is already done
- **THEN** it skips the worker step, printing `smoke: skip: working SMOKE` with the reason, and runs the drill against the existing run
