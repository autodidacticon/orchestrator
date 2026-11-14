## ADDED Requirements

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
