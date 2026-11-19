# state-backend Specification

## Purpose
The run state store: a synchronous in-memory image journaled as batches of row operations and flushed to a sink (SQLite locally, Postgres in a cluster), with the durability rules that gate effects on a flushed batch, store selection and the run id per deployment, the run lock and fencing, the values a store accepts, and what a child process may learn about the store.

## Requirements

### Requirement: Journal of row operations
A journaled store SHALL keep a synchronous memory image that answers every `Store` call, and SHALL record every committed write as row operations: an upsert by primary key carrying the resulting row, or a delete by primary key, never the original call. Event sequence numbers and outbox ids SHALL be assigned by the image and written to the sink explicitly in the row. Applying a batch that was already applied SHALL leave the sink unchanged.

#### Scenario: A batch applied twice
- **WHEN** an already-applied batch is applied to the sink again
- **THEN** the sink's tables are unchanged

### Requirement: Batches
One top-level transaction, or one write made outside a transaction, SHALL be one batch; an empty one SHALL produce no batch. Each open transaction level SHALL keep its own operations: a level that throws SHALL discard them, and a level that returns SHALL hand them to its parent. Batches SHALL be applied to the sink in commit order and never split, preserving the insertion order of launches.

#### Scenario: A rolled-back level contributes nothing
- **WHEN** a transaction writes key `a`, calls an inner transaction that writes `b` and throws, calls another that writes `c` and returns, then writes `a` again and returns
- **THEN** exactly one batch is produced, holding upserts of `a` (its final value) and `c`, and no operation for `b`

#### Scenario: The sink follows the image
- **WHEN** a seeded randomized run makes writes, failing statements and transactions nested three deep with rollbacks at every level, and flushes batches, some failing part-way
- **THEN** after every accepted batch the sink's tables equal, row for row, the image's tables as they were when that batch committed, and a failed batch leaves the sink as it was

#### Scenario: Reload after a crash
- **WHEN** the daemon stops with batches not yet flushed and a fresh image is loaded from the sink
- **THEN** the image equals the sink's last flushed state, and the next event sequence number and outbox id it issues are above the durable ones, possibly reusing an unflushed id

### Requirement: Journal sink
A sink SHALL implement `applyBatch(ops)`, applying one batch as one sink transaction: all of it or none of it. A sink MAY throw a distinguished fenced error, meaning this daemon no longer owns the run. A SQLite sink SHALL be provided for tests, with the store's tables, and SHALL be able to load its contents into an empty image.

#### Scenario: Partial failure
- **WHEN** a sink fails after writing part of a batch
- **THEN** none of the batch is in the sink, and the batch is retried

### Requirement: Flusher and deadline
A background flusher SHALL apply pending batches in order, one at a time, retrying a failed batch with backoff. When the oldest unflushed batch is older than `flushDeadlineMs` (the sink failing or never answering), or the sink reports fenced, `onFatal` SHALL be called once with the reason (`deadline` or `fenced`) and the unflushed batch count; fenced calls it at once. After `onFatal` the flusher SHALL stop and `durable()` SHALL NOT resolve.

#### Scenario: Deadline passes
- **WHEN** the sink rejects every batch and three batches are pending past `flushDeadlineMs`
- **THEN** `onFatal` is called exactly once with reason `deadline` and `unflushedBatches` 3, and not again while the sink keeps failing

#### Scenario: Sink stalls
- **WHEN** the sink never answers an apply and the deadline passes
- **THEN** `onFatal` is called once with reason `deadline`

#### Scenario: Fenced
- **WHEN** the sink reports fenced on the first batch
- **THEN** `onFatal` is called immediately, once, with reason `fenced` and the unflushed batch count

### Requirement: Durability
`Store` SHALL offer `durable()`, which resolves when everything committed before the call is in the sink, and `durability()`, which returns `{ lagMs, pendingBatches, eventSeq, outboxId }`: the age of the oldest unflushed batch (0 when none), the number of unflushed batches, and the highest event sequence number and outbox id known durable. A plain SQLite store SHALL be always durable, with lag 0 and the latest ids. `GET /v1/status` SHALL report `storeLagMs` and `storePendingBatches`.

#### Scenario: Plain SQLite store
- **WHEN** a plain SQLite store appends an event and inserts an outbox row
- **THEN** `durability()` returns lag 0, no pending batches, and that event's sequence number and that row's id

#### Scenario: Status reports the lag
- **WHEN** the sink is stalled with a batch pending
- **THEN** `GET /v1/status` answers with `storeLagMs` above zero and `storePendingBatches` above zero

### Requirement: Durability before effects
The orchestrator SHALL wrap the `Workspace`, `AgentRunner` and `VerifierBackend` it is given so that every method call waits for `store.durable()` before it runs; every construction path, test harnesses included, SHALL get the wrapper. An optional method the object lacks SHALL stay absent, and a call made with nothing pending SHALL run at once. A response to `POST` or `PUT` SHALL be sent only after `store.durable()` resolves, including an error response.

#### Scenario: Stalled sink holds effects and write responses
- **WHEN** the sink stalls and a tick admits a task, committing its launch, and reaches the workspace preparation
- **THEN** no `Workspace`, `AgentRunner` or `VerifierBackend` method runs while a batch is pending, a `POST` made meanwhile gets no response, and once the sink accepts the batches the preparation and the spawn run with the launch already in the sink and the `POST` is answered

#### Scenario: Journal already fatal
- **WHEN** the journal is fatal (the run lock was lost) and a `POST`, an agent heartbeat, an inbox read and a wrapped workspace method are called
- **THEN** each answers at once: the requests with 503 and code `storeFatal`, the method by rejecting with `StoreFatalError` without reaching the workspace

### Requirement: Reads from the image and durable reads
`GET` responses SHALL NOT wait for durability and SHALL answer from the image, except two that SHALL return only durable rows, because the operator writes to the tracker from the outbox listing and keeps event cursors, and after a crash an unflushed id is given to a different row. `GET /v1/outbox` SHALL list only ids up to `durability().outboxId`; `GET /v1/events` SHALL list only sequence numbers up to `durability().eventSeq` and report that bound as its `seq` cursor.

#### Scenario: Unflushed rows are omitted
- **WHEN** a task's admission has committed an outbox effect and events that are not yet in the sink
- **THEN** `GET /v1/outbox` omits the effect, `GET /v1/events` lists only durable events with `seq` equal to the durable sequence number, and both include them once the sink accepts the batch

### Requirement: Single writer
The daemon SHALL be the only writer of its run's state; other processes MAY read it. A journaled store records only its own connection's writes, and a write made to the image or the sink by another process is not journaled.

#### Scenario: Readers alongside the daemon
- **WHEN** another process reads the run's state while the daemon writes
- **THEN** the reader is served and the daemon's journal is unaffected

### Requirement: Postgres migrations
The Postgres sink SHALL apply its SQL migrations at startup, each once, recorded in a migrations table and serialized across sessions sharing the database.

The sink SHALL refuse to open when the migrations table records a version that is not among its own migrations, whatever that version is: a newer release has migrated the database.

#### Scenario: Migrations at startup
- **WHEN** a sink opens on a database where the migrations have already been applied
- **THEN** no migration runs again and the migrations table lists each version once

#### Scenario: Database migrated by a newer daemon
- **WHEN** a sink opens on a database whose migrations table records a version above the highest version the sink knows, for a run whose lock another session holds or for any other run
- **THEN** the open is refused with an error naming the recorded version and the highest known version and saying to upgrade the daemon, not with a run-lock refusal; the run lock is not taken, nothing is loaded, no migration is applied, the recorded versions are unchanged, and the store open fails with the code `schemaNewer`

### Requirement: Postgres schema
The Postgres tables SHALL mirror the SQLite store's tables, with attachments in `kv` and no attachments table. They SHALL be in the store's schema (see "Store schema placement"). Documents SHALL be JSONB. Every table SHALL have a `run_id` column leading every primary key and every unique index. `events.seq` and `outbox.id` SHALL be plain `bigint` columns written explicitly, with no sequence or identity default.

