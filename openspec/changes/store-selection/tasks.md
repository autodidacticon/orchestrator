## 1. Store selection

- [x] 1.1 `src/config.ts`: the `store` block, `withStoreEnv` (`DATABASE_URL`), `redactUrl`, `urlSecrets`, `storeConfigError` (URL required, lease at least the deadline, under `postgres`)
- [x] 1.2 `src/runs/runDir.ts` and `loadConfig`: the environment fallback in both file layers
- [x] 1.3 `src/runs/resolve.ts`: `store` in the config report and the `config.resolved` summary, redacted; `readOverrides` drops a stored `store` key
- [x] 1.4 `src/state/open.ts`: `openStore` for `sqlite` and `postgres` (lock, load, journal), `close` waits for durability
- [x] 1.5 `src/main.ts`: early store block, run id before opening, scrubbing logger, `onFatal` exits 1, redacted resolution, graph source by kind

## 2. Fatal flush and readiness

- [x] 2.1 `PgSink.onLost` and `lockLost`; not fired by `close`
- [x] 2.2 `JournaledStore.fence` and `readiness`; `JournalSink.lockLost`
- [x] 2.3 `/readyz` appends `store.readiness()`

## 3. Proposed-graph slot

- [x] 3.1 `Store.getProposedGraph`/`setProposedGraph` on SqliteStore and JournaledStore (kv `graph.proposed`, stamp per write)
- [x] 3.2 `StoreGraphSource` in `src/graph/source.ts`
- [x] 3.3 `writeGraphAndReload` and `readGraphFile` in `src/operator/routes.ts` use the slot under `postgres`

## 4. Direct file readers

- [x] 4.1 `orchestrator-ctl` URL lookup: no store file is created; a Postgres run is reported as remote
- [x] 4.2 `reviveDaemon`: a Postgres run without a healthy daemon is reported as remote; `start` output carries the redacted store block

## 5. Fresh clone

- [x] 5.1 Recovery fetches origin first (`integrationHead`)
- [x] 5.2 A claimed launch without a worktree is ended (`worktreeLost`) and its task retried, attempts unchanged
- [x] 5.3 A queued job whose sealed commit is missing is dropped and its task failed `commitLost`, attempts unchanged
- [x] 5.4 Transition rows and failure kinds for both

## 6. Manifests

- [x] 6.1 `deploy/base/postgres.yaml` (CloudNativePG `Cluster` `postgres`), `DATABASE_URL` from `postgres-app`/`uri`, `emptyDir`, no `pvc.yaml`, no graph mount
- [x] 6.2 `deploy/smoke.sh`: install the operator, wait for the cluster, `PUT /v1/graph`, assert no daemon claim and a restart that keeps the graph and the parked launch
- [x] 6.3 `deploy/README.md`

## 7. Tests

- [x] 7.1 `test/state/store-selection.test.ts`: config, redaction, lease check, overrides, the slot on every backend, `StoreGraphSource`, readiness, `openStore` over Postgres with both fatal paths
- [x] 7.2 `test/slice/store-postgres.test.ts`: daemon processes on Postgres (restart on an empty data directory, rejected graph across restart, no password printed, lease refusal, deadline and fenced exits, remote run answers)
- [x] 7.3 `test/slice/fresh-clone.test.ts`: the three fresh-clone cases against a bare origin
- [x] 7.4 `test/host/deploy.test.ts` and `test/host/smoke.test.ts` for the new manifests and steps
- [x] 7.5 `npm test` green without `--retry`, with and without Postgres
