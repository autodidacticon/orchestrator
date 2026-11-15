## ADDED Requirements

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
