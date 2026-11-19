## MODIFIED Requirements

### Requirement: Process liveness
On every tick, in the reconcile phase, the daemon SHALL ask the runner for the liveness of each live launch as `alive`, `dead`, or `unknown`. `alive` SHALL renew the task's lease and feed the progress, stuck, and time-budget checks. `dead` SHALL be handled as before: a fallback file is applied, otherwise the task fails with reason `exitedWithoutReport`. A dead launch's diagnosis also decides whether its failure is charged: see task-lifecycle "Retry and exhaustion" for `startupContended`.

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
For every live launch whose task is `running` and whose process is alive, the daemon SHALL compute a progress fingerprint each tick: the branch head sha plus a hash of `git status --porcelain` and `git diff-index -p HEAD` for the worktree, both excluding `.orchestrator/`, so that a further edit to an already dirty file still registers. A touch that leaves a tracked file's content unchanged SHALL NOT change the fingerprint.

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
Config `health.stuckAfterMs` (default fifteen minutes) and `health.stuckFailAfterMs` (default forty-five minutes) SHALL each be disabled when 0. When a `running` task's launch has been idle for longer than `stuckAfterMs`, the daemon SHALL flag it: record `stuckSince`, append `launch.stuck` with `idleMs`, queue an inbox notice `{ kind: 'stuck', idleMs, message }`, and invoke the stuck diagnoser once. New progress SHALL clear the flag and append `launch.unstuck`.

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

### Requirement: Launch time budget
Config `budgets.maxLaunchMs` (default two hours) SHALL be disabled when 0. When a `running` task's launch exceeds the budget, the daemon SHALL reap the process, end the launch, and transition the task to `failed` with reason `timeBudget`, increasing `attempts`.

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
Usage SHALL have two sources, and the launch row and `launch.usage` SHALL name the source as `source`/`usageSource`. When a spawned launch is observed dead or is ended, the daemon SHALL ask the runner named on the launch row for the launch's usage. A log without usage SHALL yield no usage.

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

## ADDED Requirements

### Requirement: Process liveness: runner diagnosis of a dead launch
When the runner implements `readFailure` and returns a diagnosis `{ reason, detail? }` for the dead launch, the dead-launch record SHALL carry it: the failure's message SHALL name the reason and the detail, its `detail.runnerFailure` SHALL hold the diagnosis, and the `launch.ended` event SHALL carry `runnerFailure`. A runner without `readFailure`, or one that returns nothing, SHALL leave the record as before. The same SHALL hold for a launch found dead at recovery.

#### Scenario: Runner without readFailure
- **WHEN** a running launch's process is dead, no fallback file exists, and the runner does not implement `readFailure`
- **THEN** the next launch's brief carries `priorFailure` `{ kind: 'exitedWithoutReport', message: 'process exited without a report' }` with no detail, and the composed brief does not mention the runner's diagnosis

#### Scenario: Dead at recovery with the runner's reason
- **WHEN** the daemon restarts and finds a running launch's process dead with no fallback file, and the runner diagnoses it as `exitBeforeTurn`
- **THEN** the `launch.failed` event for the launch carries reason `exitBeforeTurn` with `charged: true`, and the launch ends with reason `recovered-dead`, its `launch.ended` event carrying the diagnosis as `runnerFailure`

### Requirement: Process liveness: liveness by runner
`unknown` SHALL leave lease expiry as the only bound on silence. Runners that spawn processes SHALL derive liveness from the recorded pid; a runner that cannot observe its launches SHALL report `unknown`. For the OpenCode runner the recorded pid leads the `sh` process group that holds `opencode` and its MCP child (the shim): liveness follows the `sh`, which lives as long as `opencode`, and reaping signals the whole group, so the shim does not outlive its launch.

#### Scenario: Unknown liveness is bounded by the lease alone
- **WHEN** a running launch makes no API call for longer than the lease TTL while its runner reports it `alive`, and then again for longer than the TTL while its runner reports `unknown`
- **THEN** after the first it is still running with `attempts` 0 and a lease extended past its earlier expiry, and after the second its lease has expired: `attempts` is 1 and the next launch's brief carries `priorFailure` `leaseExpired`

### Requirement: Progress signals: recorded signals
The daemon SHALL record `progressAt` and `lastSignal` on the launch row when the progress fingerprint changes (`commit` when the head moved, otherwise `worktree`), when the agent makes any API call (`heartbeat`, `report`, `block`, `inbox`, `log`), when a heartbeat carries a `progress` text different from the previous one (`heartbeatText`, with the text kept as `progressText`), and when a `waiting` task resumes (`resumed`).

#### Scenario: Any API call is progress
- **WHEN** an agent heartbeats with the same `progress` text as its previous heartbeat, and then calls `log`
- **THEN** the heartbeat records `lastSignal` `heartbeat` with `progressText` unchanged, and the `log` call records `progressAt` at the call's time with `lastSignal` `log`

