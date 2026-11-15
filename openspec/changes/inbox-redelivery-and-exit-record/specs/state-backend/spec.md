## MODIFIED Requirements

### Requirement: Durability before effects
The orchestrator SHALL wrap the `Workspace`, `AgentRunner` and `VerifierBackend` it is given so that every method call waits for `store.durable()` before it runs; every construction path, test harnesses included, SHALL get the wrapper. An optional method the object lacks SHALL stay absent, and a call made with nothing pending SHALL run at once. A response to `POST` or `PUT` SHALL be sent only after `store.durable()` resolves, including an error response. A fatal journal never becomes durable. A wrapped method called on a journal that is already fatal, with or without pending batches, SHALL reject at once with `StoreFatalError` and SHALL NOT run. A wrapped method waiting when the journal turns fatal SHALL reject the same way. A request gated on durability SHALL answer at once with status 503 and `{ error, code: "storeFatal" }` when the journal is fatal.

#### Scenario: Stalled sink holds effects and write responses
- **WHEN** the sink stalls and a tick admits a task, committing its launch, and reaches the workspace preparation
- **THEN** no `Workspace`, `AgentRunner` or `VerifierBackend` method runs while a batch is pending, a `POST` made meanwhile gets no response, and once the sink accepts the batches the preparation and the spawn run with the launch already in the sink and the `POST` is answered

#### Scenario: Journal already fatal
- **WHEN** the journal is fatal (the run lock was lost) and a `POST`, an agent heartbeat, an inbox read and a wrapped workspace method are called
- **THEN** each answers at once: the requests with 503 and code `storeFatal`, the method by rejecting with `StoreFatalError` without reaching the workspace

### Requirement: Shutdown with unflushed batches
A shutdown SHALL wait a bounded time for committed batches to reach the sink, then stop the journal's flusher before it closes the sink, and SHALL report the committed batches that never reached the sink. The sink's own close SHALL NOT be reported as `fenced`. When batches are left, the daemon SHALL log their count and exit non-zero. This applies after the close and also when the shutdown grace period elapses with batches pending. A shutdown with every batch durable SHALL exit 0. A batch the sink rejects for its content after the flusher stopped SHALL NOT be fatal. It SHALL be logged with its cause (message, SQLSTATE, table and key), and the close SHALL return that cause. The close SHALL wait a bounded time for the apply in flight to settle after the sink closes, so the log lands before the daemon exits. Other failures after the flusher stopped are the sink closing and SHALL NOT be logged as rejections.

#### Scenario: SIGTERM during a stall
- **WHEN** the database session stops answering, a write is committed, and the daemon receives SIGTERM before the flush deadline
- **THEN** the daemon logs the unflushed batch count, does not log a fatal `fenced`, and exits 1

#### Scenario: Close under a stalled sink
- **WHEN** the store is closed with three batches unflushed and the sink fails as it closes
- **THEN** the close resolves with `unflushedBatches: 3` and no fatal condition is reported

#### Scenario: Rejection at shutdown
- **WHEN** the store is closed with two batches unflushed, and the sink then rejects the batch in flight for its content (table `kv`, SQLSTATE `22021`)
- **THEN** the journal logs the rejection with its message, SQLSTATE, table and key, the close resolves with `unflushedBatches: 2` and that cause as `rejected`, and no fatal condition is reported
