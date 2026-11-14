## 1. Durable inbox

- [x] 1.1 `Orchestrator.handleInbox`: take the held notices, `waitDurable`, remove only the taken notices, `waitDurable` again; reads of one launch serialized
- [x] 1.2 Tests (`test/slice/durability.test.ts`): a notice queued under a stall is not answered until the sink accepts it; a durable notice under a stall still waits for the inbox's own writes; a notice queued during the wait arrives on the next read; two concurrent reads hand out a notice once

## 2. Durable cursor

- [x] 2.1 `latestSeq` in `/v1/status` (loaded and not loaded) is `durability().eventSeq`
- [x] 2.2 `/v1/events` `seq` is never below `after`; a page cut by `limit` ends at its last event
- [x] 2.3 The operator MCP `wait` cursor only moves forward; the Codex work loop and `deploy/smoke.sh` read the durable `latestSeq`
- [x] 2.4 Tests: under a stall `latestSeq` equals the durable sequence; `after` above it answers `seq` equal to `after`; a limited page's `seq` is its last event

## 3. Shutdown with unflushed batches

- [x] 3.1 `JournaledStore.abandon()`; `closeJournaled` and `OpenedStore.close()` resolve with `{ unflushedBatches }`
- [x] 3.2 `main.ts`: the close and the grace timer log the count and exit 1 when batches are left
- [x] 3.3 Tests: `closeJournaled` under a stalled sink returns the count and nothing is fenced (`test/state/journal.test.ts`); a daemon with its Postgres session stopped exits 1 on SIGTERM and logs the count (`test/slice/store-postgres.test.ts`)

## 4. Lease margin

- [x] 4.1 `leaseCoversFlushDeadline` and `minLeaseTtlMs` in `src/config.ts`; `storeConfigError` states the margin and the minimum
- [x] 4.2 Tests: a lease equal to the deadline is refused; three times the deadline passes; the Postgres slice runs use leases that keep the margin

## 5. Manual flush

- [x] 5.1 Applies serialized in `JournaledStore`; a batch leaves the queue only if it is still the head
- [x] 5.2 Tests: concurrent `flushOnce` calls with `autoFlush` off and on apply every batch once, in order (the `autoFlush: false` case drops batches on the previous code)

## 6. Spec

- [x] 6.1 Deltas for `state-backend` and `agent-protocol`; `openspec validate durable-reads-and-shutdown --strict`