#### Scenario: Tables
- **WHEN** the migrations have been applied
- **THEN** the store's schema (`orchestrator` unless `store.schema` names another) has the tables `overlay`, `events`, `dedup`, `launches`, `verifier_jobs`, `reports`, `payload_overlays`, `graph_snapshot`, `kv`, `proposals` and `outbox`, each with `run_id` leading its primary key and unique indexes, the bookkeeping table `orchestrator_migrations`, and the indexes `events_task`, `launches_task`, `launches_status`, `proposals_status` and `outbox_status`

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
The test run SHALL decide once, in a vitest global setup in the main process, where the Postgres suites get their database: from `TEST_DATABASE_URL` when it is set, after one connection to it succeeds; otherwise from one throwaway cluster started with `initdb` and `pg_ctl` when both are on `PATH`, listening on a Unix socket in a temporary directory and shared by every test file of the run; otherwise there is no Postgres.

#### Scenario: No Postgres
- **WHEN** `npm test` runs with no `TEST_DATABASE_URL` and neither `initdb` nor `pg_ctl` on `PATH`
- **THEN** the Postgres suites are reported skipped, one line says so and why, and the run passes

#### Scenario: Postgres required
- **WHEN** `npm test` runs with `ORCH_TEST_PG=required` and no Postgres is available
- **THEN** the run fails, naming why there is no Postgres

#### Scenario: Unreachable URL
- **WHEN** `TEST_DATABASE_URL` is set and does not accept a connection
- **THEN** the run fails instead of skipping the Postgres suites

#### Scenario: One cluster per run
- **WHEN** several test files of one run use Postgres from the throwaway cluster
- **THEN** they share one cluster, each in its own database, and no postmaster or cluster directory remains after the run, even when a test fork or the main process was killed with SIGKILL

#### Scenario: Remote server not signalled
- **WHEN** the Postgres suites run against `TEST_DATABASE_URL`
- **THEN** the tests that stall a server by stopping its backend process are skipped

### Requirement: Store selection
The configuration SHALL carry `store: { kind: sqlite | postgres, url, urlFile, runId, schema, flushDeadlineMs }`, with `kind` defaulting to `sqlite` and `flushDeadlineMs` to 120000; `schema` has no default in the configuration, and the schema in force is `orchestrator` when it is unset (see "Store schema key"). The block SHALL be read from the file, the environment and the URL file only.

#### Scenario: Postgres restart on an empty data directory
- **WHEN** a daemon on `store.kind: postgres` is stopped and started again with a new, empty data directory and the same `store.schema`
- **THEN** it serves the same tasks, launches, events and outbox as before, and no `store.sqlite` exists

#### Scenario: Override document cannot select a store
- **WHEN** the stored `config.overrides` document holds a `store` key beside other keys
- **THEN** the `store` key is ignored and the other keys still apply; a `PUT /v1/config` or `--set` naming `store` (or `store.schema`) is refused

#### Scenario: Run already owned
- **WHEN** a second daemon starts on a run whose lock another session holds
- **THEN** it exits with an error saying the run is locked by another session, naming the store's schema and saying that the run lock is per database

#### Scenario: DATABASE_URL under SQLite
- **WHEN** a daemon on `store.kind: sqlite` (written or by default) starts with `DATABASE_URL` set and no `store.url` in its config file
- **THEN** its resolved `store.url` is unset, and the store report (start output, `GET /v1/config`, `config.json`) has no `url`, no `urlSource` and no `schema`; with `store.url` written in the file, the report shows it without its password and with `urlSource: file`

### Requirement: Database URL redaction
Every surface that prints resolved configuration (`orchestrator-ctl start`, `orchestrator-ctl config`, `GET /v1/config`, `config.json`, the `config.resolved` event) SHALL show the database URL with its password removed, and no daemon log line SHALL contain the password.

#### Scenario: Password never printed
- **WHEN** a daemon on `store.kind: postgres` starts with `DATABASE_URL` carrying a password
- **THEN** the start output, the config route, the CLI's config output, `config.json` and the daemon log show the URL without it and never contain it

### Requirement: Lease versus flush deadline
Under `store.kind: postgres`, startup SHALL refuse a `leaseTtlMs` shorter than `store.flushDeadlineMs`, and a missing URL, with a message naming the values. Under `sqlite` the check does not apply.

#### Scenario: Lease below the deadline
- **WHEN** a Postgres run is configured with `leaseTtlMs: 60000` and the default deadline
- **THEN** the daemon exits non-zero naming `leaseTtlMs (60000)` and `store.flushDeadlineMs (120000)`

### Requirement: Fatal flush
The journal's fatal condition SHALL be logged with its reason and unflushed batch count and SHALL end the daemon with a non-zero exit. A lost lock-holding session SHALL be fatal at once, with or without a batch in flight; a batch older than `flushDeadlineMs` SHALL be fatal when the deadline passes.

#### Scenario: Stalled database
- **WHEN** the database session stops answering and a write is committed
- **THEN** the daemon exits non-zero after `flushDeadlineMs`, logging reason `deadline` and the unflushed batch count

#### Scenario: Session terminated
- **WHEN** the session holding the run lock is terminated by the server
- **THEN** the daemon exits non-zero at once, logging reason `fenced`

### Requirement: Store readiness
A journaled store SHALL report itself not ready while its lag has been above zero for longer than one flush retry, once the session holding the run lock is lost, and after a fatal condition.

#### Scenario: Lag past one retry
- **WHEN** a committed batch has not reached the sink for longer than one flush retry
- **THEN** the store's readiness names the unflushed batches, and it is ready again once they land

### Requirement: Run id per deployment
With `store.kind: postgres` the daemon SHALL choose the run id, in this order: `store.runId` from the config file; else `ORCH_RUN_ID`; else a hash of `git.originUrl` when set; else, with `git.pushIntegration` on, a hash of the clone's `origin` remote; else the repository path hash, logging one warning. Origin hashes SHALL leave out the URL's user information. `store.runId` SHALL never come from the stored overrides. With `store.kind: sqlite` the run id SHALL be as before.

#### Scenario: Two origins on one repository path
- **WHEN** two daemons start with the same repository path, different `git.originUrl` values and one Postgres database
- **THEN** they get different run ids, both run, and neither loads the other's rows, also after a restart on an empty data directory

#### Scenario: Explicit id precedence
- **WHEN** `store.runId` and `ORCH_RUN_ID` are both set
- **THEN** the run id is `store.runId`; with only `ORCH_RUN_ID` set it is `ORCH_RUN_ID`

#### Scenario: Invalid explicit id
- **WHEN** `ORCH_RUN_ID` or `store.runId` is `bad id!`, `x/../y`, empty in the file, or longer than 64 characters
- **THEN** the daemon exits non-zero before opening the store, with a message containing `invalid run id "<value>" from <source>`

#### Scenario: Path hash fallback
- **WHEN** a Postgres daemon has neither an explicit id nor `git.originUrl`, and `git.pushIntegration` is off or the clone has no origin
- **THEN** it starts on the repository path hash and logs exactly one warning that names `store.runId`, `ORCH_RUN_ID` and `git.originUrl`

#### Scenario: SQLite unchanged
- **WHEN** `store.kind` is `sqlite` and `store.runId`, `ORCH_RUN_ID` or `git.originUrl` is set, valid or not
- **THEN** the run id and the run directory are the repository path hash, as before

### Requirement: No store URL in child environments
Check commands, agents of every runner kind together with the processes they start, and the git commands the daemon runs itself through its git wrapper (`src/workspace/git.ts`) together with the project git hooks they trigger, SHALL NOT receive `ORCH_RUN_ID`, on every store kind. This requirement covers environment variables only; what a child running as the daemon's user can still reach is stated in "Store credentials a child can still reach".

