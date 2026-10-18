# Health Monitoring Specification

## Purpose
How the daemon tells a working agent from a dead or stuck one and keeps a run inside its budgets: process liveness observed by the runner, which replaces silence as the failure signal; progress signals from the worktree, commits, API calls, and heartbeat text; stuck detection and escalation with a diagnosis hook; the launch time budget; usage accounting from launch logs; the run cost budget that pauses admission; and the base-moved notice that tells live agents when the integration head advances.

## Requirements

### Requirement: Process liveness
On every tick, in the reconcile phase, the daemon SHALL ask the runner for the liveness of each live launch as `alive`, `dead`, or `unknown`. `alive` SHALL renew the task's lease and feed the progress, stuck, and time-budget checks. `dead` SHALL be handled as before: a fallback file is applied, otherwise the task fails with reason `exitedWithoutReport`. When the runner implements `readFailure` and returns a diagnosis `{ reason, detail? }` for the dead launch, the dead-launch record SHALL carry it: the failure's message SHALL name the reason and the detail, its `detail.runnerFailure` SHALL hold the diagnosis, and the `launch.ended` event SHALL carry `runnerFailure`. A runner without `readFailure`, or one that returns nothing, SHALL leave the record as before. The same SHALL hold for a launch found dead at recovery. `unknown` SHALL leave lease expiry as the only bound on silence. Runners that spawn processes SHALL derive liveness from the recorded pid; a runner that cannot observe its launches SHALL report `unknown`.

#### Scenario: Alive process renews the lease
- **WHEN** a running launch's process is alive and the agent has made no API call since the last tick
- **THEN** the lease `expiresAt` is extended by the TTL on this tick

#### Scenario: Dead process without a report is unchanged
- **WHEN** a running launch's process is dead, no fallback file exists, and the runner has no diagnosis
- **THEN** the task becomes `failed` with reason `exitedWithoutReport`, message `process exited without a report`, and `attempts` increases

#### Scenario: Dead process with the runner's reason
- **WHEN** a running Codex launch's process is dead, no fallback file exists, and its log shows an `error` event naming the unknown model `no-such-model`
- **THEN** the task becomes `failed` with reason `exitedWithoutReport`, the message contains `unknownModel` and the error text naming `no-such-model`, `detail.runnerFailure.reason` is `unknownModel`, and the `launch.ended` event carries the same `runnerFailure`

#### Scenario: Unknown liveness falls back to the lease
- **WHEN** the runner reports `unknown` for a running launch and no API call arrives for longer than the lease TTL
- **THEN** the task becomes `failed` with reason `leaseExpired` and `attempts` increases

### Requirement: Progress signals
For every live launch whose task is `running` and whose process is alive, the daemon SHALL compute a progress fingerprint each tick: the branch head sha plus a hash of `git status --porcelain` and `git diff HEAD` for the worktree, so that a further edit to an already dirty file still registers. The daemon SHALL record `progressAt` and `lastSignal` on the launch row when the fingerprint changes (`commit` when the head moved, otherwise `worktree`), when the agent makes any API call (`heartbeat`, `report`, `block`, `inbox`, `log`), when a heartbeat carries a `progress` text different from the previous one (`heartbeatText`, with the text kept as `progressText`), and when a `waiting` task resumes (`resumed`). A launch SHALL start with `progressAt` equal to `spawnedAt`, and its first fingerprint SHALL be a baseline that does not count as progress.

#### Scenario: Uncommitted edit is progress
- **WHEN** an agent modifies a tracked file in its worktree without committing and makes no API call
- **THEN** the next tick records `progressAt` with `lastSignal` `worktree`

#### Scenario: Commit is progress
- **WHEN** an agent commits on its launch branch
- **THEN** the next tick records `progressAt` with `lastSignal` `commit`

#### Scenario: Heartbeat text is progress
- **WHEN** an agent heartbeats with `progress` "writing tests" after an earlier "reading code"
- **THEN** `progressAt` is recorded with `lastSignal` `heartbeatText` and `progressText` "writing tests"

#### Scenario: Resume resets the idle clock
- **WHEN** a task that waited twenty minutes on a question is answered and admitted
- **THEN** `progressAt` is the resume time with `lastSignal` `resumed`

