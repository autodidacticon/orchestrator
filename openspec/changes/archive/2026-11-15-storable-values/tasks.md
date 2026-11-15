## 1. Storable values

- [x] 1.1 `src/state/storable.ts`: `storableString`, `storableJson`, `storableInt`, `bindRow`, `UnstorableValueError`, `isUnstorable`
- [x] 1.2 `SqliteStore`: every write binds through `bindRow` (JSON documents passed as values, serialized at the boundary)
- [x] 1.3 Tests: unit rules; check output with NUL and a cut surrogate pair in a job and a carry, on SQLite, the SQLite journal and Postgres, with reload equal to image; text columns with NUL

## 2. Callers answer 400

- [x] 2.1 `agentCall` checks `seq` (a non-negative safe integer) before any write; `seqOf` uses `Number.isSafeInteger`
- [x] 2.2 Worker usage counts are capped at `Number.MAX_SAFE_INTEGER`; the `/usage` route validates before recording `operator.usage`
- [x] 2.3 `ApiServer.dispatch` answers 400 `{ error, field }` for `UnstorableValueError`
- [x] 2.4 Tests: `log` with NUL text answers 200 on both backends and Postgres accepts the batch; `log` with `seq` 1.5 or 1e30 answers 400 naming `seq` and writes nothing; heartbeat, report and block likewise; HTTP 400 from the store's error

## 3. Rejected batches

- [x] 3.1 `RejectedBatchError` (not retryable; table, key, SQLSTATE; no row contents) and `FatalInfo.reason: 'rejected'`
- [x] 3.2 `PgSink.applyBatch` classifies SQLSTATE classes 22 and 23 after a successful rollback
- [x] 3.3 The journal calls `onFatal` at once for a rejection; readiness names it
- [x] 3.4 Tests: a Postgres data error (22P05, 22P02) is fatal at once with a deadline of ten minutes; a fake rejecting sink applies once; other errors still retry; the randomized run generates NUL and lone surrogates over SQLite and Postgres

## 4. Spec

- [x] 4.1 Deltas for `state-backend` and `agent-protocol`; `openspec validate storable-values --strict`
