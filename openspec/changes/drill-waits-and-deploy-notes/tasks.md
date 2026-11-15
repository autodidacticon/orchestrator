## 1. Deployment notes

- [x] 1.1 `deploy/README.md`: the daemon's git commands do not carry the store URL; the old leak text is gone
- [x] 1.2 `deploy/README.md` "The run id": the id follows the origin URL as written apart from user information; spellings that differ and that do not; pin with `store.runId` or `ORCH_RUN_ID`

## 2. Postgres-restart drill

- [x] 2.1 Record `latestSeq`; remove the brief of each claimable launch in the pod so recovery records `launch.reprepared`
- [x] 2.2 Wait for a `launch.reprepared` per recorded claimable launch (bounded by `STATUS_TIMEOUT_S`) and assert one each; remove `SETTLE_S`
- [x] 2.3 Follow the daemon's log from before the deletion; assert last termination `1 Error` and last log line `store fatal: exiting` with `reason: fenced`
- [x] 2.4 `--break restart`: SIGTERM the daemon in place of deleting the Postgres pod; the reason assertion fails

## 3. Skip lines, docs, runs

- [x] 3.1 `smoke: skip: <name> (<why>)` for every assertion under `--dry-run`, the worker step on a kept cluster, and the deletion replaced by `--break restart`
- [x] 3.2 `deploy/README.md` Smoke test section and the script's header and usage
- [x] 3.3 Run `deploy/smoke.sh --break restart` and `deploy/smoke.sh --fresh` on kind; `openspec validate drill-waits-and-deploy-notes --strict`
