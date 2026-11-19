## MODIFIED Requirements

### Requirement: Run cost budget
Config `budgets.maxRunCostUsd` (default 0) SHALL mean unlimited when 0. The ceiling SHALL be `maxRunCostUsd` times one plus the number of overrides recorded. When the run cost reaches the ceiling, admission SHALL pause with `pausedReason: 'costBudget'` and `budget.exceeded`, while running work and verification continue.

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

### Requirement: Worktree observation takes no index lock
The daemon's git commands SHALL run with `GIT_OPTIONAL_LOCKS=0`. Its read-only git commands against a launch worktree SHALL never write the worktree's index or create its `index.lock`, so they never make the agent's own concurrent git command fail. Commands that write SHALL take their locks as before.

#### Scenario: Agent commits while the daemon fingerprints
- **WHEN** an agent runs `git commit` in its worktree during the same tick in which the daemon computes that launch's progress fingerprint
- **THEN** the commit does not fail with "Unable to create '.../index.lock': File exists", and the launch is not failed as `exitedWithoutReport`

#### Scenario: Stat-dirty entries do not make the fingerprint write the index
- **WHEN** a tracked file in a launch worktree is touched without a content change, so its index entry is stat-dirty, and the daemon computes the fingerprint
- **THEN** the worktree's `.git/index` keeps its inode and mtime and no `index.lock` is created

#### Scenario: Observation still sees uncommitted edits
- **WHEN** an agent modifies a tracked file without committing
- **THEN** the next tick's fingerprint differs from the previous one and `progressAt` is recorded with `lastSignal` `worktree`, as without the setting

### Requirement: Gap in the daemon's clock
A *note* SHALL be one reading of the daemon's clock that the daemon remembers. A *gap* SHALL be two consecutive notes more than `health.gapAfterMs` apart, running from the earlier note to the later one. *Awake time* between two instants SHALL be their difference less the parts inside gaps, never below 0.

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
The hold SHALL run from the end of the latest gap the process noted until `health.gapHoldMs` later; `gapHoldMs: 0` SHALL turn it off, and a gap inside a hold SHALL start it again from its own end. During the hold nothing SHALL start: no admission, no resume of a waiting task, no spawn of a parked launch, no verifier job and no deferred-job pass. The `daemon.gap` event SHALL be the only trace of a hold.

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
The stuck check and the launch time budget check SHALL read `health.stuckAfterMs`, `health.stuckFailAfterMs` and `budgets.maxLaunchMs` from the effective configuration (the boot resolution with the stored override document applied) each time they test a launch, so a change applies on the next tick to every live launch, spawned or claimed. A launch already flagged stuck SHALL stay flagged until progress clears it, also after `health.stuckAfterMs` is raised.

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

## ADDED Requirements

### Requirement: Run cost budget: model prices
Config `budgets.prices` (default `{}`) SHALL map a model name (checked by the model-name pattern) to rates in USD per million tokens: `inputPerMTok`, `outputPerMTok`, and optional `cachedInputPerMTok`, `cacheWriteInputPerMTok`, and `reasoningOutputPerMTok`, each non-negative.

#### Scenario: Price table checked at load
- **WHEN** the configuration gives a model in `budgets.prices` a negative rate, leaves out `outputPerMTok`, names a rate such as `perCall` that is not in the list, or uses a model key such as `bad model` or `-flag`
- **THEN** the configuration is refused, and a configuration without `budgets.prices` has the table `{}`

### Requirement: Run cost budget: reported cost
When a runner reports a cost, the launch SHALL record it with `costSource: 'reported'` and SHALL NOT re-price it.

#### Scenario: Worker's posted cost is kept
- **WHEN** a worker holding a claimed launch posts a usage of `costUsd` 0.25 with 140 input, 40 cached input and 7 output tokens
- **THEN** the launch row has `costUsd` 0.25 with `costSource` `reported` and those tokens, and `status.cost.byTask` gives the task 0.25

