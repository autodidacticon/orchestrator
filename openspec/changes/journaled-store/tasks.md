## 1. Store interface

- [x] 1.1 `src/state/store.ts`: `Durability`; `Store.durable()`, `Store.durability()`, `Store.latestOutboxId()`
- [x] 1.2 `src/state/sqlite.ts`: always durable; `database()` for the journal; exported `SCHEMA`; `latestOutboxId()` as `MAX(id)`

## 2. Journal, sink, flusher

- [x] 2.1 `src/state/journal.ts`: temp-trigger key capture into `temp._journal`; harvest at depth zero into one batch of upserts (resulting row) and deletes (key) in first-appearance order; bare writes run as one transaction
- [x] 2.2 `JournalSink`, `FencedError`, `SqliteSink` (`applyBatch` in one transaction with `ON CONFLICT DO UPDATE`, `tables()`, `loadInto(image)`)
- [x] 2.3 Flusher: one apply in flight, in order, doubling backoff, deadline timer for stalls, latched `onFatal({ reason, unflushedBatches })`, `durable()` waiters by batch number, `flushOnce()` for manual pumping

## 3. Durability before effects and HTTP

- [x] 3.1 `src/state/gate.ts`: `gateOnDurable` Proxy over typed method lists; the `Orchestrator` constructor gates runner, workspace and verifier
- [x] 3.2 `src/agent/server.ts`: `POST`/`PUT` responses (and their 500s) wait for `store.durable()`
- [x] 3.3 `src/operator/routes.ts`: `GET /v1/outbox` and `GET /v1/events` return durable rows only; `storeLagMs`, `storePendingBatches` in status (also `orch.status()`)

## 4. Tests

- [x] 4.1 `test/state/backends.ts`; `test/state/sqlite.test.ts` and `test/state/outbox.test.ts` run on both stores, comparing sink and image after every journaled test; two-connection and two-process tests kept, labelled SQLite only
- [x] 4.2 `test/state/journal.test.ts`: seeded randomized run with crashes and reloads, idempotent re-apply, batch shape, deadline, stall, fenced, durable ids
- [x] 4.3 `test/slice/durability.test.ts`: stalled sink end to end; `harnessStore` in the slice and loop harnesses
- [x] 4.4 `npm test` green without `--retry`
