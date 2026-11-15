## Why

Milestone M2 puts a run's state in Postgres so a daemon pod can be replaced without losing it. ORC-10 (`journaled-store`) built the journal: a synchronous memory image whose committed batches are applied in order to a `JournalSink`, with a SQLite sink for tests. The decision of 2026-11-12 makes Postgres that sink, not an async `Store`: the daemon answers from its image, Postgres receives committed batches and is read once, at startup. Many daemons may share one Postgres cluster, one daemon per run, so the run must be isolated by id and owned by exactly one session. This change is ORC-15; boot wiring and configuration are ORC-20.

## What Changes

- New `src/state/pg/` on the pure-JavaScript `pg` driver (production dependency; `@types/pg` dev only).
- `schema.ts`: SQL migrations applied at startup, recorded in `orchestrator_migrations` and serialized across sessions by an advisory transaction lock. The tables mirror the SQLite schema (`overlay`, `events`, `dedup`, `launches`, `verifier_jobs`, `reports`, `payload_overlays`, `graph_snapshot`, `kv`, `proposals`, `outbox`; attachments live in `kv`). Documents are JSONB. Every table has `run_id` leading every primary key and unique index; `events.seq` and `outbox.id` are plain `bigint` columns written explicitly; `launches.ord` records insertion order.
- `sink.ts`: `PgSink implements JournalSink`. `PgSink.open({ connection, runId })` connects one dedicated session, migrates, and takes a session-level advisory lock keyed by the run id, rejecting with `RunLockedError` when another session holds it. One batch is one Postgres transaction of upserts (`ON CONFLICT … DO UPDATE`) and deletes by key, on that session; applying it twice changes nothing. When the session is lost the sink latches fenced (`FencedError`, ORC-10) and never reconnects. `loadInto(image)` / `loadImage()` rebuild an image for one run, launches in insertion order; `bigint` values come back as numbers.
- Tests: the store suites and the randomized journal test run against `JournaledStore` over `PgSink` too, comparing a freshly loaded image with the running image after each test; new `test/state/pg.test.ts` for isolation, lock and fencing, idempotent and atomic batches, launch order, number types and the lockfile. `test/state/pg-db.ts` provides Postgres: `TEST_DATABASE_URL`, else a throwaway `initdb`/`pg_ctl` cluster, else the Postgres suites are skipped.

## Capabilities

### New Capabilities
<!-- none: state-backend is created by journaled-store -->

### Modified Capabilities
- `state-backend` (added by `journaled-store`): the Postgres sink and schema, the run lock and fencing, the loader, number types, increasing-not-gap-free ids, and the test database.
- `host-integration`: "No native dependencies" allows `pg`, a pure-JavaScript driver, and forbids `pg-native`.

## Impact

- Code: new `src/state/pg/schema.ts`, `src/state/pg/sink.ts`, `src/state/pg/index.ts`. `src/state/journal.ts` and the daemon are unchanged; the daemon still boots a plain `SqliteStore` until ORC-20.
- Dependencies: `pg` (with `pg-pool`, `pg-protocol`, `pg-types`, `pgpass`, `pg-connection-string`, optional `pg-cloudflare`), all pure JavaScript, no install script.
- Tests: `test/state/backends.ts` (async `open`/`release`, a Postgres backend), `sqlite.test.ts`, `outbox.test.ts`, `journal.test.ts`, new `pg.test.ts` and `pg-db.ts`.