### Requirement: Stuck detection and escalation
Config `health.stuckAfterMs` (default fifteen minutes) and `health.stuckFailAfterMs` (default forty-five minutes) SHALL each be disabled when 0. When a `running` task's launch has been idle (`now - progressAt`) for longer than `stuckAfterMs`, the daemon SHALL flag it: record `stuckSince`, append `launch.stuck` with `idleMs`, queue an inbox notice `{ kind: 'stuck', idleMs, message }`, and invoke the stuck diagnoser once. New progress SHALL clear the flag and append `launch.unstuck`. When idleness exceeds `stuckFailAfterMs`, the daemon SHALL reap the process, end the launch, and transition the task `running -> failed` with reason `stuck`, increasing `attempts`. A `waiting` task SHALL never be flagged or failed as stuck. Status and the digest SHALL list flagged task ids under `stuck`.

#### Scenario: Silent agent is flagged, nudged, then failed
- **WHEN** `stuckAfterMs` is one second, `stuckFailAfterMs` is three seconds, and a scripted `hang` agent makes no progress
- **THEN** within the first threshold `launch.stuck` is appended and the `stuck` notice is on the launch, and after the second the process is gone, the task is `failed` with reason `stuck`, and `attempts` is one

#### Scenario: Progress clears the flag
- **WHEN** a flagged launch commits
- **THEN** the flag is cleared, `launch.unstuck` is appended, and the task is no longer listed under `stuck`

#### Scenario: Waiting task is never stuck
- **WHEN** a task is `waiting` on a question for longer than both thresholds
- **THEN** it is not flagged and not failed

#### Scenario: Thresholds disabled
- **WHEN** `stuckAfterMs` is 0
- **THEN** no launch is ever flagged and nothing is failed with reason `stuck`

### Requirement: Stuck diagnosis hook
The orchestrator SHALL accept a `StuckDiagnoser` whose `diagnose({ task, launch, idleMs, logTail, diffStat })` returns `{ action: 'wait' | 'nudge' | 'fail', message? }`, invoked once when a launch is flagged. `nudge` SHALL queue a `nudge` notice with the message, `fail` SHALL fail the task at once with reason `stuck` and the message, and `wait` SHALL do nothing. The default diagnoser SHALL be human: it returns `wait`, and the time-based escalation applies whatever the diagnoser answers.

#### Scenario: Default diagnoser waits
- **WHEN** a launch is flagged with the default diagnoser
- **THEN** only the `stuck` notice is queued and the task fails only after `stuckFailAfterMs`

#### Scenario: Diagnoser fails early
- **WHEN** a configured diagnoser returns `fail` with a message
- **THEN** the task becomes `failed` with reason `stuck` carrying that message before `stuckFailAfterMs`

### Requirement: Launch time budget
Config `budgets.maxLaunchMs` (default two hours) SHALL be disabled when 0. `elapsedMs` for a launch SHALL be wall time since `spawnedAt` excluding time its task spent `waiting`. When a `running` task's launch exceeds the budget, the daemon SHALL reap the process, end the launch, and transition the task to `failed` with reason `timeBudget`, increasing `attempts`.

#### Scenario: Launch past the budget is killed
- **WHEN** `maxLaunchMs` is two hours and a running launch reaches two hours of elapsed time
- **THEN** its process is reaped and the task is `failed` with reason `timeBudget` and `attempts` increased

#### Scenario: Waiting time is excluded
- **WHEN** a launch spent ninety minutes `waiting` and forty minutes running under a two-hour budget
- **THEN** its `elapsedMs` is forty minutes and it is not failed

### Requirement: Usage accounting
Usage SHALL have two sources, and the launch row and `launch.usage` SHALL name the source as `source`/`usageSource`. When a spawned launch is observed dead or is ended, the daemon SHALL ask the runner named on the launch row for the launch's usage. Each runner SHALL read its own log format:
- The Claude Code runner SHALL parse the last JSON object in the launch log for `total_cost_usd`, `duration_ms`, `num_turns`, and the `usage` object's `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`.
- The Codex runner SHALL sum the `usage` of every `turn.completed` line, as worker-runners "Codex usage parsing" states, and SHALL report no cost, turns, or duration.
- The scripted and in-process runners SHALL yield no usage unless scripted.

A log without usage SHALL yield no usage.

A claimed launch has no pid and no log, so it SHALL yield no runner usage, and the daemon SHALL NOT ask the runner for it. Its usage SHALL come only from its worker through `POST /v1/launches/:id/usage` (pull-runner "Worker usage"), stored with `source: 'worker'` through the same path, guard, and pricing as runner usage. Because launches with a pid are refused there, the two sources never apply to the same launch. Self-reported usage is not authoritative.

