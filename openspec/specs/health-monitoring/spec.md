# Health Monitoring Specification

## Purpose
How the daemon tells a working agent from a dead or stuck one and keeps a run inside its budgets: process liveness observed by the runner, which replaces silence as the failure signal; progress signals from the worktree, commits, API calls, and heartbeat text; stuck detection and escalation with a diagnosis hook; the launch time budget; usage accounting from launch logs; the run cost budget that pauses admission; and the base-moved notice that tells live agents when the integration head advances.

## Requirements

### Requirement: Process liveness
On every tick, in the reconcile phase, the daemon SHALL ask the runner for the liveness of each live launch as `alive`, `dead`, or `unknown`. `alive` SHALL renew the task's lease and feed the progress, stuck, and time-budget checks. `dead` SHALL be handled as before: a fallback file is applied, otherwise the task fails with reason `exitedWithoutReport`. When the runner implements `readFailure` and returns a diagnosis `{ reason, detail? }` for the dead launch, the dead-launch record SHALL carry it: the failure's message SHALL name the reason and the detail, its `detail.runnerFailure` SHALL hold the diagnosis, and the `launch.ended` event SHALL carry `runnerFailure`. A runner without `readFailure`, or one that returns nothing, SHALL leave the record as before. The same SHALL hold for a launch found dead at recovery. `unknown` SHALL leave lease expiry as the only bound on silence. Runners that spawn processes SHALL derive liveness from the recorded pid; a runner that cannot observe its launches SHALL report `unknown`. For the OpenCode runner the recorded pid leads the `sh` process group that holds `opencode` and its MCP child (the shim): liveness follows the `sh`, which lives as long as `opencode`, and reaping signals the whole group, so the shim does not outlive its launch. A dead launch's diagnosis also decides whether its failure is charged: see task-lifecycle "Retry and exhaustion" for `startupContended`.

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
For every live launch whose task is `running` and whose process is alive, the daemon SHALL compute a progress fingerprint each tick: the branch head sha plus a hash of `git status --porcelain` and `git diff-index -p HEAD` for the worktree, both excluding `.orchestrator/`, so that a further edit to an already dirty file still registers. A touch that leaves a tracked file's content unchanged SHALL NOT change the fingerprint. The daemon SHALL record `progressAt` and `lastSignal` on the launch row when the fingerprint changes (`commit` when the head moved, otherwise `worktree`), when the agent makes any API call (`heartbeat`, `report`, `block`, `inbox`, `log`), when a heartbeat carries a `progress` text different from the previous one (`heartbeatText`, with the text kept as `progressText`), and when a `waiting` task resumes (`resumed`). A launch SHALL start with `progressAt` equal to `spawnedAt`, and its first fingerprint SHALL be a baseline that does not count as progress. A remote launch (`access: remote`) has no worktree on the daemon's host: the daemon SHALL NOT compute its fingerprint (no `Workspace.fingerprint` call at reconcile), and its fingerprint SHALL instead come from its worker's heartbeats. A heartbeat body MAY carry `fingerprint`, the clone's fingerprint computed as above (the head sha, a colon, the hash). For a remote launch a malformed `fingerprint` SHALL be answered 400 naming the field before anything is written; a well-formed one SHALL be compared with the stored fingerprint exactly as a daemon-read one is: the first is a baseline, a changed value SHALL be stored on the row and recorded as `commit` when the head part changed and otherwise `worktree`, and the same value again SHALL record nothing. A remote heartbeat that carries `fingerprint` SHALL count as progress only through its fingerprint or a new `progress` text, not as a `heartbeat` signal, so that a worker loop's periodic heartbeats renew the lease without hiding an agent that makes no progress; stuck detection SHALL then work unchanged on the stored remote fingerprint. For a local launch a heartbeat's `fingerprint` SHALL be ignored.

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

#### Scenario: Content-preserving touch is not progress
- **WHEN** a formatter or checkout rewrites a tracked file's mtime without changing its content, and the agent makes no API call
- **THEN** the next tick's fingerprint equals the previous one and no `progressAt` is recorded

