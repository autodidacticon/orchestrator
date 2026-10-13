# Health monitoring: plan for change `add-health-monitoring`

## Context

v1 (`plans/0-orchestrator-v1/plan.md`) and the session operator (`plans/1-session-operator/plan.md`)
are implemented and archived. Conversation 7 on 2026-10-12 took up health: what the daemon
knows about a running agent, and what it does when that knowledge goes bad. This document
records the decisions and their reasoning; the OpenSpec change `add-health-monitoring` holds
the requirements, the design record, and the task checklist.

The defect that motivates it: the lease is renewed only by the agent's own API calls.
`renewLease` runs at the top of `agentCall` and nowhere else, and the MCP shim does not
heartbeat on its own. A Claude Code agent that works silently for longer than `leaseTtlMs`
(ten minutes) is reaped by the reconcile phase while alive and productive, fails with
`leaseExpired`, and spends an attempt. The real-agent runs never hit it because every task
finished in under two minutes. A daemon outage longer than the TTL would fail every adopted
agent on the first tick. Beyond that there is no stuck detection, no cost or time budget, and
no notice to an agent when a sibling lands on the integration branch.

Four other changes are pending: tracker sync, graph mutation, the pull-based runner, and
scheduling policy. This change isolates the lease path the pull runner will reuse.

## Decisions

1. **Liveness, not silence, decides failure.** For launches the daemon spawned it knows the
   pid. Every tick it asks the runner for liveness (`alive`, `dead`, `unknown`) and renews the
   lease while the process is alive. Lease expiry therefore fires only for `unknown`, which
   no runner reports today and pull-mode workers will. A dead process without a report is
   handled as before. Rejected: keep API-call renewal and rely on agents heartbeating;
   Claude Code does not reliably call tools mid-work.
2. **Progress signals.** Each tick the daemon fingerprints every running launch's worktree
   (head sha plus a hash of `git status --porcelain`, through `Workspace.fingerprint`). Any
   fingerprint change, any agent API call, a changed heartbeat text, and a resume record
   `progressAt` and `lastSignal` on the launch row. Rejected: commits and API calls only,
   because a long uncommitted edit looks stuck.
3. **Stuck is flag, nudge, then fail.** `health.stuckAfterMs` (15 min) flags the launch with
   `launch.stuck` and a `stuck` inbox notice; progress clears it with `launch.unstuck`;
   `health.stuckFailAfterMs` (45 min) kills the process and fails the task with reason
   `stuck`, spending an attempt. Either threshold at 0 disables that step. A waiting task
   is never stuck. Rejected: flag only (unattended runs sit), fail immediately (a slow but
   fine agent loses an attempt).
4. **Diagnosis is a hook.** `StuckDiagnoser.diagnose({ task, launch, idleMs, logTail,
   diffStat })` returns `wait`, `nudge`, or `fail`, the remediation hook's shape. Default
   human: `wait`, with the time escalation still applying. A model-backed diagnoser is
   deferred.
5. **Nudge is an operator operation.** `nudge <task> <message>` as a route, a CLI command,
   and an MCP tool queues a `nudge` inbox notice on the task's live launch and records an
   operator event; 409 without a live launch.
6. **Budgets: wall time per launch, cost per run.** `budgets.maxLaunchMs` (2 h) kills and
   fails with `timeBudget`, excluding time spent waiting. Cost is read once per launch at
   process exit by a runner-specific parser (`ClaudeCodeRunner.readUsage` reads the final
   JSON of `claude -p --output-format json`; the scripted runner yields none) and summed
   over launch rows. Crossing `budgets.maxRunCostUsd` pauses admission with
   `pausedReason: 'costBudget'`; `resume` is refused until called with `overrideBudget`,
   which raises the ceiling by one budget. Rejected: live cost through `stream-json`
   (deferred, parsing tied to the streaming format), wall time only.
7. **baseMoved notice.** When the verifier publishes while other launches are live, each gets
   `{ kind: 'baseMoved', head, files }` with the files the commit touched, queued in the
   transaction that marks the task done. The brief allows rebasing the launch branch onto
   the integration head, and the verifier rebases from the merge base so such branches
   verify. `health.baseMovedNotice` turns it off.
8. **Where things live.** Liveness, progress, stuck, and time-budget checks run in the
   reconcile phase, phase 1 of the tick; usage is read when a launch is observed dead or
   ended; the cost ceiling is checked at admission. All new facts are launch-row fields or
   events; the only new external effect is killing a process, already covered by recovery.
9. **Digest, wait, and the run skill.** The digest gains `stuck` and `pausedReason`; `wait`
   with `until: any` returns when they change because each change is an event. The run
   skill shows stuck tasks with idle time and offers nudge, cancel, or waiting, and on a
   budget pause reports the cost and offers resume with override.

## Implementation

Six task groups in `openspec/changes/add-health-monitoring/tasks.md`:

1. Process liveness and lease renewal (`AgentRunner.liveness`, renewal in reconcile and at
   adoption, existing lease tests moved to `unknown` liveness).
2. Progress signals (`Workspace.fingerprint`, launch-row fields, `src/health/progress.ts`,
   signals from `agentCall` and resume).
3. Stuck detection, escalation, and diagnosis (config, `src/health/stuck.ts`, the hook,
   `FailedKind` and transition rows for `stuck` and `timeBudget`).
4. Nudge and inbox notices (`nudge` on all three surfaces, brief wording, `changedFiles`
   from the verifier, merge-base rebase, `baseMoved` from `drainVerification`).
5. Budgets and usage accounting (config, `src/health/budgets.ts`, `readUsage`, the cost
   ceiling, `resume` refusal and override).
6. Operator surfaces and the run skill (`StatusReport` and `digestOf` fields, `wait`
   wording, `hosts/claude-code/skills/run/SKILL.md`, README).

Gate: group 3's slice test (a `hang` agent survives the TTL, is flagged, nudged, then failed
with `stuck`) and group 5's budget tests, with the crash suite unchanged and green.

## Verification

- `npm test` green, including the v1 crash suite and the session-operator MCP tests with
  `nudge` in the tool list; `claude plugin validate --strict hosts/claude-code` passes.
- Slice: a silent-but-alive scripted agent with `leaseTtlMs` below its runtime is never failed
  by the lease; with short `stuckAfterMs` and `stuckFailAfterMs` it is flagged, receives the
  notice through the inbox route, and fails with reason `stuck` and `attempts` incremented.
- Slice: a publish delivers `baseMoved` with the file list to a running sibling; a branch
  rebased onto the new head verifies to one trailer commit.
- Unit: the usage parser on a sample Claude JSON tail and on a log without JSON; cost sums
  per task and per run; budget pause, refused resume, override; store round trip after
  `restart()` keeps `progressAt` and cost.

## Deferred

- Live per-launch cost through `stream-json`, and per-task cost budgets.
- A model-backed stuck diagnoser, and `until: stuck` on `wait`.
- Narrowing the heartbeat signal to text changes if pull-mode workers heartbeat on a timer.
- A merge-base version of the structural no-op check.
- Scheduling by cost or by health facts (`add-scheduling-policy`).