#### Scenario: Printed environments
- **WHEN** a daemon that withholds, whose environment holds `DATABASE_URL`, `DATABASE_URL_FILE`, every name in `LIBPQ_VARS` with `PGPASSWORD` set, and another variable with the store URL, runs a check command and a spawned agent that print their environment
- **THEN** neither printout contains any of those variables, the store password or the `PGPASSWORD` value, and unrelated variables are kept

#### Scenario: URL from the config file
- **WHEN** a daemon that withholds takes `store.url` from an untracked config file and another variable holds the same URL
- **THEN** that variable is absent from the check and agent environments, and no worktree contains the config file

#### Scenario: Hook run by a daemon git command
- **WHEN** a daemon that withholds, whose environment holds `DATABASE_URL`, `DATABASE_URL_FILE`, `ORCH_RUN_ID`, every name in `LIBPQ_VARS` and another variable with the store URL, runs its kept-release work-in-progress commit or another `git commit`, and a project git hook that prints its environment runs under it
- **THEN** the printout contains none of those variables, not the store password and not the `PGPASSWORD` value, keeps unrelated variables, and shows `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`

#### Scenario: Store URL withheld after import
- **WHEN** a daemon that withholds registers the store URL after the git module has loaded, as it does once its configuration is resolved
- **THEN** the next daemon git command's environment no longer holds a variable with that URL

#### Scenario: Each libpq name is removed
- **WHEN** an environment holding one name from `LIBPQ_VARS` and an unrelated variable is passed through the child-environment filter in its default state (withholding), with no store URL withheld
- **THEN** the libpq name is removed and the unrelated variable is kept; `PGDATA` and other names outside the list are kept

#### Scenario: SQLite run passes the database variables
- **WHEN** a daemon on a SQLite store with no Postgres input, whose environment holds `DATABASE_URL`, another variable with the same value, `DATABASE_URL_FILE`, `PGHOST`, `PGPASSWORD` and `ORCH_RUN_ID` (with `store.kind: sqlite` written in the file), runs a check command, a spawned agent and a git commit whose hook print their environment
- **THEN** each printout holds `DATABASE_URL`, the other variable, `DATABASE_URL_FILE`, `PGHOST` and `PGPASSWORD` with their values, and no `ORCH_RUN_ID`; the git printout still shows `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`

### Requirement: No store URL in a tracked config file
When `store.url` comes from a config file that git tracks in the repository, the daemon SHALL refuse to start with a message saying so, without printing the URL: a tracked file is checked out into every worktree.

#### Scenario: Tracked file with the URL
- **WHEN** `<repo>/orchestrator.yaml` sets `store.url` and is committed
- **THEN** the daemon exits non-zero with a message that the file sets `store.url` and is tracked by git, and the password is not printed

### Requirement: Storable values
The store SHALL have one write boundary that every row written to it passes through. It SHALL apply the same rule on every backend: the SQLite store, the journal's memory image, and so the Postgres sink. The store SHALL therefore hold only values Postgres accepts, and both backends SHALL hold the same rows.

#### Scenario: Same rows on both backends
- **WHEN** the same writes are made to the SQLite store and to a journal over Postgres
- **THEN** both hold the same rows, and an image reloaded from Postgres equals the running image

### Requirement: Storable strings
Every string bound to a text column, and every string and object key inside a value bound to a JSON column, SHALL have each NUL character and each lone UTF-16 surrogate replaced with U+FFFD. Other text, surrogate pairs included, SHALL be kept unchanged.

#### Scenario: NUL in a log text
- **WHEN** an event payload holds the string `a\u0000b`
- **THEN** the event is stored as `a�b` on both backends, and Postgres accepts the batch that carries it

#### Scenario: Check output cut inside a surrogate pair
- **WHEN** a verifier job's output and the task's carry hold check output with NUL, and one string starts with a lone low surrogate and another ends with a lone high surrogate
- **THEN** both are stored with U+FFFD in those places, the batch is flushed to Postgres, and an image reloaded from Postgres equals the running image

#### Scenario: Randomized run with unstorable strings
- **WHEN** the randomized journal run writes payloads, keys, report bodies, outbox errors and kv values that hold NUL and lone surrogates, over a SQLite sink and over Postgres
- **THEN** it ends with a reloaded image equal to the running image, and no stored string holds NUL or a lone surrogate

### Requirement: Storable integers
Every value bound to an integer column SHALL be a safe integer, or null where the column is nullable. Otherwise the write SHALL throw a typed error (`UnstorableValueError`) that names the field as `table.column`, before anything is written. An enclosing store transaction SHALL roll back with it.

#### Scenario: Non-integer in an integer column
- **WHEN** a write binds `1.5` or `1e30` to `dedup.seq`
- **THEN** it throws `UnstorableValueError` with field `dedup.seq`, and no row is written

### Requirement: Rejected batch
When the sink refuses a batch for its content and its rollback succeeds, it SHALL report the refusal as not retryable. A refusal for content is Postgres SQLSTATE class 22 (data exception) or class 23 (integrity constraint violation). The report SHALL name the refused row's table, its primary key and the SQLSTATE. It SHALL carry nothing of the row's contents and nothing of the server's message.

#### Scenario: Refusal names no contents
- **WHEN** Postgres refuses an `events` row whose payload holds a `\u0000` escape
- **THEN** the sink's error names table `events`, the row's `seq` and SQLSTATE `22P05`, and none of the row's values

### Requirement: Rejected batch is fatal at once
On a rejected batch the journal SHALL call `onFatal` once and at once, without waiting for `flushDeadlineMs`. The call SHALL give reason `rejected`, the unflushed batch count, the table, the key and the SQLSTATE. The daemon's log of the fatal condition SHALL name the table, the key and the SQLSTATE. Readiness SHALL name the rejection. Connection loss SHALL still be fatal as `fenced`, and any other sink error SHALL still be retried until the deadline.

#### Scenario: Data error with a high deadline
- **WHEN** `flushDeadlineMs` is ten minutes and Postgres refuses a batch with a data error
- **THEN** `onFatal` is called once, within seconds, with reason `rejected`, the table, the key and the SQLSTATE, and nothing of the refused batch is in Postgres

#### Scenario: Other errors keep retrying
- **WHEN** the sink fails a batch with an error that is neither a rejection nor fenced
- **THEN** the journal retries it with backoff and applies it once the sink accepts it, or calls `onFatal` with reason `deadline` once the deadline passes

### Requirement: Postgres store without push integration
With `store.kind: postgres` and `git.pushIntegration` off, the daemon SHALL start and SHALL warn in the log and in a `config.warning` event with code `postgresWithoutPushIntegration`, naming `git.pushIntegration: true` as the remedy. The integration branch then lives only in the clone, so a restart without a volume loses publications the store records `done`. The daemon cannot tell a volume from an emptyDir, so it warns rather than refuses.

#### Scenario: Postgres without push integration
- **WHEN** a daemon starts with `store.kind: postgres` and `git.pushIntegration: false`
- **THEN** it starts, logs the warning, and records one `config.warning` event with code `postgresWithoutPushIntegration`

#### Scenario: Postgres with push integration
- **WHEN** a daemon starts with `store.kind: postgres` and `git.pushIntegration: true`
- **THEN** no durability warning is given

### Requirement: Durable cursor in the status
`GET /v1/status` SHALL report as `latestSeq` the highest durable event sequence number, not the memory image's: after a crash an unflushed sequence number belongs to a different event. Clients that read `/v1/events` from "now" (the operator MCP `wait`, the Codex work loop, `deploy/smoke.sh`) SHALL use `latestSeq` as their `after`.

#### Scenario: Status under lag
- **WHEN** the sink stalls and events are appended to the image
- **THEN** `latestSeq` in `/v1/status` equals the durable sequence number, not the image's