Usage SHALL carry `tokens` as `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }` in the same shape for every runner, and `source` naming the reader. `cachedInput` is counted inside `input`, so Claude's cache reads are added to its `input_tokens`.

A usage with any of a cost, turns, a duration, or tokens SHALL be recorded, so a usage with only tokens is recorded. A usage with tokens and no cost SHALL be priced as "Run cost budget" states, per million tokens and rounded to 1e-6:
- billable input `input - cachedInput` at `inputPerMTok`;
- `cachedInput` at `cachedInputPerMTok` (fallback `inputPerMTok`);
- `cacheWriteInput` at `cacheWriteInputPerMTok` (fallback `inputPerMTok`);
- `output` at `outputPerMTok`;
- `reasoningOutput` at `reasoningOutputPerMTok` (fallback `outputPerMTok`).

The pricing rests on two assumptions, both unverified: Codex's `cached_input_tokens` is a subset of `input_tokens`, and `reasoning_output_tokens` is NOT included in `output_tokens`.

Usage found SHALL be stored on the launch row as `costUsd`, `turns`, `durationMs`, `tokens`, `usageSource`, and `costSource` (see "Run cost budget"), and appended as `launch.usage`, whose payload carries the whole usage. `durationMs` SHALL stay unset when the runner reports none; `status.liveLaunches[].elapsedMs` gives wall time.

The cost and tokens of a task SHALL be the sums over its launches, and those of the run the sums over all launches. All of them SHALL be derived from launch rows, so that a restart cannot double count.

A headless agent writes its usage only when it exits. The daemon SHALL therefore record `reportedAt` on the launch when a submit is accepted. It SHALL leave a live launch whose task is `submitted` or `done` running while its process is alive and the report is younger than `health.reportGraceMs` (default 30000; 0 disables the grace). When the process exits or the grace elapses, the daemon SHALL record usage, reap what remains, end the launch with reason `reported`, and remove its worktree.

Token accounting does not change these grace mechanics: in every observed run, Codex wrote `turn.completed` with its usage after its final `agent_message`. Cancelled and superseded launches SHALL be reaped at once as before. A lingering launch delays the idle exit by at most the grace.

#### Scenario: Claude log tail parsed
- **WHEN** a launch log ends with the JSON object `claude -p --output-format json` prints, preceded by stderr lines
- **THEN** the launch row records `costUsd`, `turns`, and `durationMs` from `total_cost_usd`, `num_turns`, and `duration_ms`, and `tokens` from the `usage` object, with `usageSource` `claude-code` and `costSource` `reported`

#### Scenario: Codex log parsed
- **WHEN** a codex launch's log holds `codex exec --json` output with stderr lines between them
- **THEN** the usage read has the summed `turn.completed` tokens, `source` `codex`, and no cost, turns, or duration

#### Scenario: Usage with only tokens
- **WHEN** a runner reports `tokens: { input: 40361, output: 260 }` and no cost, turns, or duration for T1
- **THEN** the launch row stores the tokens, exactly one `launch.usage` carrying them is appended, and `status.tokens.run` and `status.tokens.byTask.T1` sum them

#### Scenario: Log without JSON
- **WHEN** a launch log contains no JSON object
- **THEN** no usage is recorded and the launch's cost is unknown

#### Scenario: Cost survives restart
- **WHEN** two launches with recorded cost exist and the daemon restarts
- **THEN** `status` reports the same run cost and per-task costs as before

#### Scenario: Submitted launch exits on its own within the grace
- **WHEN** T1 submits, its process stays alive for a few seconds and then exits, and the grace is 30 s
- **THEN** the launch is still `live` on the tick after the submit, and on the tick after the exit it ends with reason `reported` and carries the usage from its log

#### Scenario: Grace elapses
- **WHEN** T1 submits and its process is still alive when `health.reportGraceMs` has elapsed
- **THEN** the daemon records whatever usage the log holds, reaps the process, and ends the launch with reason `reported`

#### Scenario: Grace disabled
- **WHEN** `health.reportGraceMs` is 0 and T1 submits
- **THEN** the launch ends with reason `reported` on the next tick, as before

#### Scenario: Claimed launch takes its usage from the worker
- **WHEN** worker `w1` claims T1 and submits, and the runner would have usage for T1
- **THEN** the launch ends with no usage and no `launch.usage`, and a later post by `w1` records it with `usageSource` `worker`

