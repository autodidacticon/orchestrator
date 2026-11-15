## ADDED Requirements

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