### Requirement: Event cursor moves forward
`/v1/events` SHALL NOT answer with a `seq` lower than the `after` it was given. When the page is cut by `limit`, `seq` SHALL be the page's last event; otherwise it SHALL be the durable sequence number. A client's cursor SHALL only move forward.

#### Scenario: A cursor above the durable sequence
- **WHEN** `/v1/events` is read with an `after` above the durable sequence number
- **THEN** the answer has no events and its `seq` equals that `after`

#### Scenario: A page cut by the limit
- **WHEN** `/v1/events?after=0&limit=2` is read and more than two events are durable
- **THEN** its `seq` is the second event's sequence number

### Requirement: Shutdown with unflushed batches
A shutdown SHALL wait a bounded time for committed batches to reach the sink, then stop the journal's flusher before it closes the sink, and SHALL report the committed batches that never reached the sink. The sink's own close SHALL NOT be reported as `fenced`.

#### Scenario: SIGTERM during a stall
- **WHEN** the database session stops answering, a write is committed, and the daemon receives SIGTERM before the flush deadline
- **THEN** the daemon logs the unflushed batch count, does not log a fatal `fenced`, and exits 1

#### Scenario: Close under a stalled sink
- **WHEN** the store is closed with three batches unflushed and the sink fails as it closes
- **THEN** the close resolves with `unflushedBatches: 3` and no fatal condition is reported

#### Scenario: Rejection at shutdown
- **WHEN** the store is closed with two batches unflushed, and the sink then rejects the batch in flight for its content (table `kv`, SQLSTATE `22021`)
- **THEN** the journal logs the rejection with its message, SQLSTATE, table and key, the close resolves with `unflushedBatches: 2` and that cause as `rejected`, and no fatal condition is reported

### Requirement: Lease margin above the flush deadline
Under `store.kind: postgres`, startup SHALL refuse a `leaseTtlMs` unless `leaseTtlMs - 2 × renewEveryMs >= store.flushDeadlineMs`, where `renewEveryMs` is a third of the lease. A stall may begin with only `leaseTtlMs - renewEveryMs` of lease left and lasts at most `flushDeadlineMs`. The stated margin above the deadline is one more renewal interval. The refusal SHALL name both values and a lease that passes (three times the deadline).

#### Scenario: Lease equal to the deadline
- **WHEN** a Postgres run is configured with `leaseTtlMs: 120000` and `store.flushDeadlineMs: 120000`
- **THEN** startup is refused, naming `leaseTtlMs (120000)`, `store.flushDeadlineMs (120000)` and `at least 360000`

#### Scenario: Defaults
- **WHEN** a Postgres run uses the default lease (600000) and deadline (120000)
- **THEN** startup accepts it

### Requirement: Workers and a daemon that is not ready
While the store is not ready, a cluster daemon's `/readyz` fails and the pod leaves its Service. Workers SHALL NOT be routed to it. Their calls fail and they keep retrying through the Service (the work loop on its next beat, an agent on its next call). They reach the daemon once it is ready again, or its replacement once the deadline has made it exit. The lease margin keeps their launches alive meanwhile.

#### Scenario: Stall shorter than the deadline
- **WHEN** the sink stalls for less than `flushDeadlineMs` and a worker's renewals fail while the pod is out of its Service
- **THEN** the worker's next renewal after `/readyz` recovers lands before its lease expires

### Requirement: Manual flush
The journal SHALL apply batches one at a time and in order, whoever starts the apply: the flusher or `flushOnce`. A batch SHALL leave the queue only after it was applied, whatever `autoFlush` is.

#### Scenario: Concurrent manual flushes
- **WHEN** four batches are pending with `autoFlush` off and three `flushOnce` calls run at once
- **THEN** the sink receives the first three batches once each and in order, and the fourth is still pending

#### Scenario: Manual flush beside the flusher
- **WHEN** `flushOnce` is called while `autoFlush` is on and batches keep committing
- **THEN** every batch reaches the sink once, in commit order, and the sink equals the image

### Requirement: Randomized journal test covers every table
The seeded randomized journal test SHALL write, through accepted batches, every table the journal mirrors, so that each table's rows are compared between the sink and the image, and SHALL fail when a table was never written.

#### Scenario: Every table written
- **WHEN** the randomized run over SQLite or Postgres ends
- **THEN** the set of tables its accepted batches wrote equals the journal's table list, `verifier_jobs`, `proposals` and `payload_overlays` included

### Requirement: Storable ids
An id that holds a NUL character or a lone UTF-16 surrogate SHALL be refused at its entry point, before anything is written. The entry points are graph load (each node `id` and `deps` entry), `POST /v1/claims` (`workerId`, `taskId`, `attachment`) and `POST /v1/attachments` (`id`). Every id that passes SHALL be stored unchanged. The rewrite of "Storable strings" stays as the store's backstop.

#### Scenario: Ids that pass are found again
- **WHEN** task, launch, job, proposal, attachment, kv and worker ids holding non-ASCII text, a surrogate pair or U+FFFD are written to every key column of each backend
- **THEN** each row is found by the same id before and after a reopen, and a worker that claimed with such an id finds its launch on its next claim

#### Scenario: Refused before the store
- **WHEN** an id that "Storable strings" would change arrives at one of the entry points
- **THEN** it is refused there and no row is written under it or under its rewritten form

### Requirement: Refused graph id
A graph whose node id or dependency holds a NUL or a lone surrogate SHALL fail validation with code `unstorableId`. The message SHALL name the field (`nodes.<i>.id` or `nodes.<i>.deps.<j>`) and the id written as a JSON string. The details SHALL be `{ field, id }`.

#### Scenario: Graph node with a NUL in its id
- **WHEN** a graph file has a node whose id is `T\u0000x`
- **THEN** loading it fails with code `unstorableId`, the message names `nodes.<i>.id` and the id with the NUL escaped, and no graph is loaded

#### Scenario: Dependency with a lone surrogate
- **WHEN** a graph node lists a dependency `T\uD83D`, a lone high surrogate
- **THEN** loading it fails with code `unstorableId` naming `nodes.<i>.deps.<j>`

### Requirement: Refused request id
A claim or attachment request with an id that holds a NUL or a lone surrogate SHALL be answered 400. The `field` SHALL name the request field and the error SHALL name the id written as a JSON string. The request SHALL append no event and change no row.

#### Scenario: Claim with an unstorable worker id
- **WHEN** a worker posts `/v1/claims` with a `workerId`, `taskId` or `attachment` that holds a NUL or a lone surrogate
- **THEN** the daemon answers 400 with `field` set to that request field, no event is appended, and no launch is claimed

#### Scenario: Attachment with an unstorable id
- **WHEN** a session posts `/v1/attachments` with an `id` that holds a NUL or a lone surrogate
- **THEN** the daemon answers 400 with `field` `id`, and no attachment is stored

### Requirement: Store URL from a file
Under `store.kind: postgres`, when the config file leaves `store.url` unset, the daemon SHALL take the URL from the file named by `store.urlFile`, else from the file named by `DATABASE_URL_FILE`, else from `DATABASE_URL`. The trimmed file content SHALL be the URL, read at most once per process. Under `sqlite` no URL file SHALL be read. The store report SHALL name the source `urlFile`. A URL from a file SHALL be withheld from child environments and scrubbed from the log.

#### Scenario: URL from DATABASE_URL_FILE
- **WHEN** a Postgres daemon starts with `DATABASE_URL_FILE` naming a file that holds the URL and no `DATABASE_URL`
- **THEN** it opens the store, and the environment another process of its user reads for it (`/proc/<pid>/environ`, or `ps eww` where there is no `/proc`) holds `DATABASE_URL_FILE` but neither `DATABASE_URL` nor the password

#### Scenario: store.urlFile in a tracked config
- **WHEN** a committed `orchestrator.yaml` sets `store.urlFile` and the environment has no `DATABASE_URL`
- **THEN** the daemon starts, its start output shows `urlSource: urlFile`, and the password is not printed

