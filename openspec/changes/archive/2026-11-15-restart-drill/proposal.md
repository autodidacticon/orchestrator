## Why

M2's claim is that the daemon keeps no state of its own: a pod deleted mid-run comes back on a fresh clone and an empty run directory and carries on from Postgres and origin, and a short Postgres outage costs readiness, not the process. Until now the smoke test checked only that the restarted pod served the same `graphRev` with some claimable launch. It never published a task, never compared the state before and after, and never took Postgres away.

## What Changes

- **The smoke graph has two tasks.** `SMOKE` is worked by the script itself, which claims it, commits in the pod's worktree with `kubectl exec`, and submits. The in-pod verifier then publishes it to origin. `SMOKE-PARKED` depends on `SMOKE`, so it is parked once `SMOKE` is published. It is never claimed, and the overlay still has exactly one ready task.
- **Restart drill.** Once `SMOKE` is published and `SMOKE-PARKED` is claimable, the script records a snapshot from the API: the claimable set, the task states, the latest event sequence, and the integration head (the `publishedSha` of `SMOKE`'s `transition` to `done`). It also records, through `psql` on the CloudNativePG pod, the launch counts by status for the run (`select status, count(*) from launches where run_id = ... group by 1`), the claimable launches, and the task states. It then deletes the daemon pod and waits for the rollout. Afterwards it asserts the following:
  - the claimable set and the task states are unchanged, from both the API and `psql`;
  - the launch counts are unchanged;
  - origin's `main` and the new pod's clone are at the recorded head, and origin's history carries the `Orchestrator-Task: SMOKE` trailer commit;
  - the events after the recorded sequence hold exactly one `launch.reprepared` per claimable launch;
  - `kubectl get pvc` lists no orchestrator claim.
- **Postgres-outage drill.** The script freezes every `postgres` process of the instance pod with SIGSTOP for `OUTAGE_S` seconds (default 10), with one write pending. During the freeze, `/readyz` must fail and `/v1/status` must still answer, with `storeLagMs` rising. After SIGCONT, the lag must return to zero, `/readyz` must pass, the pending write must complete, and the daemon pod's uid and restart count must be unchanged.
- **Named assertions.** Each assertion prints `smoke: pass: <name>`; the first false one prints `smoke: FAIL: <name>` and the script exits 1.
- **Options.** `--fresh` recreates the kind cluster first. `--break pvc|claimable` falsifies one restart-drill assertion on purpose, to show that the script fails.

The outage is a freeze, not scale-to-zero or a NetworkPolicy. The journal sink treats a lost session as fatal and never reconnects (state-backend "Fatal flush"), so scaling the cluster to zero restarts the daemon by design. kindnet's NetworkPolicy enforcement checks only new connections, so a policy leaves the open session untouched and nothing stalls; this was tried on the cluster. A freeze keeps the TCP session open and stops every reply. CloudNativePG's liveness probe (3 × 10s) restarts a Postgres that stays frozen for about 30s, so the default freeze stays well under that.

## Capabilities

### Modified Capabilities
- `cluster-runtime`: the smoke script's M2 restart drill, Postgres-outage drill, named assertions, and the `--fresh` and `--break` options (ADDED requirements beside the "Smoke test" requirement that store-selection modifies).

## Impact

- `deploy/smoke.sh`: the worker step, the snapshot, the drills, `check` and the new options.
- `deploy/overlays/kind/graph.yaml`: the `SMOKE-PARKED` task, which depends on `SMOKE`.
- `deploy/README.md`: the Smoke test section.
- No source change. `test/host/smoke.test.ts` still passes unchanged: the dry run keeps the steps it checks in order.