### Requirement: Progress signals: baseline at spawn
A launch SHALL start with `progressAt` equal to `spawnedAt`, and its first fingerprint SHALL be a baseline that does not count as progress.

#### Scenario: First fingerprint is a baseline
- **WHEN** a launch is spawned and the next tick computes its first fingerprint
- **THEN** the launch row has `lastSignal` `spawned` and `progressAt` equal to `spawnedAt` after the spawn, and after that tick it stores the fingerprint and `lastSignal` is still `spawned`

### Requirement: Progress signals: remote launch fingerprint source
A remote launch (`access: remote`) has no worktree on the daemon's host: the daemon SHALL NOT compute its fingerprint (no `Workspace.fingerprint` call at reconcile), and its fingerprint SHALL instead come from its worker's heartbeats. A heartbeat body MAY carry `fingerprint`, the clone's fingerprint computed as the daemon computes a progress fingerprint (the head sha, a colon, the hash).

#### Scenario: Remote launch without fingerprint heartbeats
- **WHEN** a remote launch whose task is `running` is reconciled on three ticks and no heartbeat has carried `fingerprint`
- **THEN** its launch row holds no fingerprint and its task is still `running`

### Requirement: Progress signals: remote heartbeat fingerprint check
For a remote launch a malformed `fingerprint` SHALL be answered 400 naming the field before anything is written; a well-formed one SHALL be compared with the stored fingerprint exactly as a daemon-read one is: the first is a baseline, a changed value SHALL be stored on the row and recorded as `commit` when the head part changed and otherwise `worktree`, and the same value again SHALL record nothing.

#### Scenario: Malformed remote fingerprint
- **WHEN** a heartbeat of a remote launch carries `fingerprint` `not-a-fingerprint`
- **THEN** it is answered 400 with `field` `fingerprint`, and the fingerprint stored on the launch row is unchanged

### Requirement: Progress signals: remote heartbeat counting
A remote heartbeat that carries `fingerprint` SHALL count as progress only through its fingerprint or a new `progress` text, not as a `heartbeat` signal, so that a worker loop's periodic heartbeats renew the lease without hiding an agent that makes no progress; stuck detection SHALL then work unchanged on the stored remote fingerprint. For a local launch a heartbeat's `fingerprint` SHALL be ignored.

#### Scenario: Unchanged remote fingerprint renews the lease only
- **WHEN** a remote launch heartbeats with the fingerprint already stored on its row and no `progress` text
- **THEN** its lease now expires one lease TTL after the call, and its `progressAt` and `lastSignal` are unchanged

### Requirement: Stuck detection and escalation: idle time
A launch's idle time SHALL be the awake time (see "Gap in the daemon's clock") from `progressAt` (or `spawnedAt`, or the launch's creation) to now.

#### Scenario: Idle time since the spawn
- **WHEN** `stuckAfterMs` is 1000 and a launch has made no progress in the 1500 ms since it was spawned, with no gap
- **THEN** its `launch.stuck` event carries `idleMs` 1500 and `lastSignal` `spawned`, and its entry in `status.liveLaunches` shows `idleMs` 1500

### Requirement: Stuck detection and escalation: failure
When idleness exceeds `stuckFailAfterMs`, the daemon SHALL reap the process, end the launch, and transition the task `running -> failed` with reason `stuck`, increasing `attempts`. A `waiting` task SHALL never be flagged or failed as stuck.

#### Scenario: Stuck failure ends the launch
- **WHEN** a running launch stays silent for longer than `stuckFailAfterMs`
- **THEN** its process is gone, the launch row is `ended` with `endReason` `stuck`, a `transition` with trigger `stuck` is recorded, `attempts` is 1, and the next launch's brief carries `priorFailure` `stuck`

### Requirement: Stuck detection and escalation: status listing
Status and the digest SHALL list flagged task ids under `stuck`.

#### Scenario: Flagged tasks listed
- **WHEN** the launches of T1 and T5 are both flagged, and then both make progress
- **THEN** `status.stuck` lists `T1` and `T5` and T1's entry in `status.liveLaunches` has `stuck: true`, and once both have made progress `status.stuck` is empty