#### Scenario: Read once
- **WHEN** a URL file changes after the daemon's first resolution read it
- **THEN** a later resolution in the same process still uses the URL read first

### Requirement: Refused URL file
The daemon SHALL refuse to start, with a message naming the file and the setting that named it and never the URL, when a URL file cannot be read or is empty. It SHALL refuse `store.url` together with `store.urlFile`. Under `store.kind: postgres`, when the config file sets neither `store.url` nor `store.urlFile`, it SHALL refuse `DATABASE_URL` together with `DATABASE_URL_FILE`. A `store.urlFile` in a config file tracked by git SHALL NOT be refused: it holds a path, not the URL.

#### Scenario: Unreadable URL file
- **WHEN** `DATABASE_URL_FILE` names a file that does not exist
- **THEN** the daemon exits non-zero with `cannot read the database URL file <path> (DATABASE_URL_FILE)`

#### Scenario: Two sources at once
- **WHEN** a Postgres config sets neither `store.url` nor `store.urlFile` and `DATABASE_URL` and `DATABASE_URL_FILE` are both set, or the file sets both `store.url` and `store.urlFile`
- **THEN** the configuration is refused with a message naming both

### Requirement: Store credentials a child can still reach
The daemon removes only environment variables from its children, and only while it withholds (see "Withholding follows the store"). Any process of the daemon's user in its container (a check, a spawned agent, a worker there) can still read the URL file, the daemon's environment as started (`/proc/<daemon pid>/environ`), and its memory where the kernel allows. No requirement SHALL claim the daemon prevents these.

#### Scenario: Environment as started
- **WHEN** a daemon that withholds is started with `DATABASE_URL` in its environment and runs a check command
- **THEN** the check command's environment has no `DATABASE_URL`, and `/proc/<daemon pid>/environ` still holds it

#### Scenario: URL file stays readable
- **WHEN** the daemon reads its URL from a file readable by its user and runs a check command as that user
- **THEN** the check command can read the file; the deployment notes say so and name the measures a deployment takes

### Requirement: Reference daemon environment holds no store URL
The reference manifests SHALL give the daemon the store URL through a mounted Secret file named by `store.urlFile`, with no `DATABASE_URL`, `DATABASE_URL_FILE`, `PG*` variable, `envFrom` or Secret-read variable in the daemon container.

#### Scenario: Reference manifests keep the URL out of the daemon's environment
- **WHEN** `kubectl kustomize deploy/base` runs
- **THEN** the daemon container has no `DATABASE_URL`, no `DATABASE_URL_FILE`, no variable starting with `PG`, no `envFrom` and no variable read from a Secret, and `orchestrator.yaml` names `store.urlFile` on the mounted Secret file

### Requirement: Withholding follows the store
The daemon SHALL withhold the store's variables from its children (see "No store URL in child environments") exactly when the store it opened is Postgres, or is SQLite while a Postgres input is set and the file does not write `store.kind` (see "Postgres inputs under SQLite", with its warning and event). A process that opens no store SHALL withhold. The daemon SHALL state at startup and in its config report whether it withholds (see "Withholding stated").

#### Scenario: A Postgres store withholds
- **WHEN** a daemon opens a Postgres store, whatever the config file and the environment hold
- **THEN** it withholds: its check commands, agents and git hooks see none of the store's variables, as in "No store URL in child environments"

#### Scenario: A SQLite store passes
- **WHEN** a daemon started with `orchestrator --repo`, with no `store` block in its config file and an empty `ORCH_RUN_ID`, opens a SQLite store with `DATABASE_URL` (holding a password), `APP_DATABASE` set to the same value, `DATABASE_URL_FILE`, `PGHOST` and `PGPASSWORD` in its environment, and runs a check command and a spawned agent that print their environment
- **THEN** both printouts hold all five variables and an unrelated one, no `ORCH_URL`, and an `ORCH_HOME` inside the run directory; no `config.warning` event is appended; the report has `withholdsDatabaseVariables: false`

#### Scenario: Postgres inputs without store.kind
- **WHEN** the same SQLite daemon is started with `ORCH_RUN_ID=team-a`, or with a `store` block that sets only `flushDeadlineMs`
- **THEN** its check command and agent see none of `DATABASE_URL`, `APP_DATABASE`, `DATABASE_URL_FILE`, `PGHOST`, `PGPASSWORD` or `ORCH_RUN_ID`, and not the password; its log has one warning and its events one `config.warning` with code `postgresInputsUnderSqlite`, both naming `ORCH_RUN_ID` (or `store.flushDeadlineMs`); the report has `withholdsDatabaseVariables: true`

#### Scenario: store.kind written as sqlite
- **WHEN** the config file writes `store.kind: sqlite` and `ORCH_RUN_ID=team-a` is set
- **THEN** the daemon does not withhold, its children see the database variables and no `ORCH_RUN_ID`, and nothing warns

#### Scenario: No store opened
- **WHEN** a process that opened no store (an operator command, a library caller, the in-process test harness) builds a child environment, a claim's `env` block or a config report
- **THEN** it withholds: the store's variables are removed (blanked in a claim's `env` block), and the report has `withholdsDatabaseVariables: true`

#### Scenario: Variables named at startup
- **WHEN** a daemon starts with `DATABASE_URL`, `DATABASE_URL_FILE`, `PGHOST` and `PGPASSWORD` in its environment
- **THEN** its log has one info line with `withholds`, `storeKind` and `names` holding those four names, and the line holds neither the password nor the `PGHOST` value

#### Scenario: The config report states the rule
- **WHEN** an operator reads `GET /v1/config` of a running daemon, or its `config.json`
- **THEN** the store block has `withholdsDatabaseVariables`: `true` on a Postgres store or under the exception, `false` on a SQLite store otherwise

### Requirement: Postgres inputs under SQLite
A Postgres input is a key other than `kind` in the file's `store` block, or a non-blank `ORCH_RUN_ID`. A file that writes `store.kind` has none. `DATABASE_URL`, `DATABASE_URL_FILE`, libpq names and `git.originUrl` are not inputs. A SQLite daemon with inputs SHALL also withhold the trimmed `DATABASE_URL` by value, and at each start log one warning and append one `config.warning` event `{ code: 'postgresInputsUnderSqlite', message, inputs }` naming each input and both remedies.

#### Scenario: Project variables are no inputs
- **WHEN** a SQLite daemon with no `store` block and an empty `ORCH_RUN_ID` has `DATABASE_URL`, `DATABASE_URL_FILE`, `PGHOST` and `PGPASSWORD` in its environment, or `git.originUrl` in its config file
- **THEN** it finds no Postgres input, appends no `config.warning` event and does not withhold

#### Scenario: Warning names the remedies
- **WHEN** a SQLite daemon starts with a Postgres input and no `store.kind` in its config file
- **THEN** the warning and the event's `message` name each input, `store.kind: postgres` and `store.kind: sqlite`

### Requirement: Withholding stated
The daemon SHALL decide once per start, after the store opens and before its first resolution, with no configuration key or pass-list. When its environment holds a non-empty `DATABASE_URL`, `DATABASE_URL_FILE` or `LIBPQ_VARS` name, it SHALL log one info line with `withholds`, `storeKind` and `names`, never a value. The report's store block SHALL carry `withholdsDatabaseVariables` on every store kind, in the start output, `GET /v1/config`, `config.json` and `config.resolved`.

#### Scenario: No line without database variables
- **WHEN** a daemon starts with none of `DATABASE_URL`, `DATABASE_URL_FILE` or the `LIBPQ_VARS` names set in its environment
- **THEN** it logs no line naming database variables, and its report still carries `withholdsDatabaseVariables`

