## ADDED Requirements

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

## MODIFIED Requirements

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
