## Why

ORC-10 (`journaled-store`) built the journal and ORC-15 (`postgres-journal-sink`) the Postgres sink, but the daemon still boots a plain `SqliteStore` from its data directory. Milestone M2 needs a daemon pod that can be replaced with no volume: its state in Postgres, its integration branch and milestone tags on origin (ORC-21, `origin-source-of-truth`), its clone and run directory throwaway. This change (ORC-20) selects the store at startup, moves the graph into the store, makes startup on a fresh clone recover what it lost, and removes the daemon's volume claim from the manifests.

## What Changes

- Config: a `store` block, `{ kind: sqlite | postgres, url, flushDeadlineMs }`, `flushDeadlineMs` defaulting to 120000 and `DATABASE_URL` filling an unset `url`. It is read from the file and the environment only: a `store` key in the stored `config.overrides` document is ignored (its siblings still apply) and a patch or `--set` naming it is refused.
- `src/main.ts` opens the store through the new `src/state/open.ts`: `sqlite` is today's `<dataDir>/store.sqlite`; `postgres` takes the run lock (`PgSink.open`), loads the memory image, and runs `JournaledStore` over the sink. Startup refuses `store.kind: postgres` without a URL, and a `leaseTtlMs` shorter than `flushDeadlineMs`, naming both values.
- The URL is printed without its password everywhere resolved config is printed (`orchestrator-ctl start`, `orchestrator-ctl config`, `GET /v1/config`, `config.json`, the `config.resolved` event), and every daemon log line is scrubbed of the password.
- Fatal flush: the journal's `onFatal` logs the reason and the unflushed batch count and exits non-zero. A lost lock-holding session is fatal at once, with no batch in flight (`PgSink.onLost`, `JournaledStore.fence`). `/readyz` is not ready while the store lag has been above zero for longer than one flush retry, and once the lock is lost (`Store.readiness`).
- Proposed-graph slot: `Store.getProposedGraph`/`setProposedGraph` (a kv row with a stamp per write) apart from the accepted snapshot. Under `postgres` the graph source is the new `StoreGraphSource`; `PUT /v1/graph` writes the slot, proposal acceptance reads it (falling back to the active graph). A rejected document stays proposed and the accepted snapshot is unchanged, across a restart. Under `sqlite` the file source is unchanged.
- `orchestrator-ctl` and revival: a run directory without `store.sqlite` whose run is on Postgres is reported as remote, to be reached with `--url` or `ORCH_URL`; a missing store file is never created by a lookup.
- Startup on a fresh clone (recovery, after fetching origin): a claimable launch is prepared again (as before); a queued verifier job whose `sealedSha` the clone lacks is dropped and its task failed with the retryable reason `commitLost`, attempts unchanged; a claimed launch whose worktree is gone is ended (`worktreeLost`) and its task retried at once, attempts unchanged. Two orchestrator transitions are added for these (`submitted -> failed` `commitLost`, `running -> failed` `worktreeLost`, neither charging an attempt).
- Manifests: a CloudNativePG `Cluster` `postgres`; the daemon reads its application Secret's `uri` as `DATABASE_URL`; `pvc.yaml` is removed and `/data` is an `emptyDir`; the graph ConfigMap mount is gone and `deploy/smoke.sh` sends the graph with `PUT /v1/graph`, installs the operator first, and asserts no daemon claim and a restart that keeps the graph and the parked launch.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `state-backend` (added by `journaled-store` and `postgres-journal-sink`): store selection, URL redaction, the lease-versus-deadline check, fatal flush and store readiness.
- `graph-import`: the graph source by store kind, and the proposed slot versus the accepted snapshot.
- `crash-recovery`: startup on a fresh clone.
- `cluster-runtime`: probes, reference manifests and the smoke test; the mounted-graph limitation is removed.
- `task-lifecycle`: the transition table gains the two uncharged fresh-clone rows.

## Impact

- Code: `src/config.ts`, `src/main.ts`, new `src/state/open.ts`, `src/state/{store,sqlite,journal,status,transitions}.ts`, `src/state/pg/sink.ts`, `src/graph/source.ts`, `src/operator/{routes,cli}.ts`, `src/runs/{resolve,runDir,lifecycle}.ts`, `src/launch/recovery.ts`.
- Manifests: `deploy/base/{postgres.yaml,deployment.yaml,orchestrator.yaml,kustomization.yaml}`, removed `deploy/base/{pvc.yaml,graph.yaml}`, `deploy/overlays/kind/kustomization.yaml`, `deploy/smoke.sh`, `deploy/README.md`.
- Tests: new `test/state/store-selection.test.ts`, `test/slice/store-postgres.test.ts`, `test/slice/fresh-clone.test.ts`; `test/host/{deploy,smoke}.test.ts` updated.
- `store.kind: sqlite` (the default) behaves as before.
