## Why

The review of CLOUD-M2 v1 (rejected 2026-11-13 at 5c427c4) found that a single value Postgres cannot store stops the daemon. Postgres refuses three things SQLite accepts: a `\u0000` escape in `jsonb` (SQLSTATE 22P05), a lone UTF-16 surrogate in `jsonb` (22P02), and a non-integer in a `bigint` column (22P02); it also refuses a NUL character in `text`. Agent calls put any string into JSON columns (a `log` text, a report, a question, heartbeat text) and any JSON number into `dedup.seq`. Check output is cut by UTF-16 unit, so it can end in half a surrogate pair, and it can contain NUL; it lands in `verifier_jobs.doc` and the task's carry.

`PgSink.applyBatch` rethrew such a refusal as an ordinary error. The journal retried the same oldest batch until `flushDeadlineMs`, then exited. Every later batch waited behind it and was lost, and a check that printed such output did the same again after each restart.

## What Changes

- **Storable values.** The store has one write boundary (`src/state/storable.ts`, `bindRow`), and `SqliteStore` binds every write through it. Every string bound to a text column, and every string and object key inside a value bound to a JSON column, has NUL characters and lone surrogates replaced with U+FFFD. Every value bound to an integer column must be a safe integer, or null where the column allows it. Otherwise the write throws `UnstorableValueError`, naming `table.column`, before anything is written. The memory image is a `SqliteStore`, so the SQLite backend, the image and the Postgres sink hold the same rows.
- **Callers answer 400.** The HTTP server (agent and operator routes) turns `UnstorableValueError` into a 400 with `field`. The agent `log`, `heartbeat`, `report` and `block` calls check `seq` before anything is written, including the lease renewal: it must be a non-negative safe integer. The worker `usage` call does the same for its token counts, and its route checks them before it appends its `operator.usage` event.
- **A rejected batch is fatal at once.** When Postgres refuses a batch with a data or constraint error (SQLSTATE classes 22 and 23), the sink rolls back and throws `RejectedBatchError`, which is not retryable. The error carries the refused row's table and key and the SQLSTATE, and nothing of the row's contents or the server's message. The journal calls `onFatal` immediately with reason `rejected` plus the table, key and SQLSTATE. It does not wait for `flushDeadlineMs`. Readiness names the rejection. Connection loss (fenced) and other errors (retried until the deadline) are unchanged.

## Capabilities

### New Capabilities

### Modified Capabilities
- `state-backend`: storable values at the write boundary; the `rejected` fatal reason for a batch refused for its content.
- `agent-protocol`: integer fields are checked before anything is written; an unstorable value answers 400 naming the field.

## Impact

- `src/state/storable.ts` (new), `src/state/sqlite.ts` (every write binds through `bindRow`), `src/state/journal.ts` (`RejectedBatchError`, `isRejected`, `FatalInfo.reason: 'rejected'`, readiness), `src/state/pg/sink.ts` (classification of SQLSTATE 22 and 23).
- `src/agent/server.ts` (400 for `UnstorableValueError`), `src/loop/orchestrator.ts` (`agentIntegerError`, `workerUsageError`, safe-integer `seqOf`), `src/operator/routes.ts` (usage is validated before it is recorded).
- Tests: `test/state/storable.test.ts`, `test/loop/storable.test.ts`, `test/agent/server.test.ts`, `test/state/journal.test.ts` (unstorable strings in the randomized run; rejected batches), `test/loop/harness.ts` (a `store` option).
- `src/main.ts` is unchanged. It logs `String(info.error)`, and for a rejected batch that string is the `RejectedBatchError` message: table, key and SQLSTATE.