### Requirement: Store schema placement
Under `store.kind: postgres` the store's tables SHALL be in the schema in force (see "Store schema key"). Every statement the sink sends that names a store table or `orchestrator_migrations` SHALL name the quoted schema. The unqualified migrations SHALL run under a transaction-local `search_path` holding the schema alone. The sink's session SHALL resolve to the schema alone, whatever path the connection asked for, also after a rolled-back batch.

#### Scenario: Migrations under a transaction-local path
- **WHEN** `migrate()` runs on a caller's session, and returns or throws
- **THEN** a transaction-local `search_path` holding the schema alone was set before the first statement that names a table, and the caller's `search_path` is unchanged afterwards

#### Scenario: Statements name the schema
- **WHEN** the sink builds a batch's statements, the loader reads a run, or `migrate()` runs, for a schema other than `orchestrator`
- **THEN** each statement that names a store table or `orchestrator_migrations` names it as `"<schema>"."<table>"`, the `launches` sub-select included

#### Scenario: The connection asks for another schema
- **WHEN** the connection's startup `options` put another schema first, and that schema holds tables named like all twelve of the store's
- **THEN** after the open `current_schema()` on the sink's session is the store's schema, a journaled store writes every table there, a fresh image loaded from the sink equals the running image, and the other schema's tables hold no row and gain no relation

#### Scenario: A refused batch keeps the path
- **WHEN** the server refuses a batch for its content
- **THEN** the sink's session still resolves to the store's schema and the next batch lands there

#### Scenario: A run in another schema
- **WHEN** a sink opened on a schema other than `orchestrator` applies batches and loads an image
- **THEN** every row is in that schema, and `orchestrator` holds no row for the run id

### Requirement: Store schema creation
At every start, in the migration transaction and under its lock, the sink SHALL look the schema up in `pg_namespace` and send `CREATE SCHEMA` only when it is absent, never with `IF NOT EXISTS`. The role SHALL hold USAGE and CREATE on an existing schema, or the open is refused. A `CREATE SCHEMA` refused with SQLSTATE `42501` SHALL name both remedies; other failures give no grant advice. Every refusal SHALL name the schema and carry the server's message.

#### Scenario: Absent schema
- **WHEN** a sink opens on a schema that does not exist, as a role that may create schemas
- **THEN** exactly one `CREATE SCHEMA` for the quoted name is sent, after the migration lock, and the tables and indexes are created in that schema

#### Scenario: Ready-made schema
- **WHEN** a role without CREATE on the database opens a schema made for it with USAGE and CREATE granted
- **THEN** no `CREATE SCHEMA` is sent and the tables are created there

#### Scenario: The role may not create the schema
- **WHEN** that role opens a schema that does not exist
- **THEN** the open is refused with a message holding the schema's name, both remedies and the server's message, and the schema still does not exist

#### Scenario: Rights missing on an existing schema
- **WHEN** the schema exists and the role lacks USAGE or CREATE on it
- **THEN** the open is refused with a message naming the schema

#### Scenario: Another failure
- **WHEN** `CREATE SCHEMA` fails with a SQLSTATE other than `42501`, or the connection is lost
- **THEN** the refusal names the schema and carries the cause's message, and gives no grant advice

#### Scenario: Two daemons at once
- **WHEN** two sinks with different run ids open at once on a schema that does not exist
- **THEN** both open and `pg_namespace` holds the schema once

#### Scenario: Failed first open
- **WHEN** the first open on an absent schema fails while applying migration 1
- **THEN** the transaction is rolled back and the schema does not exist

### Requirement: Store schema key
`store.schema` SHALL name the Postgres store's schema, `orchestrator` when unset, read from the config file at start only and never a runtime override. A name SHALL be 1 to 63 characters of `a-z`, `0-9` and `_`, start with a letter or `_`, not start with `pg_`, and not be `information_schema`. Under `postgres` a bad name SHALL refuse the start before the store opens; `sqlite` ignores the key. Under `postgres` the report and the store log lines SHALL show the schema in force.

#### Scenario: Not a string
- **WHEN** the config file sets `store.schema` to a number, a boolean or an empty YAML value, on any store kind
- **THEN** the config parse fails at `store.schema`

#### Scenario: Same rule before connecting
- **WHEN** `PgSink.open` is given a schema name the rule refuses
- **THEN** it rejects before connecting, naming the value, and it accepts exactly the names the configuration check accepts

#### Scenario: Default
- **WHEN** a daemon on `store.kind: postgres` starts with no `store.schema`
- **THEN** its tables are in the schema `orchestrator`, and its report and `store opened` line show `schema: orchestrator`

#### Scenario: A named schema
- **WHEN** a daemon starts with `store.schema` set to a valid name
- **THEN** the start result, `GET /v1/config`, `config.json` and the `store opened` line show that name, the twelve tables are in that schema, and a restart on an empty data directory with the same value serves the same tasks

#### Scenario: A refused name
- **WHEN** a daemon on `store.kind: postgres` starts with `store.schema: Bad-Name`
- **THEN** it exits non-zero before the store opens and logs `store configuration refused` with a message holding `store.schema`, the value and the rule

#### Scenario: SQLite ignores the key
- **WHEN** a daemon on `store.kind: sqlite` has `store.schema` set to any string
- **THEN** nothing refuses it and the report carries no `schema`

#### Scenario: Never an override
- **WHEN** the stored override document holds `store.schema`, or an operator names it in `--set` or a configuration patch
- **THEN** the stored key is ignored and the flag and the patch are refused

#### Scenario: A changed value starts an empty run
- **WHEN** a daemon restarts with another `store.schema` value
- **THEN** it serves no task, and the first schema still holds the run's rows

#### Scenario: Tables in another schema are not read
- **WHEN** the database holds a run's tables in `public` (made before this requirement) and a daemon starts with no `store.schema`
- **THEN** it creates the schema `orchestrator` and starts an empty run there; the tables in `public` are neither read nor moved

### Requirement: Run lock is per database
The run lock and the migration lock SHALL stay keyed per database, whatever the schema: one run id SHALL NOT be live in two schemas of one database. The refusal of a second open SHALL keep the words `locked by another session`, name the store's schema, and say that the run lock is per database. A second daemon that starts on a locked run id with a new schema name creates that schema and its tables before it is refused, and leaves them empty.

#### Scenario: Same run id in a second schema
- **WHEN** a sink holds a run id in one schema and another sink opens the same run id in a second schema of the same database
- **THEN** the second open is refused with `RunLockedError`, while two different run ids open in the two schemas

#### Scenario: Refusal names the schema
- **WHEN** `openStore` is refused because the run is locked
- **THEN** its error says the run is locked by another session, names the schema and says the run lock is per database; the errors for a failed open and a failed load name the schema too

### Requirement: Empty run beside tables in another schema

Under `store.kind: postgres`, when the load finds no row for the run id in the configured schema, the daemon SHALL look, with one catalogue query on the sink's session, for other schemas of the database holding an ordinary table named `orchestrator_migrations`. When it finds any, it SHALL log one warning and append one `config.warning` event with `code: 'tablesInOtherSchema'`. A failed query SHALL NOT stop the start.

#### Scenario: An empty run with tables in another schema

- **WHEN** a daemon starts a run that has no row in the configured schema while another schema of the database holds an ordinary table named `orchestrator_migrations`
- **THEN** it finds that schema with one query on `pg_catalog.pg_class` joined with `pg_catalog.pg_namespace`, leaving out the configured schema and reading no row of another schema
- **AND** it logs one warning naming every such schema, sorted, the configured schema, the run id and the key `store.schema`
- **AND** it appends one `config.warning` event with `code` `tablesInOtherSchema`, the message, and the schema names in `schemas`
- **AND** the warning does not say whether the other schema holds rows for this run id, and does not name other run ids

#### Scenario: A run that has rows

- **WHEN** the load finds at least one row for the run id, as at every start after the first (each start writes the run id and a `config.resolved` event)
- **THEN** the daemon runs no catalogue query and logs no such warning