### Requirement: Launch time budget: elapsed time
`elapsedMs` for a launch SHALL be the awake time (see "Gap in the daemon's clock") since `spawnedAt` (or the launch's creation), excluding time its task spent `waiting`: `waitedMs`, which a resume grows by the awake time of the wait, and the awake time of a wait in progress.

#### Scenario: A resume grows waitedMs
- **WHEN** under a `maxLaunchMs` of 10 s a launch's task waits twenty minutes on a question, is answered and resumed, and runs five seconds more
- **THEN** the task is never failed for its time budget, the launch row has `waitedMs` of twenty minutes, and `status.liveLaunches` shows the launch's `elapsedMs` as 5000

### Requirement: Usage accounting: Claude Code log
Each runner SHALL read its own log format:
- The Claude Code runner SHALL parse the last JSON object in the launch log for `total_cost_usd`, `duration_ms`, `num_turns`, and the `usage` object's `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`.

#### Scenario: Last object after earlier objects
- **WHEN** a Claude Code launch log holds a stderr line, an earlier JSON object, a line that opens a brace but is not JSON, and then the result object
- **THEN** the usage read takes its cost, turns, duration, and tokens from the result object, with `source` `claude-code`

### Requirement: Usage accounting: Claude result object search
The Claude Code runner SHALL find the last JSON object in the launch log whatever it holds when it starts a line within the last 256 KiB of the log: it SHALL try every `{` that starts a line before any other `{`, last first, and SHALL then try every `{`, last first, each pass at most 200 times. The last JSON object in the launch log SHALL run to the end of the log; an object followed by another line SHALL yield no usage.

#### Scenario: Text after the result object
- **WHEN** a Claude Code launch log ends with the result object followed by a line of text, or holds only 300 lines of `{}`
- **THEN** no usage is read from it

### Requirement: Usage accounting: Codex log
The Codex runner SHALL sum the `usage` of every `turn.completed` line, as worker-runners "Codex usage parsing" states, and SHALL report no cost, turns, or duration. The pricing of a usage with tokens and no cost rests on two assumptions, both unverified: Codex's `cached_input_tokens` is a subset of `input_tokens`, and `reasoning_output_tokens` is NOT included in `output_tokens`.

#### Scenario: Codex turns summed
- **WHEN** a Codex launch log holds two `turn.completed` lines with other lines between them
- **THEN** the usage read has their tokens summed field by field, `source` `codex`, and no cost, turns, or duration

#### Scenario: Reasoning output priced on top of output
- **WHEN** tokens `{ input: 0, output: 1000, reasoningOutput: 500 }` are priced at an `outputPerMTok` of 10 with no `reasoningOutputPerMTok`
- **THEN** the cost is 0.015: the reasoning tokens are billed in addition to `output`

### Requirement: Usage accounting: OpenCode log
The OpenCode runner SHALL sum every `step_finish` line, as worker-runners "OpenCode usage parsing" states: cache reads folded into `input` as for Claude, the cost read from the stream as `costUsd`, `turns` the steps that ended with `reason: "stop"`, and no duration.

#### Scenario: OpenCode steps summed
- **WHEN** an OpenCode launch log holds six `step_finish` events, one of which ends with `reason: "stop"`
- **THEN** the usage read sums their tokens with the cache reads inside `input`, has `turns` 1 and `costUsd` 0, and has no `durationMs`

### Requirement: Usage accounting: scripted and in-process runners
The scripted and in-process runners SHALL yield no usage unless scripted.

#### Scenario: No usage unless scripted
- **WHEN** an in-process runner's launch has no usage scripted for its launch id or its task id, and another launch has a usage scripted for its task id
- **THEN** the runner reads no usage for the first launch, and reads the scripted usage for the second

### Requirement: Usage accounting: claimed launch usage
A claimed launch has no pid and no log, so it SHALL yield no runner usage, and the daemon SHALL NOT ask the runner for it. The claimed launch's usage SHALL come only from its worker through `POST /v1/launches/:id/usage` (pull-runner "Worker usage"), stored with `source: 'worker'` through the same path, guard, and pricing as runner usage. Because launches with a pid are refused there, the two sources never apply to the same launch. Self-reported usage is not authoritative.

#### Scenario: Worker usage for a spawned launch is refused
- **WHEN** worker `w1` posts usage for a spawned launch, which has a pid
- **THEN** the post is answered 409, no `launch.usage` is appended, and the spawned launch takes its usage from its runner when it ends

### Requirement: Usage accounting: token shape
Usage SHALL carry `tokens` as `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }` in the same shape for every runner, and `source` naming the reader. `cachedInput` is counted inside `input`, so Claude's cache reads are added to its `input_tokens`, and OpenCode's `cache.read` to its `tokens.input`. The sources are `claude-code`, `codex`, `opencode`, `scripted`, and `worker`.

#### Scenario: Claude cache fields in the shared shape
- **WHEN** a Claude Code result object's `usage` has `input_tokens` 10, `output_tokens` 20, `cache_read_input_tokens` 300, and `cache_creation_input_tokens` 40
- **THEN** the usage read has `tokens` `{ input: 310, cachedInput: 300, cacheWriteInput: 40, output: 20 }`

### Requirement: Usage accounting: stored usage
A usage with any of a cost, turns, a duration, or tokens SHALL be recorded, so a usage with only tokens is recorded. Usage found SHALL be stored on the launch row as `costUsd`, `turns`, `durationMs`, `tokens`, `usageSource`, and `costSource` (see "Run cost budget"), and appended as `launch.usage`, whose payload carries the whole usage. `durationMs` SHALL stay unset when the runner reports none; `status.liveLaunches[].elapsedMs` gives wall time.

#### Scenario: Usage stored on the launch row
- **WHEN** T1's runner reports `{ costUsd: 1.25, turns: 3, durationMs: 1000 }` and T1's launch ends after its submit
- **THEN** the launch row stores `costUsd` 1.25, `turns` 3, and `durationMs` 1000, and a `launch.usage` event is appended for it

### Requirement: Usage accounting: pricing tokens without a cost
A usage with tokens and no cost SHALL be priced as "Run cost budget" states, per million tokens and rounded to 1e-6:
- billable input `input - cachedInput` at `inputPerMTok`;
- `cachedInput` at `cachedInputPerMTok` (fallback `inputPerMTok`);
- `cacheWriteInput` at `cacheWriteInputPerMTok` (fallback `inputPerMTok`);
- `output` at `outputPerMTok`;
- `reasoningOutput` at `reasoningOutputPerMTok` (fallback `outputPerMTok`).

#### Scenario: Cached input priced apart
- **WHEN** tokens `{ input: 40361, cachedInput: 32128, output: 0 }` are priced at an `inputPerMTok` of 2, once with a `cachedInputPerMTok` of 0.5 and once without one
- **THEN** the cost is 0.03253 with the cached rate and 0.080722 without it

### Requirement: Usage accounting: task and run sums
The cost and tokens of a task SHALL be the sums over its launches, and those of the run the sums over all launches. All of these costs and tokens SHALL be derived from launch rows, so that a restart cannot double count.

#### Scenario: Run cost summed from launch rows
- **WHEN** T1's launch records a cost of 1.25 and T5's a cost of 0.75, and a new orchestrator is started on the same store
- **THEN** `status.cost` has `runUsd` 2 and `byTask` `{ T1: 1.25, T5: 0.75 }`, and the new orchestrator reports the same cost

### Requirement: Usage accounting: report grace
A headless agent writes its usage only when it exits. The daemon SHALL therefore record `reportedAt` on the launch when a submit is accepted. The daemon SHALL leave a live launch whose task is `submitted` or `done` running while its process is alive and the report is younger than `health.reportGraceMs` (default 120000; 0 disables the grace). `health.reportGraceMs` SHALL be a config-file key read at start and SHALL NOT be a runtime override.

#### Scenario: Reported launch left running
- **WHEN** T1 submits under a `health.reportGraceMs` of 30 s and its process stays alive
- **THEN** on the next tick its launch is `live` with `reportedAt` the time of the submit, its process is alive, and no `launch.usage` is appended

#### Scenario: Grace refused at runtime
- **WHEN** a runtime config patch sets `health.reportGraceMs`
- **THEN** it is refused with 400 naming the key `health.reportGraceMs`, and nothing is applied

### Requirement: Usage accounting: end after the grace
When a reported launch's process exits or the report grace elapses, the daemon SHALL reap what remains, wait until the launch's process group is gone, then record usage, end the launch with reason `reported`, and remove its worktree. A process that does not exit after its report SHALL be reaped, and its launch ended, on the first tick at or after `health.reportGraceMs` from the report.

#### Scenario: Exit and linger under one grace
- **WHEN** T1 and T5 submit under a `health.reportGraceMs` of 30 s, T1's process then exits, and T5's process is still alive 31 s after its report
- **THEN** the tick after T1's exit ends T1's launch with reason `reported` and the usage its runner reports, and the tick 31 s after the reports reaps T5's process and ends its launch with reason `reported`

### Requirement: Usage accounting: reap waits for the process group
A reap SHALL send SIGTERM to the launch's process group and wait until the group is empty, polling, for at most the runner's kill grace (default 2000 ms); it SHALL then send SIGKILL to the group and wait at most 1000 ms more. So a usage line the agent writes while it is terminated is read. A pid that leads no group SHALL be waited for alone.

#### Scenario: Group member that ignores SIGTERM
- **WHEN** a launch's `/bin/sh` leads a group whose child ignores SIGTERM, and the launch is reaped with a kill grace of 300 ms
- **THEN** the reap returns no sooner than 300 ms, and no process of the group is left

### Requirement: Usage accounting: launches outside the report grace
Token accounting does not change the report grace mechanics: in every observed run, Codex wrote `turn.completed` with its usage after its final `agent_message`. Cancelled and superseded launches SHALL be reaped at once as before. A lingering launch delays the idle exit by at most the report grace.

#### Scenario: Cancelled launch reaped at once
- **WHEN** a running task is cancelled while the report grace is 30 s
- **THEN** the next tick ends its launch with reason `cancelled` and its process is gone
