## MODIFIED Requirements

### Requirement: Postgres schema
The Postgres tables SHALL mirror the SQLite store's tables, with attachments in `kv` and no attachments table. They SHALL be in the store's schema (see "Store schema placement"). Documents SHALL be JSONB. Every table SHALL have a `run_id` column leading every primary key and every unique index. `events.seq` and `outbox.id` SHALL be plain `bigint` columns written explicitly, with no sequence or identity default. `launches` SHALL have an insertion-order column, set when a launch is first inserted and kept on every update and re-applied batch.

#### Scenario: Tables
- **WHEN** the migrations have been applied
- **THEN** the store's schema (`orchestrator` unless `store.schema` names another) has the tables `overlay`, `events`, `dedup`, `launches`, `verifier_jobs`, `reports`, `payload_overlays`, `graph_snapshot`, `kv`, `proposals` and `outbox`, each with `run_id` leading its primary key and unique indexes, the bookkeeping table `orchestrator_migrations`, and the indexes `events_task`, `launches_task`, `launches_status`, `proposals_status` and `outbox_status`

#### Scenario: Runs share a database
- **WHEN** two runs with different run ids write rows with the same keys (task ids, event sequence numbers, launch ids and tokens, outbox ids, kv keys) to one database
- **THEN** both runs' rows are stored, neither run sees the other's, and loading each run returns only its own rows

### Requirement: Store selection
The configuration SHALL carry `store: { kind: sqlite | postgres, url, urlFile, runId, schema, flushDeadlineMs }`, with `kind` defaulting to `sqlite` and `flushDeadlineMs` to 120000; `schema` has no default in the configuration, and the schema in force is `orchestrator` when it is unset (see "Store schema key"). When the file leaves `url` unset, `url` SHALL come from the sources of specs/state-backend "Store URL from a file" under `postgres`. Under `sqlite` the daemon SHALL NOT read `DATABASE_URL` (or `DATABASE_URL_FILE`) as a store input: `url` stays unset unless the config file writes it, and a `url` written in the file is kept and reported with `urlSource: file`. The daemon SHALL open `<dataDir>/store.sqlite` under `sqlite`; under `postgres` it SHALL take the run lock, load the memory image for the run from the tables in the store's schema, and run the journal over the Postgres sink. The block SHALL be read from the file, the environment and the URL file only.

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

## ADDED Requirements

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
