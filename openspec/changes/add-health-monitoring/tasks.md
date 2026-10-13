## 1. Process liveness and lease renewal

- [ ] 1.1 Add `liveness(launch): Promise<'alive' | 'dead' | 'unknown'>` to `AgentRunner` in `src/runner/runner.ts`; derive it from the recorded pid in `src/runner/subprocess.ts` and `src/runner/inproc.ts`; add a scriptable `unknown` to the in-process runner
- [ ] 1.2 In `reconcile` (`src/loop/tick.ts`, phase 1) renew the lease of every `alive` launch before the expiry check so expiry applies only to `unknown` liveness; keep `handleDeadLaunch` unchanged; expose `renewLease` in `src/loop/orchestrator.ts` to the tick
- [ ] 1.3 Recovery (`src/launch/recovery.ts`): renew the lease when adopting an `alive` launch so a daemon outage longer than the TTL does not fail surviving agents on the first tick
- [ ] 1.4 Harness support: `InprocRunner` in `src/runner/inproc.ts` scripts `unknown` liveness and usage per launch; `test/loop/harness.ts` and `test/slice/harness.ts` pass `health` and `budgets` config through and expose the inbox route for a launch
- [ ] 1.5 Move `test/slice/launch.test.ts` ("lease expiry reaps a hung agent") and `test/loop/scenarios.test.ts` ("lease expiry fails the task", retry brief with `leaseExpired`) onto `unknown` liveness
- [ ] 1.6 Tests (`test/loop/health.test.ts`, `test/slice/health.test.ts`): a `hang` scripted agent survives past a short `leaseTtlMs` while its process lives, `attempts` unchanged; `unknown` liveness still fails with `leaseExpired` and `attempts` incremented; a restart after an outage longer than the TTL adopts and renews

## 2. Progress signals

- [ ] 2.1 Add `fingerprint(launch): Promise<string>` to `Workspace` in `src/workspace/workspace.ts`; implement in `src/workspace/git-workspace.ts` as the head sha plus a SHA-256 of `git status --porcelain` minus `.orchestrator/`; scriptable in `src/workspace/fake.ts`
- [ ] 2.2 Launch row fields in `src/state/store.ts`: `progressAt`, `lastSignal`, `progressText`, `fingerprint`, `stuckSince`, `waitedMs`, `costUsd`, `turns`, `durationMs`; set `progressAt` to `spawnedAt` with `lastSignal: 'spawned'` in `src/launch/launch.ts`
- [ ] 2.3 Implement `src/health/progress.ts`: `observeFingerprint` (baseline on first sight, then `commit` when the head moved, else `worktree`) and `recordSignal(store, launch, kind, now, text?)`
- [ ] 2.4 Record signals in `agentCall` (`src/loop/orchestrator.ts`) for every operation and `heartbeatText` when the heartbeat `progress` differs; on resume in `admitAndLaunch` (`src/loop/tick.ts`) record `resumed` and add the wait to `waitedMs`
- [ ] 2.5 Call `observeFingerprint` from `reconcile` for every `alive` launch whose task is `running`, skipping launches whose last signal is newer than `tickIntervalMs`
- [ ] 2.6 Tests (`test/health/progress.test.ts`, `test/loop/health.test.ts`, `test/slice/health.test.ts`, `test/state/sqlite.test.ts`): fingerprint changes on an uncommitted edit and on a commit with the fake and the real git workspace; the first fingerprint is not progress; a changed heartbeat text is progress; resume resets the idle clock; the new fields round-trip through `SqliteStore`

## 3. Stuck detection, escalation, and diagnosis

- [ ] 3.1 Config in `src/config.ts`: `health.stuckAfterMs` (default 15 min), `health.stuckFailAfterMs` (default 45 min), `health.baseMovedNotice` (default true); 0 disables a threshold
- [ ] 3.2 Add `stuck` and `timeBudget` to `FailedKind` in `src/state/status.ts` and rows `running -> failed` by `orchestrator` with triggers `stuck` and `timeBudget` and effect `attempts++` in `src/state/transitions.ts`
- [ ] 3.3 Implement `src/health/stuck.ts`: the `StuckDiagnoser` interface, `humanDiagnoser` (returns `wait`), and `checkStuck`: flag (`stuckSince`, event `launch.stuck` with `idleMs`, `stuck` notice, one diagnoser call), unflag (`launch.unstuck`), escalate (reap, end launch, `fail` with reason `stuck`); never for `waiting`
- [ ] 3.4 Wire `checkStuck` into `reconcile` after liveness and the time budget; add `stuckDiagnoser` to `OrchestratorDeps`; pass `logTail` from `logPath` in `src/runner/subprocess.ts` and `diffStat` from the workspace; `nudge` from the diagnoser queues the notice, `fail` fails at once
- [ ] 3.5 Tests (`test/loop/health.test.ts`, `test/slice/health.test.ts`): with short thresholds a `hang` agent is flagged (`launch.stuck`, notice on the row and through the inbox route), then failed with reason `stuck` and `attempts` incremented; progress clears the flag with `launch.unstuck`; a waiting task is never flagged; thresholds at 0 disable; a scripted diagnoser returning `nudge` queues the notice and one returning `fail` fails immediately

## 4. Nudge and inbox notices