### Requirement: Run cost budget: priced cost
When a runner reports tokens without a cost and `budgets.prices` has the launch's model, the daemon SHALL compute `costUsd` at record time with `costSource: 'priced'` as the sum of:
- `input - cachedInput` at `inputPerMTok`;
- `cachedInput` at `cachedInputPerMTok`, falling back to `inputPerMTok`;
- `cacheWriteInput` at `cacheWriteInputPerMTok`, falling back to `inputPerMTok`;
- `output` at `outputPerMTok`;
- `reasoningOutput` at `reasoningOutputPerMTok`, falling back to `outputPerMTok`.

#### Scenario: Cached input billed at its own rate
- **WHEN** tokens of 40361 input, 32128 of them cached, and no output are priced at `inputPerMTok` 2 and `outputPerMTok` 10, once with `cachedInputPerMTok` 0.5 and once without it
- **THEN** the cost is 0.03253 USD with the cached rate and 0.080722 USD without it, the cached input then billed at the input rate

### Requirement: Run cost budget: priced cost units and Codex counts
In the priced cost of "Run cost budget: priced cost", each count SHALL be divided by one million and the total rounded to 1e-6. Two assumptions about Codex's counts are assumed, unverified: `cached_input_tokens` is a subset of `input_tokens` (an observed 40361 input with 32128 cached is consistent), and `reasoning_output_tokens` is NOT included in `output_tokens`.

#### Scenario: Total rounded to 1e-6
- **WHEN** 7 input tokens are priced at `inputPerMTok` 0.3, and 1 input token at the same rate
- **THEN** the first cost is 0.000002 USD and the second 0 USD

#### Scenario: Reasoning output billed on top of output
- **WHEN** 1000 output tokens with 500 reasoning output tokens are priced at `outputPerMTok` 10, once with `reasoningOutputPerMTok` 4 and once without it
- **THEN** the cost is 0.012 USD with the reasoning rate and 0.015 USD without it

### Requirement: Run cost budget: unpriced launches
When tokens are reported without a cost and the model has no price, the launch's cost SHALL stay unknown: it SHALL be excluded from the run cost and counted in `status.cost.unpricedLaunches` (launches whose row has `tokens` and no `costUsd`; a launch that ended with no usage at all is not counted), and the daemon SHALL log one warning per such model. The run cost, and so the ceiling, SHALL count priced and reported launches only; unpriced launches SHALL NOT pause admission.

#### Scenario: Tokens without a price under a budget
- **WHEN** the budget is 5 USD and a finished launch reported 40361 input and 260 output tokens and no cost for a model with no price
- **THEN** its row keeps the tokens with no `costUsd` and no `costSource`, `status.cost` has `runUsd` 0 and `unpricedLaunches` 1, the run is not paused, the next ready task is running, and the daemon has logged the warning naming the model once

### Requirement: Run cost budget: resume over the ceiling
`resume` SHALL be refused while the run cost is at or above the ceiling unless called with `overrideBudget`, which SHALL record `budget.overridden`, raise the ceiling by one budget, and lift the pause.

#### Scenario: Override raises the ceiling by one budget
- **WHEN** the budget is 5 USD, the run is paused for `costBudget` at a run cost of 6 USD, and `resume` is called without and then with `overrideBudget`
- **THEN** the first call is refused naming `costBudget` with `runUsd` 6 and `ceilingUsd` 5 and the run stays paused; the second records one `budget.overridden` event, `status.cost` has `ceilingUsd` 10 and `overrides` 1, the run is not paused, and the next tick starts a launch

### Requirement: Worktree observation takes no index lock: fingerprint commands
So that the daemon's read-only git commands never write a launch worktree's index, the progress fingerprint SHALL use `git status --porcelain`, which under `GIT_OPTIONAL_LOCKS=0` skips its index refresh, and the plumbing `git diff-index -p HEAD`, which never refreshes the index; it SHALL NOT use porcelain `git diff`, which refreshes the index and takes `index.lock` regardless of `GIT_OPTIONAL_LOCKS`.

#### Scenario: Edits change the fingerprint without an index write
- **WHEN** in a launch worktree a tracked file is edited, then an untracked file is added, and between them files under `.orchestrator/` are edited or added
- **THEN** the fingerprint changes on the tracked edit and on the untracked file, stays the same on the `.orchestrator/` changes, and `.git/index` keeps its inode and mtime throughout

