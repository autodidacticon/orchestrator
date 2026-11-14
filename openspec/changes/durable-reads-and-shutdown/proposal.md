## Why

The review of CLOUD-M2 v1 (rejected 2026-11-13) found reads and a shutdown path that bypass the journal's durability (ORC-92):

- `GET /v1/launches/:id/inbox` is a GET, so the server does not hold its answer for durability. Its handler renews the lease, records a progress signal, clears `launch.notices` and returns the notices from memory. An operator's answer whose POST was still waiting for durability could reach the agent and then be lost in a crash, and the operator's retry might carry a different answer.
- `GET /v1/status` reported `latestSeq` from the memory image. Three clients (the operator MCP server's `wait`, the Codex work loop and `deploy/smoke.sh`) pass it to `/v1/events` as `after`. While the sink lags, that cursor is above the durable sequence, and after a crash those numbers belong to other events. `/v1/events` could also answer with a `seq` lower than the `after` it was given, so a cursor moved backwards.
- SIGTERM during a stall exited 0. `close()` waited 5 seconds, the 8-second grace timer logged "shutdown grace elapsed" and exited 0, and the unflushed batches were dropped without their count. Batches still queued when the sink closed were reported as `fenced`.
- The lease check accepted `leaseTtlMs` equal to `flushDeadlineMs`. The real margin is the TTL less the renewal interval, and a failing `/readyz` takes the pod out of its Service, so workers cannot renew during a stall.
- `flushOnce` could apply the same batch twice and drop the next one when it ran alongside another apply.

## What Changes

- **Durable inbox.** The inbox takes the notices the launch holds, waits until everything committed so far is durable (those notices' records, the lease renewal and the progress signal), then removes only the notices it took and waits for that write to be durable too. A notice queued during the wait stays for the next read. Inbox reads of one launch run one at a time, so no notice is handed out twice.
- **Durable cursor.** `GET /v1/status` `latestSeq` is now the durable event sequence number (`durability().eventSeq`), on both the loaded and the not-loaded status. `/v1/events` never answers a `seq` below the `after` it was given. When the page is cut by `limit`, `seq` is the page's last event. The operator MCP server's `wait` only moves its cursor forward. The Codex work loop and `deploy/smoke.sh` already read `latestSeq`, so they now get the durable value.
- **Shutdown with unflushed batches.** `OpenedStore.close()` resolves with `{ unflushedBatches }`. After its wait it calls the new `JournaledStore.abandon()`, which stops the flusher before the sink is closed, so the sink's own close is never reported as `fenced`. The daemon logs the count and exits 1 when the close leaves batches, and also when the grace timer fires with batches pending.
- **Lease margin.** Under Postgres, startup requires `leaseTtlMs - 2 × renewEveryMs >= flushDeadlineMs` (`renewEveryMs` is a third of the lease), which comes to about three times the deadline. The spec states how workers reach a daemon that is not ready: they don't. They keep retrying through the Service, and the lease is sized to outlast the stall.
- **Manual flush.** All applies run one after another through one chain, and a batch leaves the queue only when it is the batch that call applied. `flushOnce` cannot drop a batch, whatever `autoFlush` is.

## Capabilities

### New Capabilities

### Modified Capabilities
- `state-backend`: durable status cursor, shutdown with unflushed batches, lease margin above the flush deadline, serialized manual flush.
- `agent-protocol`: the inbox answers only durable notices, after its own writes are durable.

## Impact

- `src/state/journal.ts` (serialized applies, `abandon`), `src/state/open.ts` (`closeJournaled`, `CloseOutcome`), `src/main.ts` (exit 1 with the count), `src/config.ts` (`leaseCoversFlushDeadline`, `minLeaseTtlMs`).
- `src/loop/orchestrator.ts` (inbox, `latestSeq`), `src/operator/routes.ts` (`latestSeq`, the events cursor), `src/operator/mcp-server.ts` (the cursor only moves forward), `hosts/codex/bin/work.mjs` and `deploy/smoke.sh` (comments only).
- Tests: `test/state/journal.test.ts`, `test/state/store-selection.test.ts`, `test/slice/durability.test.ts`, `test/slice/store-postgres.test.ts`.
- Not changed, because they are outside this task's scope. `deploy/README.md` and the comment in `deploy/base/orchestrator.yaml` still say the lease must be "at least the deadline". The defaults (600000 and 120000) satisfy the new rule.
