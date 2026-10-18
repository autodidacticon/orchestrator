## Context

`reconcile` in `src/loop/tick.ts` iterates live launches. A task's transition out of `running` clears its lease (`applyTransition` in `src/state/transitions.ts`), so after a submit the launch is neither `active` nor owned and falls into the branch that reaps, records usage, ends with `reported`, and removes the worktree. `ClaudeCodeRunner.readUsage` parses the last JSON object of the launch log, which the CLI prints only when it exits; a reaped process prints nothing. `recordUsage` is idempotent per launch.

## Goals / Non-Goals

**Goals:** record usage for submitted launches in spawn mode; keep the end reason, the worktree removal, and the handling of cancelled and superseded launches unchanged.

**Non-Goals:** usage for claimed launches (ORC-22 and ORC-29 in the cloud plan); changing how `dead` is handled for running tasks.

## Decisions

**One condition in the existing branch.** Before the reap in the `cancelled || (!active && !owns)` branch: if the entry is `submitted` or `done`, the process is alive, and `now - reportedAt < reportGraceMs`, `continue`. Everything else in the branch is unchanged, so a process that exited on its own is reaped as a no-op and ends `reported` with usage read from its complete log. Rejected: routing the dead case through `handleDeadLaunch`, which ends with `exited` and keeps the worktree for submitted tasks.

**An explicit `reportedAt` on the launch.** Set in `acceptSubmission` when the submit is recorded. Rejected: measuring from `progressAt`, which any API call moves and which `observeFingerprint` can move after the report.

**Grace is a config key with a short default.** `health.reportGraceMs` defaults to 30 000 ms; the CLI's exit takes well under a second after its last tool call, so the default is generous without being noticeable. 0 disables the grace, which the loop harness uses so that in-process tests, whose fake processes never exit by themselves, keep ending launches on the tick after submit.

## Risks / Trade-offs

- [A process that never exits after reporting holds the launch for the grace] → bounded by the grace; then reaped exactly as today.
- [Idle exit starts later] → by at most the grace, only on runs whose last launch lingers.
- [Recovery or `stop --reap` meets a live process on a submitted task] → both already skip or guard on `running`/`waiting`; `stop --reap` reaps and ends `reaped`, recovery leaves it for the next reconcile.