#### Scenario: Reconcile reads no remote tree
- **WHEN** the daemon reconciles a live remote launch whose task is `running`, under a workspace that counts its calls
- **THEN** `Workspace.fingerprint` is called zero times, while a local launch's reconcile calls it once per tick as before

#### Scenario: Remote heartbeat fingerprint is progress
- **WHEN** a remote launch's heartbeats carry a baseline fingerprint, then one with the same head and another hash, then one with another head, then the last one again
- **THEN** the second records `lastSignal` `worktree`, the third `commit`, each stores its value on the row, and the fourth records no `progressAt`

#### Scenario: Local heartbeat fingerprint is ignored
- **WHEN** a heartbeat of a local launch carries a `fingerprint`
- **THEN** the stored fingerprint is unchanged and the call counts as a `heartbeat` signal

#### Scenario: Remote launch stuck behind unchanged heartbeats
- **WHEN** `health.stuckFailAfterMs` is 30000 and a remote launch's heartbeats renew its lease every 10 s with a changing fingerprint for 80 s, then with an unchanged one
- **THEN** it is not failed while the fingerprint changes, and it is failed with reason `stuck` once the fingerprint has not changed for more than 30 s, as a local launch without progress is

### Requirement: Stuck detection and escalation
Config `health.stuckAfterMs` (default fifteen minutes) and `health.stuckFailAfterMs` (default forty-five minutes) SHALL each be disabled when 0. A launch's idle time SHALL be the awake time (see "Gap in the daemon's clock") from `progressAt` (or `spawnedAt`, or the launch's creation) to now. When a `running` task's launch has been idle for longer than `stuckAfterMs`, the daemon SHALL flag it: record `stuckSince`, append `launch.stuck` with `idleMs`, queue an inbox notice `{ kind: 'stuck', idleMs, message }`, and invoke the stuck diagnoser once. New progress SHALL clear the flag and append `launch.unstuck`. When idleness exceeds `stuckFailAfterMs`, the daemon SHALL reap the process, end the launch, and transition the task `running -> failed` with reason `stuck`, increasing `attempts`. A `waiting` task SHALL never be flagged or failed as stuck. Status and the digest SHALL list flagged task ids under `stuck`.

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

#### Scenario: A gap is not idle time
- **WHEN** a silent launch's machine sleeps for twice `stuckFailAfterMs` and a tick runs at the wake
- **THEN** the launch is still live with `attempts` unchanged and no `launch.stuck` is appended; a launch flagged before the sleep stays flagged, with no `launch.unstuck`; and once `stuckFailAfterMs` of awake time has passed without progress the task is `failed` with reason `stuck`

### Requirement: Stuck diagnosis hook
The orchestrator SHALL accept a `StuckDiagnoser` whose `diagnose({ task, launch, idleMs, logTail, diffStat })` returns `{ action: 'wait' | 'nudge' | 'fail', message? }`, invoked once when a launch is flagged. `nudge` SHALL queue a `nudge` notice with the message, `fail` SHALL fail the task at once with reason `stuck` and the message, and `wait` SHALL do nothing. The default diagnoser SHALL be human: it returns `wait`, and the time-based escalation applies whatever the diagnoser answers.

#### Scenario: Default diagnoser waits
- **WHEN** a launch is flagged with the default diagnoser
- **THEN** only the `stuck` notice is queued and the task fails only after `stuckFailAfterMs`

#### Scenario: Diagnoser fails early
- **WHEN** a configured diagnoser returns `fail` with a message
- **THEN** the task becomes `failed` with reason `stuck` carrying that message before `stuckFailAfterMs`

