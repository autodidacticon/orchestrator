## Why

The daemon ends a launch after a silence of `health.stuckFailAfterMs` and after a running time of `budgets.maxLaunchMs`, and flags it stuck after `health.stuckAfterMs`. No brief named any of these numbers: the only mention was "`stuck` when no progress has been observed for a while" in the notices sentence. A worker could not plan a long step against limits it was not told (ORC-109).

## What Changes

- `BriefInput` gets an optional `limits: { stuckAfterMs, stuckFailAfterMs, maxLaunchMs }`. `brief.json` carries the same object under `limits` when the input has it, and no `limits` key otherwise.
- `briefInput` always fills `limits` from the effective configuration (`health.stuckAfterMs`, `health.stuckFailAfterMs`, `budgets.maxLaunchMs`), for every access and runner kind.
- The Reporting section gets one line starting `- Limits:`, directly after the place of the lease line. It states each limit above 0 as a length of time with its config key and raw number: the stuck flag and its `stuck` notice, the silence after which the launch is ended and the attempt spent, and the time budget that ends the launch even while it makes progress. It says what counts as progress (a call to an operation, a new commit, a change in the worktree), tells the worker to call `heartbeat` between long steps and run long commands in the background, and to report or ask before the budget ends. It says the numbers are those in force when the brief was written, that the operator can change them during the run, and that a change arrives as a `nudge` notice in the inbox. A limit of 0 drops its part; with all three 0 there is no line.
- The line does not say when the budget clock starts, what it leaves out, or how idle time is measured.
- The notices sentence and the lease line are unchanged. Briefs composed from an input without `limits` (the golden fixtures) are unchanged.

## Capabilities

### Modified Capabilities

- `agent-protocol`: ADDED requirement "Brief states the limits in force".

## Impact

- `src/workspace/workspace.ts` (`BriefInput.limits`, `BriefLimits`), `src/brief/compose.ts` (`limitsRule`, `BriefJson.limits`), `src/loop/orchestrator.ts` (`briefInput`).
- Tests in `test/loop/brief-health.test.ts` and `test/loop/brief.test.ts`.