### Requirement: Gap in the daemon's clock: configuration
The configuration SHALL accept `health.gapAfterMs` and `health.gapHoldMs`, non-negative integers in milliseconds, each optional with a default of 60000 and read at start; `gapAfterMs: 0` SHALL turn the whole rule off, so that no note is taken, no gap is noted, no timer runs and every limit counts wall time.

#### Scenario: Rule off at zero
- **WHEN** `health.gapAfterMs` is 0 and two readings of the clock are ten million milliseconds apart
- **THEN** no gap is noted, no hold is on, the awake time between them is their whole difference, and arming the note timer leaves no timer

### Requirement: Gap in the daemon's clock: when notes are taken
The daemon SHALL take a note from a timer that `start()` arms and `stop()` clears, every second or every quarter of `gapAfterMs` when that is shorter; at the start of every tick; where the reconcile phase reads the clock; inside the lease-expiry test of a claimed launch; and immediately before each use of idle time, elapsed time or the hold.

#### Scenario: Note timer interval
- **WHEN** `health.gapAfterMs` is 60000, 2000 or 3
- **THEN** the note timer fires every 1000 ms, 500 ms or 1 ms

### Requirement: Gap in the daemon's clock: notes that are not gaps
The first note of a process SHALL NOT be a gap. A note earlier than the one before it SHALL NOT be a gap and SHALL become the reference for the next one.

#### Scenario: A backwards note becomes the reference
- **WHEN** a note at 1000000 ms is followed by notes at 10000 ms, at 10000 ms plus `health.gapAfterMs`, and at 10000 ms plus three times `health.gapAfterMs`
- **THEN** the first two later notes are no gap, and the last is a gap from 10000 ms plus `health.gapAfterMs`

### Requirement: Gap in the daemon's clock: what a note does
A timer note that finds a gap SHALL wake the loop. A note SHALL change memory only.

#### Scenario: A sleep inside a tick is written by the next tick
- **WHEN** the clock jumps past `health.stuckFailAfterMs` while a tick awaits a spawned launch's liveness
- **THEN** that tick neither flags nor fails nor ends the launch and appends no `daemon.gap` event, and the next tick appends one `daemon.gap` event with the launch still live

### Requirement: Gap in the daemon's clock: writing gaps
The tick SHALL write the gaps noted since the last write at its start and again where the reconcile phase reads the clock, and the lease-expiry test SHALL write them before it tests a lease. Each write SHALL be one transaction that appends one `daemon.gap` event per gap, with payload `{ from, to, gapMs, holdUntil }` (`holdUntil` is `to` plus `health.gapHoldMs`) and event time `to`, and renews the leases as pull-runner "Lease renewal after a gap" states.

#### Scenario: Claimed launch renewed by the write
- **WHEN** in `pull` mode a claimed launch's worker is silent while the clock sleeps five lease TTLs between two ticks
- **THEN** the second tick leaves the launch live with `attempts` 0, its lease expiring no sooner than one TTL after the wake and its `progressAt` unchanged, and a tick more than a TTL later ends it with reason `leaseExpired`

### Requirement: Gap in the daemon's clock: awake time and progress
Awake time SHALL leave out every noted gap, written or not. A gap SHALL NOT be a progress signal.

#### Scenario: Writing a gap does not clear a stuck flag
- **WHEN** a launch flagged stuck stays silent while the clock sleeps twice `health.stuckFailAfterMs`, and a tick writes the gap
- **THEN** the launch is still live and flagged with the same `stuckSince`, `progressAt` and `lastSignal`, and no `launch.unstuck` event and no further notice are appended

### Requirement: Gap in the daemon's clock: gaps read at restart
A new orchestrator SHALL read the gaps of the run's earlier `daemon.gap` events when it is constructed. They SHALL count towards awake time and SHALL NOT start a hold. Time during which no daemon process ran SHALL NOT be a gap.

#### Scenario: Loaded gaps count but do not hold
- **WHEN** a gap from 1000000 ms to 1500000 ms is read from an earlier `daemon.gap` event
- **THEN** the awake time from 900000 ms to 1600000 ms is 200000 ms, no hold is on at 1500001 ms, no gap waits to be written, and a later note is not measured from the loaded gap

