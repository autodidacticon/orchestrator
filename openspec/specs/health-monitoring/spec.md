# Health Monitoring Specification

## Purpose
How the daemon tells a working agent from a dead or stuck one and keeps a run inside its budgets: process liveness observed by the runner, which replaces silence as the failure signal; progress signals from the worktree, commits, API calls, and heartbeat text; stuck detection and escalation with a diagnosis hook; the launch time budget; usage accounting from launch logs; the run cost budget that pauses admission; and the base-moved notice that tells live agents when the integration head advances.

## Requirements

### Requirement: Process liveness
On every tick, in the reconcile phase, the daemon SHALL ask the runner for the liveness of each live launch as `alive`, `dead`, or `unknown`. `alive` SHALL renew the task's lease and feed the progress, stuck, and time-budget checks. `dead` SHALL be handled as before: a fallback file is applied, otherwise the task fails with reason `exitedWithoutReport`. `unknown` SHALL leave lease expiry as the only bound on silence. Runners that spawn processes SHALL derive liveness from the recorded pid; a runner that cannot observe its launches SHALL report `unknown`.

#### Scenario: Alive process renews the lease
- **WHEN** a running launch's process is alive and the agent has made no API call since the last tick
- **THEN** the lease `expiresAt` is extended by the TTL on this tick

#### Scenario: Dead process without a report is unchanged
- **WHEN** a running launch's process is dead and no fallback file exists
- **THEN** the task becomes `failed` with reason `exitedWithoutReport` and `attempts` increases

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
When a launch is observed dead or is ended, the daemon SHALL ask the runner for the launch's usage. `ClaudeCodeRunner.readUsage` SHALL parse the last JSON object in the launch log for `total_cost_usd`, `duration_ms`, and `num_turns`; a log without such an object SHALL yield no usage, and the scripted and in-process runners SHALL yield none unless scripted. Usage found SHALL be stored on the launch row as `costUsd`, `turns`, and `durationMs` and appended as `launch.usage`. The cost of a task SHALL be the sum over its launches and the cost of the run the sum over all launches, both derived from launch rows so that a restart cannot double count.

#### Scenario: Claude log tail parsed
- **WHEN** a launch log ends with the JSON object `claude -p --output-format json` prints, preceded by stderr lines
- **THEN** the launch row records `costUsd`, `turns`, and `durationMs` from `total_cost_usd`, `num_turns`, and `duration_ms`

#### Scenario: Log without JSON
- **WHEN** a launch log contains no JSON object
- **THEN** no usage is recorded and the launch's cost is unknown

#### Scenario: Cost survives restart
- **WHEN** two launches with recorded cost exist and the daemon restarts
- **THEN** `status` reports the same run cost and per-task costs as before

### Requirement: Run cost budget
Config `budgets.maxRunCostUsd` (default 0) SHALL mean unlimited when 0. The ceiling SHALL be `maxRunCostUsd` times one plus the number of overrides recorded. When the run cost reaches the ceiling, admission SHALL pause with `pausedReason: 'costBudget'` and `budget.exceeded`, while running work and verification continue. `resume` SHALL be refused while the run cost is at or above the ceiling unless called with `overrideBudget`, which SHALL record `budget.overridden`, raise the ceiling by one budget, and lift the pause.

#### Scenario: Budget crossed pauses admission
- **WHEN** the budget is 5 USD, two finished launches cost 3 USD each, and three tasks are ready
- **THEN** the run is paused with `pausedReason` `costBudget`, `budget.exceeded` is appended, and no new launch starts

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
