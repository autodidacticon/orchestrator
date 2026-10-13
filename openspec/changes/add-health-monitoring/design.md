## Context

Leases were designed as the maximum tolerable silence, renewed by heartbeats, API calls, and open long-polls. In practice the only renewal is the agent's own traffic: `renewLease` in `src/loop/orchestrator.ts` is called at the top of `agentCall` and nowhere else, and the shim does not heartbeat on its own. The reconcile phase (`src/loop/tick.ts`, phase 1 of five) reaps a live process whose lease expired, fails the task with `leaseExpired` through the orchestrator's `running -> failed` transition, which increments `attempts`, and retries or exhausts in the same transaction. Claude Code works silently for long stretches, so a real task longer than ten minutes would be killed while productive, and a daemon outage longer than the TTL would do the same to every adopted agent at the first tick. Nothing detects an agent that is alive but idle, nothing bounds cost or wall time, and a sibling's publication reaches an agent only as a rebase conflict at verification. Conversation 7 (2026-10-12) decided the design below. Constraints: the orchestrator is the sole writer; every new fact must be a launch-row field or an event; the tick must stay cheap; agents pull their inbox, so notices are best effort.

## Goals / Non-Goals

**Goals:**
- Never fail a task because its process was quiet while alive.
- Detect, announce, and eventually fail an agent that makes no progress, with an operator nudge in between.
- Bound a launch's wall time and a run's cost, with an explicit operator override.
- Tell running agents when the integration head moves and what moved.
- Keep the restart story intact: adopted launches keep their progress and cost facts.

**Non-Goals:**
- Live per-launch cost from a streaming runner format.
- A model-backed stuck diagnoser; only the hook ships.
- Pull-mode workers (`add-pull-runner`), which will use the lease path this change isolates.
- Per-task cost budgets or scheduling by cost (`add-scheduling-policy`).

## Decisions

**Liveness by process, renewed by the daemon.** `AgentRunner` gains `liveness(launch)` returning `alive`, `dead`, or `unknown`; the subprocess and in-process runners derive it from the recorded pid. In the reconcile phase an `alive` launch has its lease renewed before any expiry check, so expiry can fire only for `unknown` liveness, which no runner reports today and the pull runner will. `dead` is handled exactly as before: fallback file, else `exitedWithoutReport`. Rejected: keep API-call renewal and ask agents to heartbeat. Claude Code does not reliably call tools mid-work, and a rule agents must remember is not a safety property.

**Progress is worktree change, commit, any API call, or new heartbeat text.** `Workspace.fingerprint(launch)` returns the branch head sha plus a SHA-256 of `git status --porcelain`; the fake workspace scripts it. Reconcile compares it with the stored fingerprint and records `progressAt` and `lastSignal` (`commit` or `worktree`); `agentCall` records the operation name; a heartbeat whose `progress` text differs records `heartbeatText` and keeps the text for status; a resume records `resumed` so waiting time never reads as idleness. The first fingerprint is a baseline. Rejected: commits and API calls only, because an agent editing for a long time without committing looks stuck.

**Stuck is flag, nudge, then fail.** `health.stuckAfterMs` (fifteen minutes) flags the launch, appends `launch.stuck`, queues a `stuck` inbox notice, and invokes the diagnoser once; new progress appends `launch.unstuck` and clears the flag; `health.stuckFailAfterMs` (forty-five minutes) reaps, ends the launch, and fails the task with reason `stuck`, spending an attempt because idling is the agent's doing. Either threshold at 0 disables that step. `waiting` tasks are never stuck. Rejected: flag only, which leaves unattended runs sitting; fail immediately, which costs a slow but fine agent an attempt.

**Diagnosis is a hook, default human.** `StuckDiagnoser.diagnose({ task, launch, idleMs, logTail, diffStat })` returns `wait`, `nudge` with a message, or `fail` with a message, mirroring the remediation hook. The default returns `wait`; the time-based escalation applies whatever the hook says. A model-backed diagnoser waits for evidence of what stuck agents look like.

**Nudge is an operator operation.** `POST /v1/tasks/:id/nudge`, `orchestrator-ctl nudge`, and the MCP tool `nudge` share one implementation that records `operator.nudge` and appends a `nudge` notice to the task's live launch, 409 without one. Agents pull their inbox, so delivery is best effort and the brief says so.

**Budgets: wall time per launch, cost per run.** `budgets.maxLaunchMs` (two hours) is enforced in reconcile on `elapsedMs`, wall time since `spawnedAt` less time spent `waiting`, and fails with `timeBudget`. Cost is read once per launch when it is observed dead or ended: `ClaudeCodeRunner.readUsage` parses the last JSON object of the launch log, where `claude -p --output-format json` prints `total_cost_usd`, `duration_ms`, and `num_turns`; other runners yield nothing. Totals are sums over launch rows, so a restart cannot double count. The ceiling is `maxRunCostUsd` times one plus the overrides recorded; reaching it pauses admission with `pausedReason: 'costBudget'`, and `resume` is refused with 409 until called with `overrideBudget`, which raises the ceiling by one budget. Rejected: switching the runner to `stream-json` for live cost, which ties parsing to Claude Code's streaming format; wall time only, which says nothing about spend.

**Base-moved notices come from the verifier job.** The backend records `changedFiles` on the published outcome, and `drainVerification` queues `{ kind: 'baseMoved', head, files }` for every other live launch in the transaction that marks the task `done`, so the notice is exactly-once under crashes. The brief's workspace section allows rebasing the launch branch onto the integration head, and the verifier rebases from the merge base of the head and `sealedSha` so a rebased branch does not replay published commits. `health.baseMovedNotice` turns the notice off.

**Everything new is a launch-row field or an event.** Progress, stuck, waited time, and usage live on the launch row (JSON documents in SQLite, so no schema change); flags and budget decisions are events. The only new external effect is killing a process, which recovery already covers. Nothing is added to crash-recovery.

## Risks / Trade-offs

- [Fingerprinting runs two git commands per running launch per tick] -> both are cheap on a worktree, capacity is small, and the check skips a launch whose last signal is newer than the tick interval.
- [An agent killed by stuck, time budget, or cancel never prints its final JSON, so its cost is unknown] -> status leaves `costUsd` unset for such launches and the run total is a floor; live cost through `stream-json` is deferred.
- [A heartbeat loop with unchanged text counts as progress] -> acceptable for Claude Code, which never heartbeats on a timer; if pull-mode workers do, narrow the heartbeat signal to text changes.
- [Stuck thresholds are global] -> both are config; per-task overrides can ride on the scheduling change.
- [A notice is never read by an agent that never calls `inbox`] -> escalation and the verifier's rebase still work; the brief tells agents to check the inbox after long steps.
- [Rebasing onto the head lets an undeclared empty submission slip past the `sealedSha == baseSha` check] -> the verifier's no-op path publishes nothing; tightening the structural check to the merge base is an open question.

## Migration Plan

No store migration: new fields are optional members of the launch JSON document and new events are new kinds. Launches adopted without `progressAt` are treated as progressing at adoption time. Defaults keep behaviour for everyone except that a quiet live process is no longer failed; tests that relied on lease expiry for a hung process switch to a runner reporting `unknown` liveness. The `health` and `budgets` config blocks are optional.

## Open Questions

- Whether the structural no-op check should compare against the merge base now that agents may rebase.
- Whether `wait` should accept `until: stuck`; today `any` returns on the stuck events.
- How the pull runner reports liveness for workers that heartbeat on a timer, and whether the heartbeat signal should then require changed text.
- Whether a model-backed diagnoser may answer the agent's question itself, or only nudge.