#### Scenario: No other schema

- **WHEN** a run is empty and no other schema of the database holds a table named `orchestrator_migrations` (a schema holding only other store table names, such as `launches`, does not count)
- **THEN** the daemon logs no such warning and appends no such event

#### Scenario: A failed catalogue query

- **WHEN** the catalogue query fails
- **THEN** the daemon logs nothing about it, appends no event, and starts as it would without the check

### Requirement: Origin identity is frozen

The identity hashed for an origin run id SHALL be the URL trimmed, normalised as the scenarios state and otherwise kept as written; an address that does not parse as a URL SHALL be taken unchanged. No form SHALL lose a `.git` suffix or a trailing slash. The rule SHALL NOT change in a later release, and a test SHALL hold run ids as literals.

#### Scenario: https host case, default port and credential

- **WHEN** the origin is `https://git.example.com/team/project.git`, `https://GIT.example.com:443/team/project.git` or `https://x-access-token:secret@git.example.com/team/project.git`
- **THEN** the run id is `88b53ae7afc6f781` for each, because an `http` or `https` URL has its user information removed, its host lowercased and its default port dropped

#### Scenario: http default port

- **WHEN** the origin is `http://GIT.example.com:80/team/project.git`
- **THEN** the run id is `559e44dca6da773f`

#### Scenario: ssh URL keeps host and port as written

- **WHEN** the origin is `ssh://git@git.example.com/team/project.git` or `ssh://other@git.example.com/team/project.git`
- **THEN** the run id is `80a522b921e76c20` for both, because user information is removed
- **AND WHEN** the origin is `ssh://git@GIT.example.com/team/project.git`
- **THEN** the run id is `a929f8abcff79ed4`
- **AND WHEN** the origin is `ssh://git@git.example.com:22/team/project.git`
- **THEN** the run id is `a52c4abb760e2b58`

#### Scenario: git URL keeps host and port as written

- **WHEN** the origin is `git://git-origin.orch.svc:9418/fixture.git`
- **THEN** the run id is `af1507c5d17cfdef`
- **AND WHEN** the origin is `git://git-origin.orch.svc/fixture.git`
- **THEN** the run id is `f62598e6976ef69f`

#### Scenario: Three path spellings are three run ids

- **WHEN** the origin is `https://git.example.com/team/project.git`, `https://git.example.com/team/project` or `https://git.example.com/team/project/`
- **THEN** the run ids are `88b53ae7afc6f781`, `30774d330900e9dc` and `884bf3a568293c95`

#### Scenario: scp-like address with a user is taken unchanged

- **WHEN** the origin is `git@git.example.com:team/project.git`
- **THEN** the run id is `9245f0dda77f617c`
- **AND WHEN** the origin is `other@git.example.com:team/project.git`
- **THEN** the run id is `a93c1af9aa06b2a6`, because the address does not parse as a URL and its user is kept
- **AND WHEN** the origin is `git@GIT.example.com:team/project.git`
- **THEN** the run id is `27f5d6b225cee7c8`, because its host case is kept

#### Scenario: scp-like address without a user

- **WHEN** the origin is `git.example.com:team/project.git` or `GIT.example.com:team/project.git`
- **THEN** the run id is `430a03b607b6e432` for both, because the address parses as a URL whose scheme is the host name, and only that name is lowercased

#### Scenario: Local path

- **WHEN** the origin is `/srv/git/project.git`
- **THEN** the run id is `86fb6c3ee3132ede`

### Requirement: Fatal journal at the durability gate
A fatal journal never becomes durable. A wrapped method called on a journal that is already fatal, with or without pending batches, SHALL reject at once with `StoreFatalError` and SHALL NOT run. A wrapped method waiting when the journal turns fatal SHALL reject the same way. A request gated on durability SHALL answer at once with status 503 and `{ error, code: "storeFatal" }` when the journal is fatal.

#### Scenario: Gated call waiting when the journal turns fatal
- **WHEN** a wrapped method is called while a batch is pending, and the journal then turns fatal before the batch becomes durable
- **THEN** the call rejects with `StoreFatalError` and the wrapped method never runs

#### Scenario: Fatal journal with batches pending
- **WHEN** the journal is already fatal with batches still pending and a wrapped method is called
- **THEN** the call rejects at once with `StoreFatalError` and the wrapped method does not run

### Requirement: Newer schema refusal content
The refusal of a database migrated by a newer release SHALL name the highest recorded version the sink does not know and the highest version it knows, and SHALL say that this daemon must be upgraded; it SHALL NOT carry the database password. The store open SHALL report the refusal with the code `schemaNewer`.

#### Scenario: Refusal names the versions and not the password
- **WHEN** the store is opened with a URL whose password is `pw-s3cret`, on a database whose migrations table records a version above the highest version the sink knows
- **THEN** the open fails with a `StoreOpenError` of code `schemaNewer` whose message names the recorded version and the highest known version, says to upgrade the daemon, and does not contain `pw-s3cret`

### Requirement: Newer schema check in the migration transaction
The check for a recorded version the sink does not know SHALL run in the migration transaction, after the migration lock is taken and the recorded versions are read and before any pending migration runs, so the refusal comes before the run lock is taken and before the run is loaded. On a refusal the transaction SHALL be rolled back: no migration is applied and no version is recorded.

#### Scenario: Refusal rolls the migration transaction back
- **WHEN** the migration transaction reads recorded versions that include a version the sink does not know
- **THEN** it sends `ROLLBACK` and no `COMMIT`, runs no migration's SQL, and inserts no row into `orchestrator_migrations`

### Requirement: Recorded migration versions the sink knows
A recorded version the sink knows SHALL NOT be compared by name, and a gap in the recorded versions SHALL NOT be an error.

#### Scenario: Known versions open
- **WHEN** the migrations table records only versions the sink knows, whatever names are recorded with them
- **THEN** the open is not refused, and only the sink's migrations whose versions are not recorded are applied

### Requirement: Newer schema check at startup only
The check for a recorded version the sink does not know runs at startup only: a daemon that is already running when a newer daemon migrates the database SHALL NOT be stopped by it, and gets the refusal at its next start.

#### Scenario: Running sink not stopped by a newer migration
- **WHEN** a sink holds a run's lock and a version above the highest version it knows is then recorded in the migrations table
- **THEN** that sink is not closed or fenced by it, and the next sink opened on the database is refused with the code `schemaNewer`

### Requirement: Launch insertion order
`launches` SHALL have an insertion-order column, set when a launch is first inserted and kept on every update and re-applied batch.

#### Scenario: Equal creation times load in insertion order
- **WHEN** two launches with equal `created_at` are inserted in non-alphabetical id order and an image is loaded from Postgres
- **THEN** the loaded image lists the two launches in the order they were inserted

### Requirement: Throwaway Postgres test cluster
On the shared cluster each test file SHALL use its own database, dropped when the file ends. The throwaway cluster SHALL be stopped and its directory removed when the run ends, also when a test fork is killed, and also when the main process dies without its teardown.

#### Scenario: Test file database dropped
- **WHEN** a test file that used the throwaway cluster ends
- **THEN** its own database is dropped and the cluster stays up for the other files of the run

### Requirement: Postgres test mode
`ORCH_TEST_PG` SHALL accept `auto` (the default), `off` (no Postgres, whatever is available) and `required` (the run fails when there is no Postgres); any other value fails the run. A run without Postgres SHALL print exactly one line saying the Postgres suites are skipped and why.

#### Scenario: Postgres turned off
- **WHEN** `npm test` runs with `ORCH_TEST_PG=off` while Postgres is available
- **THEN** the Postgres suites are skipped and one line says `postgres: the Postgres suites are skipped (ORCH_TEST_PG=off)`

#### Scenario: Unknown mode
- **WHEN** `npm test` runs with `ORCH_TEST_PG` set to a value other than `auto`, `off` and `required`
- **THEN** the run fails with a message naming the value and the accepted ones

