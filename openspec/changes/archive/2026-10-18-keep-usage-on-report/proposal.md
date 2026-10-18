## Why

In spawn mode a launch's cost is read from the launch log, which `claude -p --output-format json` writes once, at exit. But a submit clears the task's lease, and the next reconcile treats the still-running process as superseded and reaps it at once, so the agent is killed before it prints its usage and every launch records no cost. The overnight run showed it: six published tasks, run cost zero, and `budgets.maxRunCostUsd` unenforceable. A short grace after the report, during which the process is left to exit on its own, keeps the usage without changing what the launch means.

## What Changes

- The launch row records `reportedAt` when a submit is accepted.
- A live launch whose task is `submitted` or `done` is left alone while its process is alive and the report is younger than `health.reportGraceMs` (default 30 s). When the process exits, or the grace elapses, the daemon records usage, reaps whatever is left, ends the launch with reason `reported`, and removes the worktree as today. Cancelled and superseded launches are still reaped at once.
- `health.reportGraceMs` is a config key; 0 restores the immediate reap. The loop test harness sets 0 so existing in-process scenarios keep their timing.
- The usage accounting spec says so, and notes that a lingering launch delays idle exit by at most the grace.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `health-monitoring`: `Usage accounting` gains the report grace and the config key.

## Impact

- Code: `src/config.ts`, `src/state/store.ts` (`Launch.reportedAt`), `src/loop/orchestrator.ts` (`acceptSubmission`), `src/loop/tick.ts` (reconcile), `test/loop/harness.ts`, `test/loop/health.test.ts`.
- Behaviour: in spawn mode a submitted task's agent process survives up to 30 s longer than before, which is how long `claude -p` needs to print its result; cost appears on the launch row and `budgets.maxRunCostUsd` becomes enforceable. The daemon's idle exit can start up to 30 s later. `stop --reap` and recovery already guard on `running`/`waiting` before failing a task, so a lingering process on a submitted task is reaped or adopted without a state error.
