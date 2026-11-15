## ADDED Requirements

### Requirement: Postgres migrations
The Postgres sink SHALL apply its SQL migrations at startup, each once, recorded in a migrations table and serialized across sessions sharing the database.

#### Scenario: Migrations at startup
- **WHEN** a sink opens on a database where the migrations have already been applied
- **THEN** no migration runs again and the migrations table lists each version once

### Requirement: Postgres schema
The Postgres tables SHALL mirror the SQLite store's tables, with attachments in `kv` and no attachments table. Documents SHALL be JSONB. Every table SHALL have a `run_id` column leading every primary key and every unique index. `events.seq` and `outbox.id` SHALL be plain `bigint` columns written explicitly, with no sequence or identity default. `launches` SHALL have an insertion-order column, set when a launch is first inserted and kept on every update and re-applied batch.

#### Scenario: Tables
- **WHEN** the migrations have been applied
- **THEN** the database has the tables `overlay`, `events`, `dedup`, `launches`, `verifier_jobs`, `reports`, `payload_overlays`, `graph_snapshot`, `kv`, `proposals` and `outbox`, each with `run_id` leading its primary key and unique indexes

#### Scenario: Runs share a database
- **WHEN** two runs with different run ids write rows with the same keys (task ids, event sequence numbers, launch ids and tokens, outbox ids, kv keys) to one database
- **THEN** both runs' rows are stored, neither run sees the other's, and loading each run returns only its own rows

### Requirement: Postgres sink
`PgSink` SHALL implement `JournalSink` on the pure-JavaScript `pg` driver. One batch SHALL be one Postgres transaction of upserts and deletes by primary key, `run_id` included, so a batch that fails part-way leaves none of its rows. Applying a batch that was already applied SHALL leave Postgres unchanged, the launches' insertion order included. A statement error on a live session SHALL roll the batch back and be reported as an ordinary error, which the journal retries.

#### Scenario: A batch applied twice
- **WHEN** every recorded batch is applied again, and the last one a third time
- **THEN** every table of the run, including `launches`' insertion order, is unchanged

#### Scenario: A batch fails part-way
- **WHEN** a batch writes a kv row, an event and a delete, and then an upsert that violates a unique index
- **THEN** the batch is rejected with the database error, none of its rows is in Postgres, the sink is not fenced, and the next batch applies

### Requirement: Run lock and fencing
At startup the daemon SHALL take a session-level advisory lock keyed by the run id and SHALL fail to start if another session holds it. The sink SHALL write every batch on the session that holds the lock. If that session is lost (terminated by the server, a connection failure, a failed rollback), the sink SHALL report fenced (`FencedError`) on the next batch and on every batch after it, without sending anything, and SHALL NOT reconnect to write.

#### Scenario: Second daemon refused
- **WHEN** a second session asks for a run's lock while the first holds it
- **THEN** it is refused and the second daemon does not start, while a run with another id still opens

#### Scenario: Session terminated
- **WHEN** the lock holder's session is terminated from the server side with `pg_terminate_backend` and the journal commits a batch
- **THEN** the sink reports fenced on that batch, `onFatal` is called once with reason `fenced`, later batches are rejected without a new session being opened, and Postgres holds no row written after the termination

#### Scenario: Lock released with the session
- **WHEN** the lock holder's session has ended
- **THEN** a new daemon can take the run's lock and load the rows flushed before the session ended

### Requirement: Postgres loader
The loader SHALL build a fresh memory image from Postgres for one run: every table's rows for that `run_id`, `launches` in insertion order, documents with JSON `null` kept distinct from SQL `NULL`. Timestamps, sequence numbers and ids, which `pg` returns as strings for `bigint`, SHALL be parsed to numbers. After loading, the image's next event sequence number and next outbox id SHALL be above every loaded id.

#### Scenario: Reload equals the running image
- **WHEN** the store suites and the randomized journal run use a journaled store over the Postgres sink and every batch is flushed
- **THEN** a fresh image loaded from Postgres equals the running image row for row, documents compared as JSON values, since JSONB keeps a document's value, not its text

#### Scenario: Launch order survives a load
- **WHEN** launches with equal `created_at` are inserted in non-alphabetical id order, and one of them is later updated
- **THEN** `listLaunches` on a loaded image returns them in insertion order

#### Scenario: Numbers after a load
- **WHEN** a run with events, outbox effects and launches is loaded
- **THEN** event `seq` and `ts`, outbox `id`, `sourceSeq`, `createdAt` and `appliedAt`, and launch `createdAt` are numbers, in the loader's rows and through the image, and the next event and outbox ids the image issues are above the loaded ones

### Requirement: Ids are increasing, not gap-free
Event sequence numbers and outbox ids in Postgres SHALL be the values the image assigned. They SHALL be increasing within a run but MAY have gaps (a rolled-back or ignored insert), and an id issued to a batch that was never flushed MAY be issued again after a restart; readers SHALL NOT infer missing rows from a gap.

#### Scenario: Unflushed id reissued
- **WHEN** the daemon stops with a batch holding event sequence number N unflushed, and a new image is loaded
- **THEN** the next event the new image appends gets sequence number N, above every sequence number in Postgres

### Requirement: Postgres test database
The test helper SHALL provide Postgres from `TEST_DATABASE_URL` when it is set; otherwise SHALL start a throwaway cluster with `initdb` and `pg_ctl` when both are on `PATH`, listening on a Unix socket in a temporary directory and removed after the test file; otherwise the Postgres suites SHALL be skipped. Each test SHALL use its own run id. `npm test` SHALL pass, without retries, both with and without Postgres available.

#### Scenario: No Postgres
- **WHEN** `npm test` runs with no `TEST_DATABASE_URL` and neither `initdb` nor `pg_ctl` on `PATH`
- **THEN** the Postgres suites are reported skipped and the run passes