### Requirement: Run cost budget
Config `budgets.maxRunCostUsd` (default 0) SHALL mean unlimited when 0. Config `budgets.prices` (default `{}`) SHALL map a model name (checked by the model-name pattern) to rates in USD per million tokens: `inputPerMTok`, `outputPerMTok`, and optional `cachedInputPerMTok`, `cacheWriteInputPerMTok`, and `reasoningOutputPerMTok`, each non-negative. When a runner reports a cost, the launch SHALL record it with `costSource: 'reported'` and SHALL NOT re-price it. When a runner reports tokens without a cost and `budgets.prices` has the launch's model, the daemon SHALL compute `costUsd` at record time with `costSource: 'priced'` as the sum of:
- `input - cachedInput` at `inputPerMTok`;
- `cachedInput` at `cachedInputPerMTok`, falling back to `inputPerMTok`;
- `cacheWriteInput` at `cacheWriteInputPerMTok`, falling back to `inputPerMTok`;
- `output` at `outputPerMTok`;
- `reasoningOutput` at `reasoningOutputPerMTok`, falling back to `outputPerMTok`;

each count divided by one million and the total rounded to 1e-6. Two assumptions about Codex's counts are assumed, unverified: `cached_input_tokens` is a subset of `input_tokens` (an observed 40361 input with 32128 cached is consistent), and `reasoning_output_tokens` is NOT included in `output_tokens`. When tokens are reported without a cost and the model has no price, the launch's cost SHALL stay unknown: it SHALL be excluded from the run cost and counted in `status.cost.unpricedLaunches` (launches whose row has `tokens` and no `costUsd`; a launch that ended with no usage at all is not counted), and the daemon SHALL log one warning per such model. The run cost, and so the ceiling, SHALL count priced and reported launches only; unpriced launches SHALL NOT pause admission. The ceiling SHALL be `maxRunCostUsd` times one plus the number of overrides recorded. When the run cost reaches the ceiling, admission SHALL pause with `pausedReason: 'costBudget'` and `budget.exceeded`, while running work and verification continue. `resume` SHALL be refused while the run cost is at or above the ceiling unless called with `overrideBudget`, which SHALL record `budget.overridden`, raise the ceiling by one budget, and lift the pause.

#### Scenario: Budget crossed pauses admission
- **WHEN** the budget is 5 USD, two finished launches cost 3 USD each, and three tasks are ready
- **THEN** the run is paused with `pausedReason` `costBudget`, `budget.exceeded` is appended, and no new launch starts

#### Scenario: Priced tokens cross the budget
- **WHEN** the budget is 5 USD, `budgets.prices` has the launches' model at 100 USD input and 1000 USD output per million tokens, and two finished launches each reported 40361 input and 260 output tokens with no cost
- **THEN** each row records `costUsd` 4.2961 with `costSource` `priced`, `unpricedLaunches` is 0, and the run is paused with `pausedReason` `costBudget`

#### Scenario: Unpriced tokens are visible but do not pause
- **WHEN** the budget is 5 USD and a finished launch reported tokens and no cost for a model with no price
- **THEN** its `costUsd` stays unset, `status.cost.runUsd` is 0, `status.cost.unpricedLaunches` is 1, and admission continues

#### Scenario: Reported cost is not re-priced
- **WHEN** a runner reports `costUsd` 0.5 with tokens for a model that has a price
- **THEN** the row records `costUsd` 0.5 with `costSource` `reported`

#### Scenario: Resume refused then overridden
- **WHEN** `resume` is called while the run cost is above the ceiling, then called again with `overrideBudget`
- **THEN** the first call is refused naming the cost and the ceiling, and the second records the override, lifts the pause, and raises the ceiling to 10 USD

### Requirement: Base-moved notice
When a verified task is published and `health.baseMovedNotice` is true (default), the daemon SHALL queue for every other live launch whose task is `running` or `waiting` an inbox notice `{ kind: 'baseMoved', head, files }` with the published sha and the files its commit touched, in the transaction that marks the published task `done`. A publication that leaves the integration head unchanged SHALL queue no notice.

#### Scenario: Sibling learns of the publish
- **WHEN** T1 is published with a commit touching `src/a.ts` while T5 is running
- **THEN** T5's next `inbox` call returns a `baseMoved` notice with the new head and `["src/a.ts"]`

#### Scenario: Notice disabled
- **WHEN** `health.baseMovedNotice` is false and T1 is published while T5 is running
- **THEN** T5's inbox stays empty
