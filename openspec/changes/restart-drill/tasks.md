## 1. Smoke graph and worker step

- [x] 1.1 `deploy/overlays/kind/graph.yaml`: add `SMOKE-PARKED`, depending on `SMOKE` (the overlay keeps one ready task)
- [x] 1.2 `deploy/smoke.sh` `work_one_task`: claim `SMOKE`, commit in the pod's worktree with `kubectl exec`, submit with the launch token; skip when already submitted or done
- [x] 1.3 Wait for `SMOKE` in `byStatus.done` (`PUBLISH_TIMEOUT_S`) and `SMOKE-PARKED` claimable

## 2. Restart drill

- [x] 2.1 Snapshot: claimable set, task states, `latestSeq` and integration head (the published sha) from the API; launch counts, claimable launches and task states from `psql`
- [x] 2.2 Delete the daemon pod, wait for the rollout and readiness, forward again
- [x] 2.3 Assert the claimable set and task states (API and `psql`), the launch counts, origin's head, the clone's head, the `Orchestrator-Task: SMOKE` trailer, one `launch.reprepared` per claimable launch, and no orchestrator claim

## 3. Postgres-outage drill

- [x] 3.1 Freeze the instance's `postgres` processes (SIGSTOP) for `OUTAGE_S` seconds with one pending write, sampling `/readyz` and `/v1/status`; thaw on exit
- [x] 3.2 Assert `/readyz` failed, status answered, lag rose; then lag zero, `/readyz` passes, the write completed, and the daemon pod's uid and restart count are unchanged

## 4. Output, options, record

- [x] 4.1 `check`: `smoke: pass: <name>` per assertion, `smoke: FAIL: <name>` and exit 1 on the first false one
- [x] 4.2 `--fresh` and `--break pvc|claimable`
- [x] 4.3 `deploy/README.md` Smoke test section
- [x] 4.4 Run on a fresh kind cluster, run each `--break`, and run `openspec validate restart-drill --strict`
