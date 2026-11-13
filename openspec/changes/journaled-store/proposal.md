## Why

The cloud-native plan (Linear P-ORC-5, milestone M2) puts a run's state in Postgres so a daemon pod can be replaced without losing it. The original plan made every `Store` method return a Promise; there are 317 call sites in `src`, and about 42 synchronous orchestrator methods are atomic today only because nothing can interleave inside a synchronous function. Making them asynchronous would break that atomicity everywhere at once. The decision of 2026-11-12 keeps `Store` synchronous: the daemon keeps a synchronous memory image and writes its committed changes to a durable sink behind it, and anything with an outside effect waits until its record is durable. This change (ORC-10) builds that journal against SQLite only; the Postgres sink is ORC-15, configuration and process exit are ORC-20.

## What Changes

- New `src/state/journal.ts`: `JournaledStore implements Store`, wrapping a `SqliteStore` as its image. Every committed write is recorded as row operations (an upsert carrying the resulting row, or a delete by primary key), never as the original call. One top-level transaction, or one bare write, is one batch; a nested level that throws discards its own operations and a level that returns hands them to its parent. Event sequence numbers and outbox ids are assigned by the image and written explicitly. Applying a batch twice changes nothing.
- `JournalSink { applyBatch(ops) }`: one batch is one sink transaction. `SqliteSink` ships for tests and can load a fresh image (`loadInto`). A sink may throw `FencedError`, meaning this daemon no longer owns the run.
- A background flusher applies pending batches in order, retrying a failed batch with backoff. Options `flushDeadlineMs` and `onFatal`: when the oldest unflushed batch is older than the deadline (failing or stalled sink), or the sink reports fenced, `onFatal` is called once with the reason and the unflushed batch count.
- `Store` gains `durable()`, `durability()` (`{ lagMs, pendingBatches, eventSeq, outboxId }`) and `latestOutboxId()`. `SqliteStore` is always durable.
- The `Orchestrator` constructor wraps its `Workspace`, `AgentRunner` and `VerifierBackend` so every method awaits `store.durable()` first (`src/state/gate.ts`); with nothing pending the call runs at once, so a plain `SqliteStore` behaves exactly as before.
- HTTP: a `POST` or `PUT` response waits for `store.durable()`. `GET` answers from the image, except `GET /v1/outbox` (ids up to `durability().outboxId`) and `GET /v1/events` (sequence numbers up to `durability().eventSeq`, and the returned `seq` cursor likewise).
- `GET /v1/status` (and `orch.status()`) gains `storeLagMs` and `storePendingBatches`.

## Capabilities

### New Capabilities
- `state-backend`: the journal, its sink and flusher, `durable()` and `durability()`, durability before effects, which reads answer from the image and which return only durable rows, and the daemon as the only writer of its run's state.

### Modified Capabilities
- `crash-recovery`: "Store transactions" is worded for any backend; the two-process busy-wait and creation scenarios are kept and labelled SQLite-specific.

## Impact

- Code: new `src/state/journal.ts` and `src/state/gate.ts`; `src/state/store.ts` (interface), `src/state/sqlite.ts` (exported `SCHEMA`, `database()`, `durable()`, `durability()`, `latestOutboxId()`), `src/loop/orchestrator.ts` (gate in the constructor, status fields), `src/agent/server.ts` (write responses wait), `src/operator/routes.ts` (durable outbox and event reads, status fields).
- Tests: `test/state/sqlite.test.ts` and `test/state/outbox.test.ts` run against both stores (`test/state/backends.ts`); new `test/state/journal.test.ts` (seeded randomized run, idempotent re-apply, deadline, stall and fenced) and `test/slice/durability.test.ts` (stalled sink end to end); harnesses take an optional journal (`harnessStore`, and `ORCH_TEST_STORE=journal` runs a harness suite on the journal).
- No daemon boot or configuration change: the daemon still opens a plain `SqliteStore`, so laptop behaviour is unchanged. ORC-20 wires the journal, its config and `onFatal` to process exit.
