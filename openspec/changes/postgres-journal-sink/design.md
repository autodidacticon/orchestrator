## Context

`journaled-store` (ORC-10) gives the daemon a synchronous `SqliteStore` image and a `JournalSink` that receives committed batches of row operations in order: an upsert carrying the resulting row, or a delete by primary key. This change supplies the production sink. Postgres holds every run's state; each daemon owns one run, reads it once at startup, and then only writes. Claims arrive over HTTP at that one daemon, so `SELECT … FOR UPDATE` is not needed.

## Goals / Non-Goals

**Goals:** a Postgres sink with the SQLite sink's semantics (one batch is one transaction, idempotent re-apply, rowid-like launch order); many runs in one database; one owning session per run, and a sink that stops writing for good when that session is lost; a loader whose image equals the running image; no native dependency; tests that run against a real Postgres when one is available and skip cleanly otherwise.

**Non-Goals:** daemon boot, configuration and `onFatal` → process exit (ORC-20); connection pooling; reading Postgres after startup; schema `search_path` configuration.

## Decisions

### Schema
The tables mirror `SCHEMA` in `src/state/sqlite.ts`, with three differences. `run_id text` leads every primary key and every unique index (`launches (run_id, token)`, `outbox (run_id, source_seq, task_id, kind)`), and every secondary index. `events.seq` and `outbox.id` are plain `bigint` with no sequence or identity: the image assigns them and the sink writes them. `launches.ord bigint` is the insertion order, because `listLaunches` breaks `created_at` ties by SQLite `rowid`. Timestamps, sequence numbers and ids are `bigint`; `applied`, `attempts` and `graph_snapshot.id` stay `integer`. Documents (`overlay.entry`, `events.payload`, `dedup.response`, the `doc` columns, `payload_overlays.payload`, `outbox.payload`, `outbox.result`) are JSONB; `kv.value` (attachments included), `graph_snapshot.content` and `outbox.error` stay text.

Migrations live in TypeScript (`MIGRATIONS`) so the build ships them with no asset copying. `migrate` runs them in one transaction holding `pg_advisory_xact_lock` on a fixed key and records each in `orchestrator_migrations`, so daemons starting together on one cluster migrate once.

### Launch insertion order
The upsert for `launches` adds `ord = (SELECT COALESCE(MAX(ord), 0) + 1 FROM launches WHERE run_id = $1)` to its `INSERT` and leaves `ord` out of `DO UPDATE SET`, so a launch's order is fixed by its first insert and neither an update nor a re-applied batch moves it. The run has one writer, so the `MAX + 1` cannot race; `UNIQUE (run_id, ord)` would catch it if it did. The loader reads launches `ORDER BY ord`, and since the image assigns rowids in load order, `listLaunches` ties come back in insertion order. Alternatives: a global identity column (also works, but consumes values on every conflicting upsert and ties the order to a cluster-wide sequence); storing the image's `rowid` (not part of the journaled row, and a reloaded image renumbers it).

### One batch, one transaction, idempotent
`applyBatch` validates every table and column against the schema before sending anything, then runs `BEGIN`, one statement per op (`INSERT … ON CONFLICT (run_id, pk) DO UPDATE SET` every non-key column, or `DELETE … WHERE run_id = $1 AND pk`), and `COMMIT`. A statement error rolls back and is rethrown, so a batch that fails part-way leaves none of its rows and the journal retries it. Since every op is "make this key look like this" or "make this key absent", applying a batch again changes nothing. Document columns are bound as the JSON text the image holds and cast with `::jsonb`.

### Run lock and fencing
`PgSink.open` uses one dedicated `pg.Client`, not a pool, for the lock and every write. It takes `pg_try_advisory_lock(key)` where `key` is the first eight bytes of `SHA-256("orchestrator-run:" + runId)` as a signed `bigint` (a 64-bit key: collisions between run ids are negligible, and a collision could only refuse a start, never let two daemons write one run). If the lock is held, `open` closes its session and rejects with `RunLockedError`. Session-level advisory locks last as long as the session, so while the sink's session is alive no other daemon can own the run, and every write goes through that session.

The sink latches fenced when the session is lost: the client emits `error` or `end`, a statement fails with a connection error (no SQLSTATE, class `08`, or `57P01`–`57P03`, which `pg_terminate_backend` raises), or `ROLLBACK` fails. The fenced batch and every later one reject with `FencedError` (with the cause attached) without touching the network, and the journal calls `onFatal('fenced')` at once. The sink never reconnects: a new session would not hold the lock, and by then another daemon may own the run. An error event listener is always attached, so a server-side termination is never an unhandled `error`. Sink operations are serialized on the one session.

### Loader
`readRun(client, runId)` selects every table for one `run_id`, ordered by primary key (launches by `ord`), documents as `col::text` so JSON `null` (`dedup.response`, an acked `outbox.result`) stays distinct from SQL `NULL` (`events.payload`). The JSONB text is recompacted with `JSON.parse`/`JSON.stringify`. `loadRunInto` applies the rows to an empty image in one transaction with the journal's `applyOps`; explicit `seq` and `id` values advance SQLite's AUTOINCREMENT counters, so the image's next event sequence number and outbox id are above every loaded one. `loadImage()` returns a fresh `:memory:` image.

### Types
`pg` returns `int8` as a string. The sink's client is created with a type parser that maps OID 20 to a JavaScript number and throws for a value outside the safe integer range (millisecond timestamps and ids are far below 2^53). The tests assert `typeof` number on the loader's own rows as well as through the image, because SQLite's integer affinity would silently coerce a numeric string.

### Comparing an image with Postgres
JSONB stores a document's value, not its text: it reorders keys and drops insignificant whitespace. A loaded image's document text therefore differs from the running image's while meaning the same thing, and every `Store` read parses it. "Equals row for row" is checked with document columns parsed on both sides (`canonical` in `test/state/backends.ts`); every other column compares exactly. Keeping the original text would need `json` instead of `jsonb`, which the brief rules out and which loses JSONB's indexing for later queries.

### Ids are increasing, not gap-free
The image assigns event sequence numbers and outbox ids. A rolled-back or ignored insert can leave a gap, and after a crash an unflushed id is issued again to a different row. Postgres stores whatever the image wrote, so ids in Postgres are increasing but not gap-free, and readers must not infer missing rows from gaps.

### Test database
`test/state/pg-db.ts` decides at collection time: `TEST_DATABASE_URL` when set; otherwise a cluster when `initdb` and `pg_ctl` are on `PATH`; otherwise the Postgres suites are `describe.skip`. `ORCH_TEST_PG=off` forces the skip. The cluster (one per test file, started lazily, stopped in `afterAll`) uses `initdb -A trust --no-sync` and `pg_ctl start -o "-k <dir> -c listen_addresses='' -F"`, listening only on a Unix socket in its temp directory, so parallel test files never contend for a port. Every test uses a fresh random run id and deletes its rows afterwards, so a shared `TEST_DATABASE_URL` is safe.

## Risks / Trade-offs

- A string containing `\u0000` is valid JSON for SQLite but rejected by JSONB, so such a batch would fail until the flush deadline makes it fatal. Nothing the orchestrator writes today contains one; a follow-up can escape it if a source appears.
- A transient network failure fences the daemon, by design: restarting it (ORC-20) is safer than writing without the lock.
- One round trip per op: batches are small (one transaction's changed keys). Pipelining or multi-row statements can come later without changing semantics.

## Migration Plan

None for running daemons: boot still opens a plain `SqliteStore`. ORC-20 adds the configuration that opens `PgSink`, loads the image with `loadImage()`, and constructs the `JournaledStore`.
