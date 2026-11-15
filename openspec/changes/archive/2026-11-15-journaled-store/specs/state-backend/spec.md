## ADDED Requirements

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
