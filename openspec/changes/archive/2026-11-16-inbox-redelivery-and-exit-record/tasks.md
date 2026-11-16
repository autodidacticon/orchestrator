## 1. Inbox redelivery

- [x] 1.1 Pass a `connected` probe (the request socket is not destroyed) from the inbox route to `agentCall`.
- [x] 1.2 In `readInbox`, remove nothing when the caller is gone after the first durable wait; put the removed notices back at the front when it is gone after the removal's wait.
- [x] 1.3 Test: stall the sink, abandon an HTTP inbox read, release, and read the notice on the next call; and a caller gone while the removal waits gets the notices back in order.

## 2. Exit record

- [x] 2.1 Add `unflushedBatches`, `storeClosed` and `rejected` to `ExitRecord`, with `cleanExit`, `exitStoreFields` and `describeExit`.
- [x] 2.2 In `main.ts`, take the digest before the close and write the record after `opened.close()`; the grace timer reads `pendingBatches` first and writes `storeClosed: false`.
- [x] 2.3 The revival refusal names the loss.
- [x] 2.4 Tests: helper cases, a clean record after a route stop, the lost count after SIGTERM under a stopped Postgres session.

## 3. Rejection after abandon

- [x] 3.1 `JournalOptions.log`; a rejection after `abandon` is logged with its cause and kept.
- [x] 3.2 `closeJournaled` waits up to 1s for the apply in flight, then returns `rejected`; `openStore` passes the daemon's logger.
- [x] 3.3 Tests: a rejection after `abandon` is logged and returned, and a fenced failure is not logged.

## 4. Fatal before waiting

- [x] 4.1 `waitDurable(store)` and `StoreFatalError` in `src/state/gate.ts` throw at once on a fatal journal; the gate rejects at once.
- [x] 4.2 The server waits with `waitDurable` and answers 503 `storeFatal`.
- [x] 4.3 Tests: the gate with 0 and 2 pending batches, a journal turning fatal during the wait, and POST, heartbeat and inbox on a fatal journal.
