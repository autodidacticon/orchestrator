## 1. Restart drill

- [x] 1.1 Claimable launches by launch id from the events (API) and launch id, task id, token md5 (`psql`)
- [x] 1.2 Assert a new daemon pod uid
- [x] 1.3 Wait for startup recovery to settle every recorded claimable launch before the comparisons and the `launch.reprepared` count
- [x] 1.4 Volume check on the daemon pod's volumes; `--break pvc` mounts `data-smoke-break` before the snapshot and removes it on exit

## 2. Outage drill

- [x] 2.1 Before the thaw: the write is still running, unanswered, and a batch is pending
- [x] 2.2 `/readyz` answers 503 at least once, and only 200 or 503

## 3. Postgres-restart drill

- [x] 3.1 Delete the Postgres pod; assert the daemon container restarts, then Ready and `/readyz` 200 within `PG_READY_TIMEOUT_S`
- [x] 3.2 Same pod, same claimable launches and task states (API and `psql`)
- [x] 3.3 Final claim of `SMOKE-PARKED` returns the recorded launch id and token, then releases it

## 4. Context, docs, tests

- [x] 4.1 `--fresh` saves and restores the current context; `KUBE_CONTEXT` other than `kind-$KIND_CLUSTER` exits 2
- [x] 4.2 `deploy/README.md` Smoke test section
- [x] 4.3 `test/host/smoke.test.ts`: new steps, context mismatch, `--fresh` dry run, unknown `--break`
- [x] 4.4 Run `deploy/smoke.sh --fresh`, `--break pvc` and `--break claimable` on kind; `openspec validate drill-assertions --strict`