### Requirement: Postgres test isolation
Each test SHALL use its own run id. A test SHALL signal a Postgres server process only when the server is the cluster this run started.

#### Scenario: Run ids on a shared database
- **WHEN** several tests write to one shared `TEST_DATABASE_URL`
- **THEN** each opens its sinks under a run id from `freshRunId`, which no other test uses, and the tests that stop a server process with a signal are skipped

### Requirement: Test suite with and without Postgres
`npm test` SHALL pass, without retries, both with and without Postgres available.

#### Scenario: Suite without Postgres
- **WHEN** `npm test` runs without retries and with `ORCH_TEST_PG=off`
- **THEN** the run passes, with the Postgres suites skipped

### Requirement: Store URL sources per store kind
When the config file leaves `url` unset, `url` SHALL come from the sources of specs/state-backend "Store URL from a file" under `postgres`. Under `sqlite` the daemon SHALL NOT read `DATABASE_URL` (or `DATABASE_URL_FILE`) as a store input: `url` stays unset unless the config file writes it, and a `url` written in the file is kept and reported with `urlSource: file`.

#### Scenario: DATABASE_URL under Postgres
- **WHEN** the configuration has `store.kind: postgres`, the config file writes no `store.url`, and `DATABASE_URL` is set
- **THEN** the resolved `store.url` is the value of `DATABASE_URL`; with `store.url` written in the file, the file's value is kept

### Requirement: Store opened per kind
The daemon SHALL open `<dataDir>/store.sqlite` under `sqlite`; under `postgres` it SHALL take the run lock, load the memory image for the run from the tables in the store's schema, and run the journal over the Postgres sink.

#### Scenario: SQLite store file
- **WHEN** the store is opened with `store.kind: sqlite`
- **THEN** `<dataDir>/store.sqlite` holds the store

#### Scenario: Postgres open takes the run lock
- **WHEN** the store is opened with `store.kind: postgres` and then opened a second time for the same run
- **THEN** the first open takes the run lock and loads the run's image, and the second open is refused with an error saying the run is locked

### Requirement: Explicit run id shape
With `store.kind: postgres`, an explicit run id (`store.runId` or `ORCH_RUN_ID`) that is not 1 to 64 characters of `[A-Za-z0-9_-]` SHALL fail startup with a message naming it.

#### Scenario: Longest accepted id
- **WHEN** a daemon on `store.kind: postgres` whose config file sets no `store.runId` starts with `ORCH_RUN_ID` set to 64 characters of `[A-Za-z0-9_-]`
- **THEN** the run id is that value; with 65 such characters the daemon fails startup with `invalid run id "<value>" from ORCH_RUN_ID`

### Requirement: Database URL variables withheld from children
While the daemon withholds (see "Withholding follows the store": always on a Postgres store), check commands, agents of every runner kind together with the processes they start, and the git commands the daemon runs itself through its git wrapper (`src/workspace/git.ts`) together with the project git hooks they trigger SHALL NOT receive `DATABASE_URL`, `DATABASE_URL_FILE`, or any variable whose value equals a withheld store URL (the resolved `store.url`).

#### Scenario: Child environment filter
- **WHEN** the daemon withholds the store URL and builds a child environment from an environment holding `DATABASE_URL`, `DATABASE_URL_FILE`, `ORCH_RUN_ID`, variables whose values are the store URL (one of them with surrounding whitespace), and an unrelated variable
- **THEN** none of those variables but the unrelated one is in the child environment

### Requirement: Libpq variables withheld from children
While the daemon withholds (see "Withholding follows the store": always on a Postgres store), the children named in "No store URL in child environments" SHALL NOT receive any libpq connection variable named in `LIBPQ_VARS` (`src/runs/childEnv.ts`: among them `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGPASSFILE`, `PGSERVICE`, `PGSERVICEFILE`, `PGSYSCONFDIR`, `PGSSLMODE`, `PGSSLCERT`, `PGSSLKEY` and `PGSSLROOTCERT`).

#### Scenario: Every libpq name in the child environment
- **WHEN** the daemon's environment holds every name in `LIBPQ_VARS` and an unrelated variable, and a child environment is built while the daemon withholds
- **THEN** none of the `LIBPQ_VARS` names is in it and the unrelated variable is

### Requirement: Libpq names removed whatever their values
While the daemon withholds, the libpq names SHALL be removed whatever their values, so a store URL built from parts (`postgres://host/db` plus `PGPASSWORD`) does not reach a child, and a project's check command loses its own `PG*` variables too. `LIBPQ_VARS` SHALL be the one list of the libpq connection variable names.

#### Scenario: No store URL withheld
- **WHEN** no store URL is withheld and an environment holding one `LIBPQ_VARS` name with any value is passed through the child-environment filter
- **THEN** the name is removed, while `PGDATA`, `PG_HOST` and `MY_PGHOST` are kept

### Requirement: Database variables when not withholding
While the daemon does not withhold, `DATABASE_URL`, `DATABASE_URL_FILE`, the `LIBPQ_VARS` names and the variables whose value equals the store URL SHALL reach the children named in "No store URL in child environments" unchanged. The daemon's own environment SHALL keep the variables it withholds from its children.

#### Scenario: Withholding off
- **WHEN** withholding is off and an environment holding `DATABASE_URL`, `ORCH_RUN_ID` and the libpq variables is passed through the child-environment filter
- **THEN** the database variables are kept with their values and `ORCH_RUN_ID` is dropped

### Requirement: Daemon git command environment
The environment of each daemon git command SHALL be built when the command runs, so a store URL resolved after startup is removed too, and SHALL still set `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`. The read-only startup lookups in `src/runs/runDir.ts` (`git config --get remote.origin.url`, `git ls-files --error-unmatch`, `git rev-parse --show-toplevel`) run no hooks and are not covered.

#### Scenario: Plain and bounded git paths
- **WHEN** a daemon that withholds runs a git command through its git wrapper, with and without a timeout, that prints its environment
- **THEN** both printouts hold no store URL and no withheld variable, and show `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`

### Requirement: Shutdown exit status
When committed batches are left unflushed at a shutdown, the daemon SHALL log their count and exit non-zero. Logging the count and exiting non-zero applies after the close and also when the shutdown grace period elapses with batches pending. A shutdown with every batch durable SHALL exit 0.

#### Scenario: Grace period elapses with batches pending
- **WHEN** the shutdown grace period elapses while committed batches are still pending
- **THEN** the daemon logs that the grace elapsed with the unflushed batch count, records the count in its exit record, and exits non-zero

#### Scenario: Clean shutdown
- **WHEN** the store closes with no unflushed batch
- **THEN** the exit record has no `unflushedBatches` and the daemon exits 0

### Requirement: Content rejection after the flusher stopped
A batch the sink rejects for its content after the flusher stopped SHALL NOT be fatal. A batch rejected that way SHALL be logged with its cause (message, SQLSTATE, table and key), and the close SHALL return that cause. The close SHALL wait a bounded time for the apply in flight to settle after the sink closes, so the log lands before the daemon exits. Other failures after the flusher stopped are the sink closing and SHALL NOT be logged as rejections.

#### Scenario: Other failure after the flusher stopped
- **WHEN** the flusher has stopped and the sink then fails a batch for a reason other than its content
- **THEN** no rejection is logged and the close returns only the unflushed batch count, with no rejection cause

### Requirement: Store credentials in the deployment notes
`deploy/README.md` "Store credentials" SHALL state each way a child can still read the store credentials (the URL file, the daemon's environment as started, and its memory) and what a deployment does about it.

#### Scenario: Deployment notes list each way
- **WHEN** the "Store credentials" section of `deploy/README.md` is read
- **THEN** it names the URL file, `/proc/<daemon pid>/environ` and the daemon's memory as readable by a child, and says for each what a deployment does to limit it
