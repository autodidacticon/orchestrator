## Context

The journaled store (changes `journaled-store`, `postgres-journal-sink`, `store-selection`) keeps a SQLite memory image and flushes its rows, batch by batch and in order, to Postgres. A batch Postgres refuses is retried until `flushDeadlineMs`, and then the daemon exits. SQLite accepts values that Postgres refuses, so a value written to the image can stop the run.

Postgres refuses:

| Value | Column | SQLSTATE |
|---|---|---|
| `\u0000` escape | `jsonb` | 22P05 "unsupported Unicode escape sequence" |
| lone surrogate escape (`\ud800`) | `jsonb` | 22P02 "invalid input syntax for type json" |
| NUL character | `text` | 22021 "invalid byte sequence for encoding UTF8: 0x00" |
| `1.5`, `1e30` | `bigint` | 22P02 / 22003 |

`JSON.stringify` writes NUL and lone surrogates as `\u` escapes, so a JS string holding either becomes a document that `jsonb` refuses.

## Decisions

**One boundary, in `SqliteStore`.** `bindRow(table, row)` in `src/state/storable.ts` turns a row of column values into bind parameters. It uses the column kinds already declared for Postgres (`COLUMNS` in `pg/schema.ts`): `json`, `text` and `int`. Every `SqliteStore` write calls it. The image of a journaled store is a `SqliteStore`, so the rows harvested for the sink were already cleaned. Callers do nothing, and the plain SQLite backend holds the same rows as the Postgres one. The rule is not placed in `PgSink`: SQLite and Postgres would then disagree, and reload would not equal image.

**Replace strings; refuse integers.** A string that cannot be stored is replaced: each NUL and each lone surrogate becomes U+FFFD. Check output, agent logs and report text are informational, so losing one character is better than losing the write. An integer column has no safe replacement: rounding a `seq` would collide with another call's dedup key. So the write throws `UnstorableValueError(field = 'table.column')` before any statement runs. Inside `store.transaction` the throw rolls back the whole transaction.

**Text columns too.** The task names JSON columns. Postgres also refuses NUL in `text`, and several text columns carry caller strings: `events.task_id` from a claim body, `outbox.error` from a tracker, `kv.key` from an operator's attachment id. With rejection now fatal at once, any of these could stop the daemon. So text columns are cleaned the same way. Lone surrogates in `text` are cleaned as well: the `pg` driver would otherwise encode them as U+FFFD while SQLite kept the original, and the two backends would differ.

**Object keys are cleaned.** The heartbeat body and the `operator.usage` body are stored as given, so the caller chooses the keys. A key with NUL is cleaned like a value.

**Fast path.** `storableJson` serializes once. It cleans and serializes again only when the text contains a `\u0000` escape or a surrogate escape, so documents that are already clean are written exactly as before.

**Integer fields at the agent API.** `Number.isInteger(1e30)` is true, so `seqOf` and zod's `.int()` both accepted 1e30. `agentIntegerError` checks `seq` at the top of `agentCall`, after authentication and before `renewLease` and `recordProgress`, both of which write. It answers `400 { error, field: 'seq' }`. The worker usage schema caps counts at `Number.MAX_SAFE_INTEGER`, and the `/usage` route parses the body before it appends `operator.usage`. As a backstop, `ApiServer.dispatch` maps any `UnstorableValueError` to `400 { error, field }`.

**Content refusals are not retried.** `PgSink.applyBatch` runs the statements one at a time and remembers the index. On an error whose SQLSTATE class is 22 (data exception) or 23 (integrity constraint violation), it rolls back. If the rollback succeeds, it throws `RejectedBatchError` with the op's table, its primary-key values and the SQLSTATE. The message is built from those three fields only. The server's message and detail can quote values (for example `invalid input syntax for type bigint: "1.5"`, or a unique-violation detail), so they are kept only as `cause`, which `String(err)` does not print. The journal treats `retryable === false` as fatal at once (`reason: 'rejected'`, plus `table`, `key` and `sqlstate` on `FatalInfo`), like fenced. Connection loss still fences. Any other error is retried until the deadline as before.

**Why fatal and not skip.** Skipping a refused batch would leave the sink missing rows the image has, and later batches can depend on those rows. A refused batch now means a bug past the boundary. Stopping at once, with the table, key and SQLSTATE in the log, is better than stalling for the deadline and then exiting without the cause.

## Requirements this change narrows

`openspec/specs/` has no `state-backend` spec yet, so a MODIFIED delta cannot be archived: the archive refuses MODIFIED against a spec that does not exist. The deltas are therefore ADDED only. They narrow three requirements added by changes that are not yet archived. When those are archived together with this one, they should be read with this change's requirements taking precedence:

- `postgres-journal-sink` "Postgres sink": "A statement error on a live session SHALL roll the batch back and be reported as an ordinary error, which the journal retries". A data or constraint error (SQLSTATE class 22 or 23) is now a rejected batch, which is not retried. Its scenario "A batch fails part-way", a unique violation, now ends in a rejection that names `launches`, the key and `23505`. The rest holds: none of the batch's rows is written, the sink is not fenced, and the next batch applies.
- `journaled-store` "Flusher and deadline": `onFatal` reasons are `deadline`, `fenced` and now `rejected`, and `rejected` calls it at once.
- `store-selection` "Fatal flush" and "Store readiness": a rejected batch also ends the daemon at once, and it is a fatal condition for readiness.

`agent-protocol` "Deduplication" already requires `seq` to be an integer. "Integer fields" makes that a safe, non-negative integer that is checked before any write.

## Risks / Trade-offs

- A NUL in a text key (an attachment id, a task id) is stored as U+FFFD. A later lookup with the raw key does not find the row. Writes through the boundary (`deleteAttachment`) clean the key the same way and do find it.
- `src/verify/verifier.ts` `tail()` still cuts by UTF-16 unit. The boundary repairs the stored value; the verifier itself is out of this change's scope.
