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
The test run SHALL decide once, in a vitest global setup in the main process, where the Postgres suites get their database: from `TEST_DATABASE_URL` when it is set, after one connection to it succeeds; otherwise from one throwaway cluster started with `initdb` and `pg_ctl` when both are on `PATH`, listening on a Unix socket in a temporary directory and shared by every test file of the run; otherwise there is no Postgres. On the shared cluster each test file SHALL use its own database, dropped when the file ends. The cluster SHALL be stopped and its directory removed when the run ends, also when a test fork is killed, and also when the main process dies without its teardown. `ORCH_TEST_PG` SHALL accept `auto` (the default), `off` (no Postgres, whatever is available) and `required` (the run fails when there is no Postgres); any other value fails the run. A run without Postgres SHALL print exactly one line saying the Postgres suites are skipped and why. Each test SHALL use its own run id. A test SHALL signal a Postgres server process only when the server is the cluster this run started. `npm test` SHALL pass, without retries, both with and without Postgres available.

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
The configuration SHALL carry `store: { kind: sqlite | postgres, url, flushDeadlineMs }`, with `kind` defaulting to `sqlite`, `flushDeadlineMs` to 120000, and `DATABASE_URL` filling `url` when the file leaves it unset. The daemon SHALL open `<dataDir>/store.sqlite` under `sqlite`; under `postgres` it SHALL take the run lock, load the memory image for the run, and run the journal over the Postgres sink. The block SHALL be read from the file and the environment only.

#### Scenario: Postgres restart on an empty data directory
- **WHEN** a daemon on `store.kind: postgres` is stopped and started again with a new, empty data directory
- **THEN** it serves the same tasks, launches, events and outbox as before, and no `store.sqlite` exists

#### Scenario: Override document cannot select a store
- **WHEN** the stored `config.overrides` document holds a `store` key beside other keys
- **THEN** the `store` key is ignored and the other keys still apply; a `PUT /v1/config` or `--set` naming `store` is refused

#### Scenario: Run already owned
- **WHEN** a second daemon starts on a run whose lock another session holds
- **THEN** it exits with an error saying the run is locked by another session

### Requirement: Database URL redaction
Every surface that prints resolved configuration (`orchestrator-ctl start`, `orchestrator-ctl config`, `GET /v1/config`, `config.json`, the `config.resolved` event) SHALL show the database URL with its password removed, and no daemon log line SHALL contain the password.

#### Scenario: Password never printed
- **WHEN** a daemon starts with `DATABASE_URL` carrying a password
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
With `store.kind: postgres` the daemon SHALL choose the run id, in this order: `store.runId` from the config file; else `ORCH_RUN_ID`; else a hash of `git.originUrl` when set; else, with `git.pushIntegration` on, a hash of the clone's `origin` remote; else the repository path hash, logging one warning. Origin hashes SHALL leave out the URL's user information. `store.runId` SHALL never come from the stored overrides. An explicit id that is not 1 to 64 characters of `[A-Za-z0-9_-]` SHALL fail startup with a message naming it. With `store.kind: sqlite` the run id SHALL be as before.

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
Check commands, agents of every runner kind together with the processes they start, and the git commands the daemon runs itself through its git wrapper (`src/workspace/git.ts`) together with the project git hooks they trigger, SHALL NOT receive `DATABASE_URL`, `ORCH_RUN_ID`, or any variable whose value equals the resolved `store.url`. The daemon's own environment SHALL keep them. The environment of each daemon git command SHALL be built when the command runs, so a store URL resolved after startup is removed too, and SHALL still set `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`. The read-only startup lookups in `src/runs/runDir.ts` (`git config --get remote.origin.url`, `git ls-files --error-unmatch`, `git rev-parse --show-toplevel`) run no hooks and are not covered.

#### Scenario: Printed environments
- **WHEN** a Postgres daemon whose environment holds `DATABASE_URL` and another variable with the same URL runs a check command and a spawned agent that print their environment
- **THEN** neither printout contains `DATABASE_URL`, `ORCH_RUN_ID`, the other variable, or the password, and unrelated variables are kept

#### Scenario: URL from the config file
- **WHEN** `store.url` comes from an untracked config file and another variable holds the same URL
- **THEN** that variable is absent from the check and agent environments, and no worktree contains the config file

#### Scenario: Hook run by a daemon git command
- **WHEN** the daemon's environment holds `DATABASE_URL`, `ORCH_RUN_ID` and another variable with the store URL, and a project git hook that prints its environment runs under the daemon's kept-release work-in-progress commit or another daemon `git commit`
- **THEN** the printout contains none of those variables and not the password, keeps unrelated variables, and shows `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`

#### Scenario: Store URL withheld after import
- **WHEN** the store URL is withheld after the git module has loaded, as the daemon does once its configuration is resolved
- **THEN** the next daemon git command's environment no longer holds a variable with that URL

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
A shutdown SHALL wait a bounded time for committed batches to reach the sink, then stop the journal's flusher before it closes the sink, and SHALL report the committed batches that never reached the sink. The sink's own close SHALL NOT be reported as `fenced`. When batches are left, the daemon SHALL log their count and exit non-zero. This applies after the close and also when the shutdown grace period elapses with batches pending. A shutdown with every batch durable SHALL exit 0.

#### Scenario: SIGTERM during a stall
- **WHEN** the database session stops answering, a write is committed, and the daemon receives SIGTERM before the flush deadline
- **THEN** the daemon logs the unflushed batch count, does not log a fatal `fenced`, and exits 1

#### Scenario: Close under a stalled sink
- **WHEN** the store is closed with three batches unflushed and the sink fails as it closes
- **THEN** the close resolves with `unflushedBatches: 3` and no fatal condition is reported

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

