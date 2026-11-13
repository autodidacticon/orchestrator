## 1. Schema and dependency

- [x] 1.1 Add `pg` to `dependencies` and `@types/pg` to `devDependencies`; confirm the lockfile has no install script, `pg-native` or `libpq`
- [x] 1.2 `src/state/pg/schema.ts`: migration 1 with the eleven tables, `run_id` leading every key and unique index, JSONB documents, `bigint` ids and timestamps, `launches.ord`; column kinds for the sink and loader

## 2. Sink, lock, loader

- [x] 2.1 `migrate(client)`: `orchestrator_migrations`, serialized by `pg_advisory_xact_lock`
- [x] 2.2 `PgSink.open`: one dedicated `pg.Client`, migrate, `pg_try_advisory_lock(runLockKey(runId))`, `RunLockedError` when held
- [x] 2.3 `applyBatch`: one transaction of upserts and deletes by key on the locked session; statement errors roll back and rethrow; a lost session latches `FencedError` and no later call touches the network
- [x] 2.4 `readRun`, `loadRunInto`, `loadImage`: one run's rows, launches by `ord`, documents as text, `bigint` parsed to numbers

## 3. Tests

- [x] 3.1 `test/state/pg-db.ts`: `TEST_DATABASE_URL`, else an `initdb`/`pg_ctl` cluster on a Unix socket, else skip (`ORCH_TEST_PG=off` forces the skip)
- [x] 3.2 `test/state/backends.ts`: a Postgres backend; after each test a fresh image loaded from Postgres equals the running image
- [x] 3.3 `test/state/journal.test.ts`: the randomized run parametrized over the sink, run against Postgres too, ending with a reload compared to the running image
- [x] 3.4 `test/state/pg.test.ts`: run isolation, lock refusal and fencing after `pg_terminate_backend`, idempotent and part-way-failed batches, launch insertion order, number types, the lockfile
- [x] 3.5 `npm test` green without `--retry`, with and without Postgres
