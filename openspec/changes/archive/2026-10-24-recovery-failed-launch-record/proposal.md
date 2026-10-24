## Why

Startup recovery fails a launch found dead at restart with `o.fail(...)` directly, never through `failExited`, which only the tick's dead-launch handling uses. A launch that died while the daemon was down therefore records no `launch.failed` event, and a `startupContended` death there is always charged against the task's retries. task-lifecycle "Retry and exhaustion" requires every launch that dies without a report to be recorded as `launch.failed` with `charged`, and contended deaths within `health.contendedRetries` to be uncharged. Separately, `failExited` counts prior uncharged deaths before opening the transaction that appends the new event, so the allowance bound is only exact while ticks are serialised.

## What Changes

1. Recovery's dead-launch branch (process gone, no fallback file, task `running`) calls `o.failExited(launch, reason, 'deadOrExpired')` instead of `o.fail(...)`; the waiting and fallback branches are unchanged.
2. `failExited` reads the uncharged `startupContended` count inside the same store transaction that appends the `launch.failed` event.
3. Specs: crash-recovery "Recovery per boundary" states that a live launch dead at restart with no fallback file goes through the same dead-launch failure path as a tick, and task-lifecycle "Retry and exhaustion" states that the record and the allowance apply to deaths observed by startup recovery and that the count is read in the appending transaction.

## Capabilities

- `crash-recovery`: modified: "Recovery per boundary"
- `task-lifecycle`: modified: "Retry and exhaustion"

## Impact

* src/launch/recovery.ts, src/loop/orchestrator.ts
* test/health/contended.test.ts
