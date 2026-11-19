## 1. Script

- [x] 1.1 `finished_run_check` in `deploy/smoke.sh`, called before the `--fresh` block; its skip line under `--fresh`
- [x] 1.2 Move the local-port probe below the check

## 2. Tests

- [x] 2.1 `test/host/smoke.test.ts`: dry run (first step, `--fresh` skip line) and stub runs (finished, finished with `--real-agent`, unfinished, failing read, non-JSON body)

## 3. Docs

- [x] 3.1 `deploy/README.md` "Smoke test": the rerun rule; the worker step's kept-cluster skip line applies to an unfinished run

## 4. Cluster

- [x] 4.1 A full `deploy/smoke.sh --fresh` pass, then `deploy/smoke.sh` on the same cluster exits 2 with the cluster unchanged
