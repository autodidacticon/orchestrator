## Why

After ORC-130 (release 0.6.0 task 84c) a failed prepare command spends no attempt and the task is admitted again in the same tick, so a command that always fails runs without end. ORC-131 (task 84f) counts the failures of each task, waits a doubling backoff before the next launch, and blocks the task after a limit.

## What Changes

- Two top-level file keys beside `prepareCommand`, read at start: `prepareFailureLimit` (positive integer, default 3) and `prepareRetryBackoffMs` (non-negative integer, default 30000). Not overrides, not in the config report.
- One kv entry `prepareRetry`: a JSON object from task id to `{ failures, retryAt, last }`. Written only when `prepareCommand` is set.
- A prepare failure of a launch its task still runs on adds 1 to the task's count. Below the limit the task returns to `unstarted` and is not admitted, and takes no slot, before `retryAt` = failure time + `prepareRetryBackoffMs` × 2^(earlier failures), the factor capped at 32. At the limit it goes `running -> blocked` with reason `prepareFailed`, attempts and carry unchanged, and the entry is removed.
- `launch.prepareFailed` gains `failures` and `limit`, and `retryAt` when the task is not blocked.
- The entry is removed on a successful prepare, at the block, and by every transition with trigger `unblock`, `reopen`, `uncancel` or `cascade`.
- A retry entry of an `unstarted` task keeps the daemon from being quiescent.
- New blocked kind `prepareFailed`, set by the orchestrator only; agents cannot block with it.
- Transition table: `running -> blocked`, orchestrator, trigger `prepareFailed`.
- Exports in `src/launch/prepare.ts`: `readPrepareRetry`, `prepareRetryDue`, `pendingPrepareRetries`, `clearPrepareRetry`.

## Capabilities

### New Capabilities

### Modified Capabilities
- `pull-runner`: ADDED "Prepare failure limit".
- `task-lifecycle`: MODIFIED "Transition table enforcement" (from the text of change `prepare-command`) and "Structured blocked reasons".

## Impact

`src/config.ts`, `src/launch/prepare.ts`, `src/loop/tick.ts`, `src/loop/orchestrator.ts`, `src/state/status.ts`, `src/state/transitions.ts`, and tests.
