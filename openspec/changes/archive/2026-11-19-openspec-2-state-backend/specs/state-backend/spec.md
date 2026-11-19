## MODIFIED Requirements

### Requirement: Durability before effects
The orchestrator SHALL wrap the `Workspace`, `AgentRunner` and `VerifierBackend` it is given so that every method call waits for `store.durable()` before it runs; every construction path, test harnesses included, SHALL get the wrapper. An optional method the object lacks SHALL stay absent, and a call made with nothing pending SHALL run at once. A response to `POST` or `PUT` SHALL be sent only after `store.durable()` resolves, including an error response.

#### Scenario: Stalled sink holds effects and write responses
- **WHEN** the sink stalls and a tick admits a task, committing its launch, and reaches the workspace preparation
- **THEN** no `Workspace`, `AgentRunner` or `VerifierBackend` method runs while a batch is pending, a `POST` made meanwhile gets no response, and once the sink accepts the batches the preparation and the spawn run with the launch already in the sink and the `POST` is answered

#### Scenario: Journal already fatal
- **WHEN** the journal is fatal (the run lock was lost) and a `POST`, an agent heartbeat, an inbox read and a wrapped workspace method are called
- **THEN** each answers at once: the requests with 503 and code `storeFatal`, the method by rejecting with `StoreFatalError` without reaching the workspace

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

### Requirement: Store credentials a child can still reach
The daemon removes only environment variables from its children, and only while it withholds (see "Withholding follows the store"). Any process of the daemon's user in its container (a check, a spawned agent, a worker there) can still read the URL file, the daemon's environment as started (`/proc/<daemon pid>/environ`), and its memory where the kernel allows. No requirement SHALL claim the daemon prevents these.

#### Scenario: Environment as started
- **WHEN** a daemon that withholds is started with `DATABASE_URL` in its environment and runs a check command
- **THEN** the check command's environment has no `DATABASE_URL`, and `/proc/<daemon pid>/environ` still holds it

#### Scenario: URL file stays readable
- **WHEN** the daemon reads its URL from a file readable by its user and runs a check command as that user
- **THEN** the check command can read the file; the deployment notes say so and name the measures a deployment takes

## ADDED Requirements

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