- [ ] 4.1 `Orchestrator.nudge(taskId, message)` in `src/loop/orchestrator.ts`: `operator.nudge` event plus `{ kind: 'nudge', message }` on the task's live launch; `ok: false` without one
- [ ] 4.2 Route `POST /v1/tasks/:id/nudge` (409 without a live launch) in `src/operator/routes.ts`; CLI `nudge <task> <message>` and usage in `src/operator/cli.ts`; MCP tool `nudge` in `TOOL_NAMES` of `src/operator/mcp-server.ts` and the usage text in `src/operator/mcp.ts`
- [ ] 4.3 Brief (`src/brief/compose.ts`): the workspace section names the `stuck`, `nudge`, and `baseMoved` notices and tells the agent to check `inbox` after long steps; the definition-of-done line allows rebasing the launch branch onto the integration head and forbids merging into, pushing to, or checking it out
- [ ] 4.4 Agent shim (`src/agent/mcp-shim.ts`): the `inbox` tool description names the `stuck`, `nudge`, and `baseMoved` notices and the `heartbeat` description says a changed `progress` text counts as progress
- [ ] 4.5 Verifier: the `published` outcome in `src/verify/job.ts` carries `changedFiles`; `src/verify/verifier.ts` rebases from `git merge-base` of the head and `sealedSha` and records `git diff --name-only` between the expected head and the rebased sha; `src/verify/fake.ts` scripts `changedFiles`; `runVerifierJob` stores it on the job row
- [ ] 4.6 `drainVerification` (`src/loop/tick.ts`): when applying a `published` job that moved the head and `health.baseMovedNotice` is on, queue `{ kind: 'baseMoved', head, files }` on every other live launch whose task is `running` or `waiting`, in the same transaction, with a `launch.notice` event
- [ ] 4.7 Tests: nudge through the route, the CLI, and the MCP tool produces `operator.nudge` and the notice, and 409 without a live launch (`test/slice/operator.test.ts`, `test/slice/operator-mcp.test.ts` with `nudge` in the tool list); `baseMoved` reaches a running sibling with the file list after a publish with the fake verifier (`test/loop/health.test.ts`) and the real one (`test/slice/health.test.ts`); a branch rebased onto the head verifies to one trailer commit (`test/slice/verifier.test.ts`); the brief names the notices (`test/loop/brief.test.ts`)

## 5. Budgets and usage accounting

- [ ] 5.1 Config in `src/config.ts`: `budgets.maxLaunchMs` (default 2 h, 0 disables) and `budgets.maxRunCostUsd` (default 0, unlimited)
- [ ] 5.2 Implement `src/health/budgets.ts`: `elapsedMs(launch, now)` as wall time since `spawnedAt` less `waitedMs`, `checkTimeBudget` (reap, end launch, `fail` with reason `timeBudget`), `runCostUsd` and `costByTask` as sums over launch rows, and `ceilingUsd` from `maxRunCostUsd` and the `budgetOverrides` kv
- [ ] 5.3 Add `readUsage?(launch): Promise<Usage | undefined>` to `AgentRunner`; `ClaudeCodeRunner.readUsage` in `src/runner/claude-code.ts` parses the last JSON object in `logPath(logDir, launchId)` for `total_cost_usd`, `duration_ms`, and `num_turns`; `SubprocessRunner` returns none; `InprocRunner` scripts it
- [ ] 5.4 Read usage when a launch is observed dead or ended (`reconcile`, `handleDeadLaunch`, `recover`, and the reap paths), store `costUsd`, `turns`, `durationMs` on the row, append `launch.usage`
- [ ] 5.5 Cost ceiling at the top of `admitAndLaunch`: pause with `pausedReason: 'costBudget'` (kv) and `budget.exceeded` when the run cost reaches the ceiling; `pause()` records `pausedReason: 'operator'`; `resume({ overrideBudget })` refuses with 409 while at or above the ceiling unless overriding, which increments `budgetOverrides`, appends `budget.overridden`, and lifts the pause; route body, CLI `--override-budget`, and the MCP `resume` argument
- [ ] 5.6 Tests (`test/health/usage.test.ts`, `test/loop/health.test.ts`, `test/slice/health.test.ts`): the parser on a sample Claude JSON tail preceded by stderr noise and on a log with no JSON; a launch past `maxLaunchMs` is killed and fails with `timeBudget`, `attempts` incremented; waiting time is excluded; scripted usage accumulates per task and per run; crossing the budget pauses admission while running work verifies; `resume` refused then accepted with override; cost and `progressAt` survive `restart()`

## 6. Operator surfaces and the run skill

- [ ] 6.1 `StatusReport` in `src/loop/orchestrator.ts`: `stuck`, `pausedReason`, `cost { runUsd, byTask, ceilingUsd, overrides }`, `budgets`, and per live launch `elapsedMs`, `progressAt`, `lastSignal`, `idleMs`, `stuck`, `costUsd`; `digestOf` in `src/operator/routes.ts` gains `stuck` and `pausedReason`
- [ ] 6.2 `wait` in `src/operator/mcp-server.ts`: tool description states that `until: any` returns on `launch.stuck`, `launch.unstuck`, and `budget.exceeded`; `status` and `resume` descriptions updated
- [ ] 6.3 `hosts/claude-code/skills/run/SKILL.md`: on `stuck`, show each task with its idle time from `status` and offer nudge with a message, cancel, or waiting; on `pausedReason: costBudget`, report the run cost and ceiling and offer `resume` with `overrideBudget` or stopping; never override unasked
- [ ] 6.4 README: document the `health` and `budgets` config, `nudge` and `resume --override-budget`, and the stuck and budget behaviour (the index entries for this change and `plans/3-health/plan.md` already exist)
- [ ] 6.5 Tests: status and digest carry the new fields (`test/slice/events.test.ts`, `test/slice/operator.test.ts`); `wait` returns on a stuck event (`test/slice/operator-mcp.test.ts`); the scripted end to end (`test/e2e/scripted.test.ts`) runs with budgets on and no false failure; the crash suite (`test/crash`) stays green with the new reconcile steps; `claude plugin validate --strict hosts/claude-code` passes
