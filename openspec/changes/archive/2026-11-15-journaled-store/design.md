## Context

`Store` is synchronous and the orchestrator depends on it: a claim, a transition, and a dedup write are each one synchronous call with nothing able to interleave. Milestone M2 needs the state in Postgres. The decision of 2026-11-12 keeps the synchronous interface and adds a journal: a memory image that answers every call, and a durable sink that receives the image's committed changes asynchronously. A prototype (19 store tests and a 9,000-step randomized test) proved the idea; this change is the production shape for SQLite. The prototype's directory was not readable from the worktree this change was built in, so the implementation was written fresh to the same contract.

## Goals / Non-Goals

**Goals:** a journal whose sink, at every flushed batch boundary, equals the image as it was then; idempotent batches; no outside effect and no write response before the record behind it is durable; reads that a client turns into external writes or cursors see only durable rows; laptop behaviour unchanged.

**Non-Goals:** Postgres (ORC-15), configuration, boot wiring and process exit on `onFatal` (ORC-20), a `created_at` tiebreak column for `listLaunches` (ORC-15), multiple writers.

## Decisions

### Capture by key with temporary triggers, rows read at commit
The journal installs `TEMP` triggers on the image's connection for every table (`AFTER INSERT/UPDATE/DELETE`), each appending `(table, json_array(pk))` to a `TEMP` table `_journal`. The temp table is written in the same transaction as the row, so SQLite's own savepoint rollback discards a failed level's keys and keeps a returning level's for its parent: the "one buffer per transaction level" rule holds without a buffer of our own. When the outermost `transaction` ends, the distinct keys are read in order of first appearance and each becomes an upsert carrying the row as it now is, or a delete by key if the row is gone. A bare write runs as its own top-level transaction, so it is one batch.

Alternatives considered: wrapping each `Store` write method and deriving its affected rows in TypeScript (needs per-method knowledge of which rows `insertOutbox`, `ackOutbox`, `putAttachment` and `dropJob` touch, and goes stale when a method changes); SQLite's session extension (changesets are SQLite-specific and do not map to a Postgres sink). Temp triggers see only this connection's writes, which matches "the daemon is the only writer".

Reading the row at commit means a batch carries the final row per key rather than every intermediate write; the sink's end state is the same and the batch is smaller. Keys are harvested in a `finally` at depth zero, so if a commit fails and SQLite rolls back, the rolled-back keys are already gone and whatever remains is committed state.

### Idempotent apply that keeps insertion order
The SQLite sink applies an upsert as `INSERT … ON CONFLICT(pk) DO UPDATE SET …`, never `INSERT OR REPLACE`: REPLACE gives the row a new rowid, which would reorder `listLaunches` ties (broken by rowid), and could delete another row on the unique `token`. Batches are applied in commit order and keys in first-appearance order, so launches reach the sink in creation order, and `loadInto` copies them in rowid order.

### Durable ids
Each batch records the highest event sequence and outbox id it carries, folded with the previous batch's. `durability().eventSeq` and `.outboxId` are the values of the last flushed batch (at construction, the image's maxima, because the image starts as a copy of the sink). An `INSERT OR IGNORE` that is ignored still consumes an AUTOINCREMENT id, and a rolled-back sequence number is reused; ids are increasing, not gap-free, and after a crash an unflushed id is issued again to a different row. That is why `GET /v1/outbox` and `GET /v1/events` return only ids up to the durable values.

### Flusher
One apply in flight at a time; on success the batch leaves the queue and any `durable()` waiter whose batch number is now flushed resolves. On failure it retries with doubling backoff (`retryBaseMs`, `retryMaxMs`). A timer armed for the oldest pending batch's `committedAt + flushDeadlineMs` catches a sink that stalls without ever rejecting; a failed apply checks the deadline too. `FencedError` (or any error with `fenced: true`) is fatal at once. `onFatal` is latched: called once, after which the flusher stops and `durable()` never resolves, so an effect behind an unflushed record never happens. `close()` closes the image; batches already committed keep flushing, so a caller that wants them awaits `durable()`.

### Durability before effects
`gateOnDurable(store, target, methods)` returns a Proxy whose listed methods (typed against `Workspace`, `AgentRunner` and `VerifierBackend`) wait for `store.durable()` and then call the real method with the real object as `this`. Methods are looked up per access, so a method replaced on the target after construction is still gated, and an absent optional method stays `undefined`. When nothing is pending the call is made synchronously, unchanged; with a plain `SqliteStore` nothing is ever pending, so the suite's timing is untouched. The Orchestrator constructor applies the gate, so every construction path, test harnesses included, gets it.

### HTTP
`dispatch` awaits `store.durable()` before sending any `POST` or `PUT` response, the 500 path included (a handler may have committed before throwing). `GET` answers from the image; status gains `storeLagMs` and `storePendingBatches`.

## Risks / Trade-offs

- A stalled sink stalls every effect and write response: intended; `onFatal` bounds it.
- The image is a full SQLite database (file or `:memory:`); memory use is the state's size, as today.
- `lagMs` is reported as at least 1 while a batch is pending, so a status probe never reports zero lag with batches outstanding.
- The gate covers the three injected effect interfaces. Other outward calls the orchestrator makes directly (for example `git` in readiness probes, which only reads) are not gated; tracker writes go through the outbox, whose listing is durable-only.

## Migration Plan

None: the daemon still constructs a plain `SqliteStore`. ORC-20 adds configuration to construct a `JournaledStore` over a sink, loads the image from the sink at boot, and maps `onFatal` to process exit.