### Requirement: Gap in the daemon's clock: idle exit
Writing a gap SHALL be activity for idle exit: the time of the last activity becomes the gap's end, with or without a hold. This excepts operator-control "Idle exit", whose list of what counts as activity does not name it.

#### Scenario: The gap alone is activity
- **WHEN** `health.gapHoldMs` is 0 and a quiescent daemon with `daemon.idleExitMs` of 2 minutes sleeps 10 minutes, then a tick writes the gap
- **THEN** idle exit is not due on that tick nor 1 ms short of 2 minutes after the gap's end, and is due at 2 minutes after it

### Requirement: Gap in the daemon's clock: status times
`status().liveLaunches[].idleMs` and `elapsedMs` SHALL be awake time; this excepts the sentence of health-monitoring "Usage accounting" that says `elapsedMs` gives wall time. No status field reports gaps or the hold.

#### Scenario: Elapsed time leaves out a sleep
- **WHEN** a live launch's clock sleeps twice `budgets.maxLaunchMs` and a tick runs
- **THEN** the launch is still live with `attempts` 0 and its `status().liveLaunches[].elapsedMs` is below `budgets.maxLaunchMs`

### Requirement: Gap in the daemon's clock: wall-time clocks
`maxWaitMs`, the report grace, the claim window, push retry backoff, remote git timeouts, the check command's timer and the journal's flush deadline SHALL keep counting wall time. With no gap every value measured in awake time SHALL equal what wall time gives.

#### Scenario: No gap, wall time
- **WHEN** a live launch makes no progress for 10 minutes and 17 ms with no gap
- **THEN** its `idleMs` is the wall time since its `progressAt` or spawn, its `elapsedMs` is 10 minutes and 17 ms, the wall time since its spawn, and no `daemon.gap` event is appended

### Requirement: Hold after a gap: tests in the admission phase
The admission phase SHALL test the hold after the pause test, and again (noting the clock first) before each resume, each new launch and each spawn of a parked launch, so a sleep in the middle of the pass stops the rest of it.

#### Scenario: A sleep in the middle of the pass
- **WHEN** an admission pass has a resume of an answered waiting task and new launches to make, and the clock jumps past `health.gapAfterMs` after the pass has begun and before its next start
- **THEN** the pass starts nothing more, and the remaining starts are made by the first tick after the hold

### Requirement: Hold after a gap: what the hold does not stop
A hold SHALL NOT stop claims, SHALL NOT change how a dead process or a cancelled task is handled, and SHALL NOT pause the run or count as a stall.

#### Scenario: A hold is neither a pause nor a stall
- **WHEN** ticks run inside the hold after a gap while ready tasks, an answered waiting task and a queued verifier job wait
- **THEN** `status()` reports `paused` false and `stalled` false

### Requirement: Hold after a gap: idle time
While the hold is on the daemon's idle time SHALL be 0; this excepts operator-control "Idle exit", whose idle time is otherwise the time since the last activity.

#### Scenario: Idle time runs from the gap's end after the hold
- **WHEN** a quiescent daemon sleeps 10 minutes and a tick writes the gap
- **THEN** its idle time is 0 at 1 ms before `health.gapHoldMs` has passed since the gap's end, and `health.gapHoldMs` once the hold has ended

### Requirement: Limits read at every check: raised and lowered limits
Idle and elapsed time are measured as "Stuck detection and escalation", "Launch time budget" and "Gap in the daemon's clock" state; only the limit they are compared with follows the override. A raised limit SHALL keep a launch that has not yet crossed it; a lowered or cleared limit SHALL apply at once. A change that lands while the tick is already ending a launch does not save it.

#### Scenario: Elapsed time counts from the launch's start, not from the override
- **WHEN** a spawned launch has run 9500 ms under a `budgets.maxLaunchMs` of 10000, the override `budgets: { maxLaunchMs: 20000 }` is applied, and ticks run 1000 ms later and then a further 9600 ms later
- **THEN** the first tick keeps the launch live, and the second, at 20100 ms since the launch began, ends it with reason `timeBudget` and `attempts` 1
