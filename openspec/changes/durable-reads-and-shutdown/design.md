## Context

The journaled store (`journaled-store`, `store-selection`, `storable-values`, all unarchived) answers reads from the memory image and holds a POST or PUT response until its record is durable. ORC-92 lists the paths that bypassed this rule.

## Decisions

- **The inbox waits instead of filtering.** The inbox writes (lease renewal, progress signal, clearing the notices), so it waits like a write. An alternative was to hand out only notices whose batch has been flushed and leave the rest. That would still answer before the inbox's own writes are durable, which the acceptance criteria forbid. The inbox waits with `Orchestrator.waitDurable`, which throws once the store is fatal instead of hanging. The answer is then a 500, and the daemon is already exiting.
- **Only the taken notices are removed.** The old handler cleared the list. Clearing after a wait would also wipe a notice queued during the wait, which nobody has received. Removal goes by JSON identity, as a multiset, so equal notices are counted.
- **Inbox reads of a launch are serialized.** Two concurrent reads would otherwise each take the same notices across their waits.
- **`latestSeq` itself becomes durable, rather than adding a second field.** All three consumers, and any older client, then get a safe cursor without a version fallback. The image's sequence number is no longer reported. The lag is still visible as `storeLagMs` and `storePendingBatches`.
- **`/v1/events` `seq` is `max(after, …)`.** With durable cursors, `after` is never above the durable sequence, so this changes nothing for a correct client. It keeps a stale cursor from moving backwards. A page cut by `limit` now ends at its last event; before, `seq` jumped to the durable head and the operator MCP `wait` skipped the events past the page.
- **`abandon()` instead of changing `close()`.** `JournaledStore.close()` keeps its documented contract (committed batches keep flushing). `abandon()` is the explicit "stop now and count" a shutdown needs. After it, a failing apply is neither retried nor reported as fatal, so the sink's close cannot be reported as `fenced`.
- **The grace timer counts too.** `orch.stop()` can itself be stuck behind durability (a tick waiting in `waitDurable`), so the grace timer can be the path that exits. It reads `durability().pendingBatches` and exits 1 when that count is non-zero.
- **Lease margin: `leaseTtlMs - 2 × renewEveryMs >= flushDeadlineMs`.** A stall may begin just before a renewal was due, with `leaseTtlMs - renewEveryMs` of lease left. It lasts at most `flushDeadlineMs`. The margin above the deadline is one more renewal interval, for the first renewal after the daemon is ready again. With `renewEveryMs = floor(leaseTtlMs / 3)`, `3 × flushDeadlineMs` always passes. The rule uses the same `renewEveryMsOf` as the brief and the claim's lease facts.
- **Workers and a daemon that is not ready.** A failing `/readyz` removes the pod from its Service, and this change keeps that. Exposing a not-ready pod (`publishNotReadyAddresses`, or a worker-facing Service) would let a renewal reach the stalled daemon and extend the lease in the image, but its response would hang until the stall clears, and the extension is lost if the daemon then exits at the deadline. It is left as a follow-up (`deploy/base` is outside this change). Workers keep retrying (the work loop retries on its next beat, an agent's MCP call fails and is retried), and the lease is sized to outlast the stall.
- **Serialized applies.** `flushOnce` no longer waits for the flusher and then applies on its own. Every apply, from the flusher or from `flushOnce`, chains on the one before it. As a second guard, a batch leaves the queue only when it is still the head.

## Requirements this change narrows (unarchived)

These deltas are ADDED only, because `openspec/specs` has no `state-backend` spec yet (see `storable-values`). They narrow:
- `store-selection` "Lease versus flush deadline": a lease equal to the deadline is now refused.
- `store-selection` "Fatal flush" and `journaled-store` "Flusher and deadline": a shutdown with unflushed batches is also a non-zero exit with the count, and is not reported as fenced.
- `journaled-store` "Reads": the status `latestSeq` is durable, and the inbox is a read that waits.
- `agent-protocol` "Inbox notices for health" (archived): notices are handed out only once their records are durable.

## Risks

- The inbox can now take up to `flushDeadlineMs` to answer during a stall. The MCP shim and the work loop do not put a shorter timeout on it than on other agent calls. If the stall reaches the deadline, the daemon exits and the call fails, as a POST already did.
- The status no longer shows the image's sequence number. Nothing in the repository read it for anything other than a cursor.
