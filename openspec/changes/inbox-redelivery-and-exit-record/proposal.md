## Why

The review of CLOUD-M2 v2 (2026-11-14) found four gaps by reading the code (ORC-99):

- `readInbox` took a launch's notices, waited for durability, removed them and answered. When the caller gave up during the wait (a client timeout while the sink stalled), the notices were removed anyway and the answer went nowhere. The next read did not carry them.
- The shutdown handler wrote the exit record before `opened.close()` reported `unflushedBatches`, and the grace timer wrote it before reading `pendingBatches`. A daemon that exited 1 after losing records left a clean exit record, so revival and `status` described a clean stop.
- After `abandon()` the flusher returned without a word when `applyBatch` failed. A batch the sink rejected for its content at shutdown was counted as unflushed and its cause was lost.
- `gateOnDurable` waited on `store.durable()` even when the journal was already fatal, and a fatal journal never resolves it. The server's write responses did the same.

## What Changes

- **Inbox redelivery.** The HTTP route passes the inbox a probe that tells whether the caller's socket is still open. After the first durable wait, a read whose caller has gone removes nothing. After the removal's durable wait, a read whose caller has gone puts the removed notices back at the front of the launch's notices, ahead of any queued meanwhile. Either way the next read hands them out. A caller that went away gets status 499, which nobody reads. In-process callers of `agentCall` pass no probe and are treated as connected.
- **Exit record after the close.** The digest is taken before the store closes, because it reads the store. The record is written after `opened.close()` returns. It carries `unflushedBatches` when batches were lost, and `rejected` with the cause when the sink rejected one. The grace timer reads `pendingBatches` first. It writes `storeClosed: false` with `unflushedBatches` set to that count, even when the count is 0. A journal that turns fatal after a shutdown began writes the same kind of record, with the fatal condition's count, before it exits 1; a fatal condition with no shutdown under way still leaves no record, so it reads as a crash and is revived. A clean record, with none of those fields, is written only after the store closed with nothing unflushed. `cleanExit`, `exitStoreFields` and `describeExit` in `src/runs/runDir.ts` hold the rule. The revival refusal names the loss.
- **Rejection at shutdown logged.** `JournalOptions.log` receives a batch the sink rejects for its content after `abandon()`, with its message, SQLSTATE, table and key. `closeJournaled` waits up to 1s for the apply in flight to settle after the sink closes, then returns the rejection as `CloseOutcome.rejected`. The daemon passes its logger. Other failures after `abandon()` stay quiet; they are the sink closing.
- **Fatal before waiting.** `waitDurable(store)` and `StoreFatalError` move to `src/state/gate.ts`; `Orchestrator.waitDurable` delegates to it. They throw at once on a fatal journal, with or without pending batches. A gated method rejects at once with `StoreFatalError` and does not run. The server waits with `waitDurable` and answers 503 `{ error, code: 'storeFatal' }` when the journal is fatal.

## Capabilities

### New Capabilities

### Modified Capabilities
- `agent-protocol`: MODIFIED "Inbox notices handed out once" (a read whose caller left removes nothing, or puts back what it removed).
- `state-backend`: MODIFIED "Durability before effects" (a fatal journal refuses at once) and "Shutdown with unflushed batches" (a rejection after `abandon` is logged with its cause).
- `operator-control`: MODIFIED "Exit record" (written after the store's close, carrying lost batches).

## Impact

- `src/loop/orchestrator.ts`, `src/agent/server.ts`, `src/state/gate.ts`, `src/state/journal.ts`, `src/state/open.ts`, `src/main.ts`, `src/runs/runDir.ts`, `src/runs/lifecycle.ts`.
- `src/state/gate.ts` is outside the task's listed scope. The task's fact about `gateOnDurable` names it, and the fatal check belongs with the wait it guards.
- Tests: `test/slice/durability.test.ts` (an abandoned read over HTTP, a caller gone during the removal, a POST, the inbox and a gated call on a fatal journal); `test/state/journal.test.ts` (the gate on a fatal journal, a rejection after `abandon` logged and returned); `test/runs/lifecycle.test.ts` (a clean record after a route stop, the store fields, the revival message); `test/slice/store-postgres.test.ts` (SIGTERM under a stopped Postgres session records the lost count).