### Requirement: Launch time budget
Config `budgets.maxLaunchMs` (default two hours) SHALL be disabled when 0. `elapsedMs` for a launch SHALL be the awake time (see "Gap in the daemon's clock") since `spawnedAt` (or the launch's creation), excluding time its task spent `waiting`: `waitedMs`, which a resume grows by the awake time of the wait, and the awake time of a wait in progress. When a `running` task's launch exceeds the budget, the daemon SHALL reap the process, end the launch, and transition the task to `failed` with reason `timeBudget`, increasing `attempts`.

#### Scenario: Launch past the budget is killed
- **WHEN** `maxLaunchMs` is two hours and a running launch reaches two hours of elapsed time
- **THEN** its process is reaped and the task is `failed` with reason `timeBudget` and `attempts` increased

#### Scenario: Waiting time is excluded
- **WHEN** a launch spent ninety minutes `waiting` and forty minutes running under a two-hour budget
- **THEN** its `elapsedMs` is forty minutes and it is not failed

#### Scenario: A gap is not elapsed time
- **WHEN** a running launch's machine sleeps for twice `maxLaunchMs` and a tick runs at the wake
- **THEN** the launch is live with `elapsedMs` below the budget, and it is failed with reason `timeBudget` only once its awake elapsed time reaches the budget

### Requirement: Usage accounting
Usage SHALL have two sources, and the launch row and `launch.usage` SHALL name the source as `source`/`usageSource`. When a spawned launch is observed dead or is ended, the daemon SHALL ask the runner named on the launch row for the launch's usage. Each runner SHALL read its own log format:
- The Claude Code runner SHALL parse the last JSON object in the launch log for `total_cost_usd`, `duration_ms`, `num_turns`, and the `usage` object's `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`. It SHALL find that object whatever it holds when it starts a line within the last 256 KiB of the log: it SHALL try every `{` that starts a line before any other `{`, last first, and SHALL then try every `{`, last first, each pass at most 200 times. The object SHALL run to the end of the log; an object followed by another line SHALL yield no usage.
- The Codex runner SHALL sum the `usage` of every `turn.completed` line, as worker-runners "Codex usage parsing" states, and SHALL report no cost, turns, or duration.
- The OpenCode runner SHALL sum every `step_finish` line, as worker-runners "OpenCode usage parsing" states: cache reads folded into `input` as for Claude, the cost read from the stream as `costUsd`, `turns` the steps that ended with `reason: "stop"`, and no duration.
- The scripted and in-process runners SHALL yield no usage unless scripted.

A log without usage SHALL yield no usage.

A claimed launch has no pid and no log, so it SHALL yield no runner usage, and the daemon SHALL NOT ask the runner for it. Its usage SHALL come only from its worker through `POST /v1/launches/:id/usage` (pull-runner "Worker usage"), stored with `source: 'worker'` through the same path, guard, and pricing as runner usage. Because launches with a pid are refused there, the two sources never apply to the same launch. Self-reported usage is not authoritative.

Usage SHALL carry `tokens` as `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }` in the same shape for every runner, and `source` naming the reader. `cachedInput` is counted inside `input`, so Claude's cache reads are added to its `input_tokens`, and OpenCode's `cache.read` to its `tokens.input`. The sources are `claude-code`, `codex`, `opencode`, `scripted`, and `worker`.

A usage with any of a cost, turns, a duration, or tokens SHALL be recorded, so a usage with only tokens is recorded. A usage with tokens and no cost SHALL be priced as "Run cost budget" states, per million tokens and rounded to 1e-6:
- billable input `input - cachedInput` at `inputPerMTok`;
- `cachedInput` at `cachedInputPerMTok` (fallback `inputPerMTok`);
- `cacheWriteInput` at `cacheWriteInputPerMTok` (fallback `inputPerMTok`);
- `output` at `outputPerMTok`;
- `reasoningOutput` at `reasoningOutputPerMTok` (fallback `outputPerMTok`).

The pricing rests on two assumptions, both unverified: Codex's `cached_input_tokens` is a subset of `input_tokens`, and `reasoning_output_tokens` is NOT included in `output_tokens`.

Usage found SHALL be stored on the launch row as `costUsd`, `turns`, `durationMs`, `tokens`, `usageSource`, and `costSource` (see "Run cost budget"), and appended as `launch.usage`, whose payload carries the whole usage. `durationMs` SHALL stay unset when the runner reports none; `status.liveLaunches[].elapsedMs` gives wall time.

The cost and tokens of a task SHALL be the sums over its launches, and those of the run the sums over all launches. All of them SHALL be derived from launch rows, so that a restart cannot double count.

A headless agent writes its usage only when it exits. The daemon SHALL therefore record `reportedAt` on the launch when a submit is accepted. It SHALL leave a live launch whose task is `submitted` or `done` running while its process is alive and the report is younger than `health.reportGraceMs` (default 120000; 0 disables the grace). `health.reportGraceMs` SHALL be a config-file key read at start and SHALL NOT be a runtime override. When the process exits or the grace elapses, the daemon SHALL reap what remains, wait until the launch's process group is gone, then record usage, end the launch with reason `reported`, and remove its worktree. A process that does not exit after its report SHALL be reaped, and its launch ended, on the first tick at or after `health.reportGraceMs` from the report.

A reap SHALL send SIGTERM to the launch's process group and wait until the group is empty, polling, for at most the runner's kill grace (default 2000 ms); it SHALL then send SIGKILL to the group and wait at most 1000 ms more. So a usage line the agent writes while it is terminated is read. A pid that leads no group SHALL be waited for alone.

Token accounting does not change these grace mechanics: in every observed run, Codex wrote `turn.completed` with its usage after its final `agent_message`. Cancelled and superseded launches SHALL be reaped at once as before. A lingering launch delays the idle exit by at most the grace.

#### Scenario: Claude log tail parsed
- **WHEN** a launch log ends with the JSON object `claude -p --output-format json` prints, preceded by stderr lines
- **THEN** the launch row records `costUsd`, `turns`, and `durationMs` from `total_cost_usd`, `num_turns`, and `duration_ms`, and `tokens` from the `usage` object, with `usageSource` `claude-code` and `costSource` `reported`

#### Scenario: Codex log parsed
- **WHEN** a codex launch's log holds `codex exec --json` output with stderr lines between them
- **THEN** the usage read has the summed `turn.completed` tokens, `source` `codex`, and no cost, turns, or duration

#### Scenario: OpenCode log parsed
- **WHEN** an opencode launch's log holds `opencode run --format json` output with stderr lines between them
- **THEN** the usage read has the summed `step_finish` tokens with cache reads inside `input`, the summed `cost` as `costUsd`, `source` `opencode`, and no duration

#### Scenario: Cost read from the stream at zero
- **WHEN** an opencode launch on the free model `opencode/big-pickle` exits and its `step_finish` events carry `cost: 0`
- **THEN** the launch row has `tokens.input` and `tokens.output` above 0, `costUsd` 0 (present, not unset), and `usageSource` `opencode`, with exactly one `launch.usage` event
- **AND** the launch is priced: `status.cost.unpricedLaunches` does not count it and `status.cost.runUsd` stays 0

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
- **WHEN** T1 submits under the default `health.reportGraceMs` of 120000 and its process is still alive 119 s after the report and 120 s after it
- **THEN** the launch is `live` with its process alive on a tick 119 s after the report, and the tick 120 s after it reaps the process, records whatever usage the log holds, and ends the launch with reason `reported`

#### Scenario: Usage written 45 s after the report
- **WHEN** T1 submits under the default grace and its process writes its usage and exits 45 s after the report
- **THEN** the launch is `live` with its process alive on ticks up to then, and the next tick ends it with reason `reported` and the usage written

#### Scenario: Claude result line with many braces
- **WHEN** a Claude launch log ends with the result object on one line, and the object holds more than 200 `{` characters (a `permission_denials` entry whose `tool_input.command` holds 5000 of them)
- **THEN** the usage read has its cost, turns, duration, and tokens, and the object is found at the first try

#### Scenario: Usage written while the agent is terminated
- **WHEN** a launch is reaped and its agent, a child of the launch's shell, writes its result line 300 ms after it gets SIGTERM
- **THEN** the reap returns only after the agent has exited, so the usage read afterwards holds that line

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

### Requirement: Worktree observation takes no index lock
The daemon's git commands SHALL run with `GIT_OPTIONAL_LOCKS=0`. Its read-only git commands against a launch worktree SHALL never write the worktree's index or create its `index.lock`, so they never make the agent's own concurrent git command fail. The progress fingerprint SHALL therefore use `git status --porcelain`, which under `GIT_OPTIONAL_LOCKS=0` skips its index refresh, and the plumbing `git diff-index -p HEAD`, which never refreshes the index; it SHALL NOT use porcelain `git diff`, which refreshes the index and takes `index.lock` regardless of `GIT_OPTIONAL_LOCKS`. Commands that write SHALL take their locks as before.

#### Scenario: Agent commits while the daemon fingerprints
- **WHEN** an agent runs `git commit` in its worktree during the same tick in which the daemon computes that launch's progress fingerprint
- **THEN** the commit does not fail with "Unable to create '.../index.lock': File exists", and the launch is not failed as `exitedWithoutReport`

#### Scenario: Stat-dirty entries do not make the fingerprint write the index
- **WHEN** a tracked file in a launch worktree is touched without a content change, so its index entry is stat-dirty, and the daemon computes the fingerprint
- **THEN** the worktree's `.git/index` keeps its inode and mtime and no `index.lock` is created

#### Scenario: Observation still sees uncommitted edits
- **WHEN** an agent modifies a tracked file without committing
- **THEN** the next tick's fingerprint differs from the previous one and `progressAt` is recorded with `lastSignal` `worktree`, as without the setting

### Requirement: Suite reproduction of the half-removed worktree read
The test suite SHALL reproduce on demand, without product code changes, a tick fingerprint read of a released launch's worktree that `git worktree remove` has deleted part way. The silent-agent work-loop test SHALL take the absence of progress from the release's decision and the launch row at removal, not from the row read afterwards.

#### Scenario: Silent-agent progress race on demand
- **WHEN** the work-loop test "the loop renews the lease of a silent agent" runs with `ORCH_TEST_REPRO=silent-agent-progress`, which holds the tick's fingerprint read until the release has ended the launch and removed a tracked file with `.git` still present
- **THEN** the ended launch's row afterwards has `lastSignal: worktree`, and the test still passes, because `launch.released` has `progressed: false` and the row at removal has `progressAt` equal to the claim time

### Requirement: Suite reproduction of an agent alive after its report
The scripted test agent SHALL stay alive `ORCH_TEST_AGENT_EXIT_DELAY_MS` milliseconds after its behaviour when that variable is set. A test that checks a launch's end or its worktree after its task is `done` SHALL first wait for the launch to end. The crash harness's `waitTerminal` SHALL also wait until no launch is `preparing`, `launching` or `live`.

#### Scenario: Reported agent still running
- **WHEN** `test/slice/launch.test.ts` and `test/crash/crash.test.ts` run with `ORCH_TEST_AGENT_EXIT_DELAY_MS=400`
- **THEN** every test in them passes, the crash invariant `liveLaunches == 0` included

### Requirement: Gap in the daemon's clock
A *note* SHALL be one reading of the daemon's clock that the daemon remembers. A *gap* SHALL be two consecutive notes more than `health.gapAfterMs` apart, running from the earlier note to the later one. *Awake time* between two instants SHALL be their difference less the parts inside gaps, never below 0. The configuration SHALL accept `health.gapAfterMs` and `health.gapHoldMs`, non-negative integers in milliseconds, each optional with a default of 60000 and read at start; `gapAfterMs: 0` SHALL turn the whole rule off, so that no note is taken, no gap is noted, no timer runs and every limit counts wall time.

The daemon SHALL take a note from a timer that `start()` arms and `stop()` clears, every second or every quarter of `gapAfterMs` when that is shorter; at the start of every tick; where the reconcile phase reads the clock; inside the lease-expiry test of a claimed launch; and immediately before each use of idle time, elapsed time or the hold. The first note of a process SHALL NOT be a gap. A note earlier than the one before it SHALL NOT be a gap and SHALL become the reference for the next one. A timer note that finds a gap SHALL wake the loop. A note SHALL change memory only.

The tick SHALL write the gaps noted since the last write at its start and again where the reconcile phase reads the clock, and the lease-expiry test SHALL write them before it tests a lease. Each write SHALL be one transaction that appends one `daemon.gap` event per gap, with payload `{ from, to, gapMs, holdUntil }` (`holdUntil` is `to` plus `health.gapHoldMs`) and event time `to`, and renews the leases as pull-runner "Lease renewal after a gap" states. Awake time SHALL leave out every noted gap, written or not. A gap SHALL NOT be a progress signal.

A new orchestrator SHALL read the gaps of the run's earlier `daemon.gap` events when it is constructed. They SHALL count towards awake time and SHALL NOT start a hold. Time during which no daemon process ran SHALL NOT be a gap.

Writing a gap SHALL be activity for idle exit: the time of the last activity becomes the gap's end, with or without a hold. This excepts operator-control "Idle exit", whose list of what counts as activity does not name it. `status().liveLaunches[].idleMs` and `elapsedMs` SHALL be awake time; this excepts the sentence of health-monitoring "Usage accounting" that says `elapsedMs` gives wall time. No status field reports gaps or the hold.

`maxWaitMs`, the report grace, the claim window, push retry backoff, remote git timeouts, the check command's timer and the journal's flush deadline SHALL keep counting wall time. With no gap every value SHALL equal what wall time gives.

#### Scenario: A sleep is a gap written once
- **WHEN** a live launch is silent and the clock moves in one step from `t0` to `t1`, more than `health.gapAfterMs`, and a tick runs
- **THEN** one `daemon.gap` event is appended at `t1` with `from: t0`, `to: t1`, `gapMs: t1 - t0` and `holdUntil: t1 + health.gapHoldMs`

#### Scenario: Two gaps before one tick
- **WHEN** two gaps are noted before a tick runs
- **THEN** the tick appends two `daemon.gap` events, oldest first

#### Scenario: The first note and a backwards step are not gaps
- **WHEN** a process takes its first note long after the run's last event, or a note reads an earlier time than the one before it
- **THEN** no gap is noted, and the later note is the reference for the next one

#### Scenario: Gaps read at restart
- **WHEN** a second orchestrator is built on the same store after a gap was written
- **THEN** it reports the same `idleMs` and `elapsedMs` for each live launch as the first, and its first tick does not end a launch the first would keep

#### Scenario: The note timer wakes the loop
- **WHEN** the note timer fires after the clock jumped past `health.gapAfterMs` and no tick is due from the tick timer
- **THEN** the loop runs a tick that appends the `daemon.gap` event; after `stop()` no further firing occurs

#### Scenario: The rule is off
- **WHEN** `health.gapAfterMs` is 0 and the clock jumps by twice `health.stuckFailAfterMs` over a silent launch
- **THEN** no `daemon.gap` event is appended and the launch is failed with reason `stuck`

### Requirement: Hold after a gap
The hold SHALL run from the end of the latest gap the process noted until `health.gapHoldMs` later; `gapHoldMs: 0` SHALL turn it off, and a gap inside a hold SHALL start it again from its own end. During the hold nothing SHALL start: no admission, no resume of a waiting task, no spawn of a parked launch, no verifier job and no deferred-job pass. The admission phase SHALL test the hold after the pause test, and again (noting the clock first) before each resume, each new launch and each spawn of a parked launch, so a sleep in the middle of the pass stops the rest of it. A hold SHALL NOT stop claims, SHALL NOT change how a dead process or a cancelled task is handled, and SHALL NOT pause the run or count as a stall. While the hold is on the daemon's idle time SHALL be 0; this excepts operator-control "Idle exit", whose idle time is otherwise the time since the last activity. The `daemon.gap` event SHALL be the only trace of a hold.

#### Scenario: Nothing starts during the hold
- **WHEN** after a gap there is a ready task with free capacity, an answered waiting task, a queued verifier job and, in `mixed` mode, a parked launch past its claim window
- **THEN** ticks inside `health.gapHoldMs` append no `launch.created`, no `launch.live` and no transition with trigger `resumed`, the job stays `queued`, and the first tick after the hold does all four

#### Scenario: Claims and dead processes are not held
- **WHEN** during a hold a worker claims a parked launch in `pull` mode, and a spawned launch's process is found dead
- **THEN** the claim answers 200, and the dead launch's task fails as before with `attempts` increased

#### Scenario: The hold keeps a quiescent daemon
- **WHEN** a quiescent daemon with no session attached sleeps longer than `daemon.idleExitMs`
- **THEN** it does not exit during the hold, and exits once `daemon.idleExitMs` has passed after the hold with nothing to do

#### Scenario: Hold off
- **WHEN** `health.gapHoldMs` is 0 and a ready task waits
- **THEN** the tick after a gap admits it, and the daemon does not exit on that tick for idleness

### Requirement: Limits read at every check
The stuck check and the launch time budget check SHALL read `health.stuckAfterMs`, `health.stuckFailAfterMs` and `budgets.maxLaunchMs` from the effective configuration (the boot resolution with the stored override document applied) each time they test a launch, so a change applies on the next tick to every live launch, spawned or claimed. Idle and elapsed time are measured as "Stuck detection and escalation", "Launch time budget" and "Gap in the daemon's clock" state; only the limit they are compared with follows the override. A raised limit SHALL keep a launch that has not yet crossed it; a lowered or cleared limit SHALL apply at once. A launch already flagged stuck SHALL stay flagged until progress clears it, also after `health.stuckAfterMs` is raised. A change that lands while the tick is already ending a launch does not save it.

#### Scenario: A raised time budget saves a spawned launch
- **WHEN** a spawned launch has run 9500 ms under a `budgets.maxLaunchMs` of 10000, the override `budgets: { maxLaunchMs: 20000 }` is applied, and a tick runs 1000 ms later
- **THEN** the task is still `running`; a tick after the launch has run past 20000 ms ends it with reason `timeBudget`

#### Scenario: A raised time budget saves a claimed launch
- **WHEN** a claimed launch in `pull` mode is 9500 ms old under a budget of 10000, the same override is applied, and a tick runs 1000 ms later
- **THEN** the task is still `running`

#### Scenario: A raised fail limit saves a silent launch, which stays flagged
- **WHEN** with limits 1000 and 3000 a launch idle for 2500 ms is flagged stuck, `health: { stuckFailAfterMs: 6000 }` is applied, and a tick runs 1000 ms later
- **THEN** the task is `running` and the launch is still flagged stuck; once it has been idle for more than 6000 ms a tick fails it with reason `stuck` and `attempts` 1

#### Scenario: A raised flag limit leaves the flag
- **WHEN** a flagged launch makes no progress and `health.stuckAfterMs` is raised above its idle time
- **THEN** it stays in `status.stuck` and no second `launch.stuck` event is appended

#### Scenario: Zero at runtime
- **WHEN** `health: { stuckFailAfterMs: 0 }` is applied and a launch stays silent past the old fail limit
- **THEN** it is not failed

### Requirement: Time budget of a claimed launch
For "Launch time budget", the elapsed time of a launch SHALL start at `spawnedAt`, else at `claimableAt`, else at `createdAt`. So a claimed launch's elapsed time starts when it became claimable: the prepare command and the worktree's preparation do not count, time parked does, a spawned launch counts from `spawnedAt`, and the stuck clock is unchanged. `status().liveLaunches[].elapsedMs` SHALL use the same start.

#### Scenario: Claimed after a long install
- **WHEN** in `pull` mode with `budgets.maxLaunchMs` of one hour a launch's prepare command took 30 minutes and the launch was claimed 20 minutes after it was parked
- **THEN** it is still live 59 minutes after `claimableAt` with `elapsedMs` of 59 minutes, and is ended with `endReason` `timeBudget` one hour after `claimableAt`

#### Scenario: Spawned launch
- **WHEN** in `spawn` mode a launch's prepare command took 30 minutes and its agent has run for 5 minutes
- **THEN** its `elapsedMs` is 5 minutes

#### Scenario: Row without claimableAt
- **WHEN** a live launch has neither `spawnedAt` nor `claimableAt`
- **THEN** its elapsed time starts at `createdAt`
