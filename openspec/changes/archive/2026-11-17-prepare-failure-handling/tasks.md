## 1. Implementation

- [x] 1.1 `src/config.ts`: `prepareFailureLimit` and `prepareRetryBackoffMs`.
- [x] 1.2 `src/launch/prepare.ts`: `readPrepareRetry`, `prepareRetryDue`, `pendingPrepareRetries`, `clearPrepareRetry`; the count in `abandonPrepare`; the clear on success in `settlePrepareJobs`.
- [x] 1.3 `src/state/status.ts`: blocked kind `prepareFailed`; `src/state/transitions.ts`: row `running -> blocked`, orchestrator, `prepareFailed`.
- [x] 1.4 `src/loop/tick.ts`: admission skips a task before its `retryAt`.
- [x] 1.5 `src/loop/orchestrator.ts`: `transition()` clears the entry on `unblock`, `reopen`, `uncancel` and `cascade`; `quiescent()` is false while a retry entry of an `unstarted` task exists.

## 2. Tests

- [x] 2.1 `test/loop/prepare-failure.test.ts`.
- [x] 2.2 `test/state/transitions.test.ts`: the new row.
- [x] 2.3 `test/loop/prepare.test.ts`: the failure test launches again at `retryAt`.
