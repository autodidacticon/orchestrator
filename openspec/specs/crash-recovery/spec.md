# Crash Recovery Specification

## Purpose
Durable record bracketing around every external effect, including the outbox boundary around tracker writes, the cascade boundary that records the plan before any reset so that a cascade reopen resumes after a crash, and the claim boundary that records a claim in one transaction before its response so that a lost response is repaired by an idempotent re-claim, recovery per boundary, including the durable `claimable` launch state and the launches workers hold, whose liveness is judged by the lease rather than by a process, adoption of surviving agents, fencing, sweeps, named crash points including `cascade.afterPlan`, `launch.afterClaimable`, and `claim.afterRecord`, and the convergence invariants the orchestrator must satisfy after any crash.

## Requirements

### Requirement: Durable record bracketing
Every external effect, meaning worktree creation, process spawn, acknowledgement to an agent, ref update, and tag creation, SHALL be preceded by a durable record of intent and followed by a durable record of outcome, so that recovery can determine or safely re-derive what happened. The orchestrator SHALL hold no state in memory that a restart would lose.

#### Scenario: Hard kill is safe
- **WHEN** the daemon is killed with SIGKILL at any instant and restarted
- **THEN** recovery runs before the first tick and the run converges to the same outcome as an uninterrupted run

### Requirement: Launch lifecycle records
A launch SHALL move through the durable states `preparing` (row written), `launching` (worktree ready, spawn in flight), `live` (pid recorded), and `ended` or `revoked`. The pid SHALL be recorded immediately after spawn returns, and `spawnedAt` SHALL be set only then.

#### Scenario: States recorded in order
- **WHEN** a task is launched without interruption
- **THEN** the launch row passes through `preparing`, `launching`, and `live` with a pid

### Requirement: Recovery per boundary
On start, before the first tick, the orchestrator SHALL run idempotent recovery:
- a launch in `preparing` SHALL have any worktree removed and SHALL be retried;
- a launch in `launching` SHALL be treated as unknown: its token revoked, any process whose command line contains the launch id killed, its worktree removed, and a new launch of the same attempt started without increasing `attempts`;
- a launch in `live` whose process is alive SHALL be adopted with its lease intact;
- a launch in `live` whose process is dead and whose fallback file exists SHALL have the file applied;
- a launch in `live` whose process is dead with no fallback file SHALL end as `failed` with `attempts` increased;
- a verifier job in `queued`, `checking`, or `verified` SHALL have any temporary worktree removed and SHALL restart from `queued`;
- a verifier job in `publishing` SHALL be resolved by inspecting the integration branch for the launch trailer: present means record `published` and `done`, absent means requeue;
- a milestone tag SHALL be re-created idempotently.

#### Scenario: Crash between spawn and pid record
- **WHEN** the daemon dies after spawning an agent but before recording its pid
- **THEN** on restart the launch is revoked, the orphan process is killed by launch id, and a new launch of the same attempt starts

#### Scenario: Crash after pid record
- **WHEN** the daemon dies after recording the pid and the agent is still running
- **THEN** on restart the launch is adopted and the agent's later report is accepted

#### Scenario: Crash after publish before record
- **WHEN** the daemon dies after the compare-and-swap succeeded but before `publishedSha` was recorded
- **THEN** on restart the trailer is found on the integration branch and the task is marked `done` without a second publication

#### Scenario: Crash before publish
- **WHEN** the daemon dies after squashing but before the ref update
- **THEN** on restart no trailer is found and the job is requeued, producing exactly one published commit in the end

### Requirement: Adoption
Agent processes SHALL be spawned detached with stdout and stderr redirected to per-launch log files so they survive the daemon's death. The daemon SHALL NOT rely on being the parent for signalling; stop SHALL be an explicit signal from the runner.

#### Scenario: Daemon restart is invisible to a working agent
- **WHEN** the daemon restarts while an agent is mid-task
- **THEN** the agent keeps running, its API calls succeed after the restart, and its submission is accepted

### Requirement: Fencing
A token SHALL be valid only for its launch. Recovery SHALL revoke tokens it cannot confirm. A revoked launch's calls SHALL return 401, its commits SHALL remain on its own branch, and its worktree SHALL be swept, so that a surviving orphan can waste compute but cannot affect task state or the integration branch.

#### Scenario: Orphan keeps running after revocation
- **WHEN** a revoked agent ignores the 401 and continues committing and calling the API
- **THEN** no task state changes, nothing reaches the integration branch, and its commits stay on the revoked branch

### Requirement: Sweeps
A periodic sweep SHALL compare `git worktree list` and running processes against live launches and SHALL remove stray worktrees and terminate processes belonging to revoked or ended launches.

#### Scenario: Stray worktree removed
- **WHEN** a worktree exists for a launch that is not live
- **THEN** the next sweep removes it

### Requirement: Named crash points
The code SHALL call `crashPoint(name)` at each boundary. When the environment variable `ORCH_CRASH_AT` equals the name, or the file named by `ORCH_CRASH_AT_FILE` contains it, the process SHALL exit immediately; otherwise the call SHALL do nothing. The named points SHALL be `launch.afterRow`, `launch.afterWorktree`, `launch.afterSpawn`, `launch.afterPid`, `launch.afterClaimable`, `claim.afterRecord`, `api.afterEventCommit`, `verify.afterQueued`, `verify.afterRebase`, `verify.afterCheck`, `verify.afterSquash`, `verify.afterPublish`, `milestone.afterTag`, `cascade.afterPlan`, and `tick.afterPhase<n>` for each phase.

#### Scenario: Crash point fires only when named
- **WHEN** `ORCH_CRASH_AT` is `verify.afterSquash`
- **THEN** the daemon exits exactly there and nowhere else

#### Scenario: Crash point armed through a file while running
- **WHEN** the file named by `ORCH_CRASH_AT_FILE` is written with `tick.afterPhase1` while the daemon runs
- **THEN** the daemon exits at the end of the next phase 1 and not before

### Requirement: Convergence invariants
After any single crash at any named point followed by a restart, the system SHALL satisfy: no two live processes for one task at the same time; exactly one trailer commit per published task on the integration branch; no stray or temporary worktrees; store invariants (one lease per task, milestones never running); and a final state equal to the uninterrupted run's.

#### Scenario: Crash matrix passes
- **WHEN** the crash suite runs the standard fixture once per named crash point
- **THEN** every run ends `finished` with all five invariants holding

### Requirement: Outbox effects
A tracker write SHALL be bracketed like every other external effect: the outbox row, written in the same transaction as the transition that produced it, SHALL be the durable record of intent; the tracker write performed by the drainer SHALL be the external effect; and the acknowledgement SHALL be the durable record of outcome. A daemon crash at any instant SHALL lose no effect and SHALL duplicate none, because derivation commits with the transition and the unique key refuses a second row. A drainer crash between the tracker write and the acknowledgement SHALL be resolved on the next drain: a comment by the marker check, a state by the idempotence of setting the same state again. Recovery SHALL NOT modify the outbox.

#### Scenario: Daemon crash after the transition
- **WHEN** the daemon is killed immediately after a transition that derives an effect and is restarted
- **THEN** the outbox holds exactly one pending row for that transition and recovery leaves it untouched

#### Scenario: Drainer crash between post and ack
- **WHEN** the drainer posts a comment and dies before acknowledging, and a new drainer runs
- **THEN** the issue carries one comment with that marker and the effect is acknowledged with its id

#### Scenario: State applied twice
- **WHEN** the drainer sets an issue to the done-type state, dies before acknowledging, and the next drain applies the same effect
- **THEN** the issue is in the done-type state and the effect is acknowledged once

### Requirement: Cascade is resumable
The cascade plan and a pending-cascade marker SHALL be recorded in one transaction before any reset, each reset SHALL be its own transaction, and the marker SHALL be cleared in the transaction of the last reset. The code SHALL call `crashPoint('cascade.afterPlan')` between recording the plan and the first reset, and `cascade.afterPlan` SHALL be a named crash point. Recovery SHALL re-read the marker and apply every planned node that is still started, treating nodes already reset as done, and SHALL leave the processes and jobs of reset nodes to the existing recovery and sweep rules. After a crash at `cascade.afterPlan` or at any tick phase during a cascade, followed by a restart, the convergence invariants SHALL hold with trailer commits counted per published launch.

#### Scenario: Crash after the plan
- **WHEN** the daemon dies at `cascade.afterPlan` for a cascade over T2 and MVP and is restarted
- **THEN** recovery resets T2 and MVP before the first tick, T2's launch is ended with reason `cascade`, and the run converges to the same state as an uninterrupted cascade

#### Scenario: Crash mid-cascade
- **WHEN** the daemon dies after resetting MVP but before resetting T2 and is restarted
- **THEN** recovery resets T2 only, MVP is not reset a second time, and the marker is cleared

### Requirement: Claim boundaries
The launch lifecycle SHALL gain the durable state `claimable`, entered after the worktree and brief exist in `pull` and `mixed` modes; a parked launch whose window elapses SHALL move through `launching` and `live` as a spawned launch does. The claim's external effect is its response. Its durable record SHALL be one transaction that sets the launch to `live` with the worker id, resets the lease, and appends the event, committed before the response is sent, and a lost response SHALL be repaired by the idempotent re-claim. The named crash points SHALL additionally include `launch.afterClaimable`, after the row becomes claimable, and `claim.afterRecord`, after the claim transaction and before the response. On start, recovery SHALL keep a `claimable` launch claimable, verifying that its worktree exists and re-preparing it when missing; SHALL keep a live launch held by a worker while its lease is unexpired, judging liveness by the lease rather than by a process; and SHALL fail an expired one with reason `leaseExpired`. Sweeps SHALL treat claimable launches as live. The convergence invariants SHALL hold for the crash matrix run in `pull` mode with scripted workers.

#### Scenario: Crash after the claim record
- **WHEN** the daemon dies at `claim.afterRecord` and the worker claims again with the same worker id after the restart
- **THEN** it receives the same launch and token, and the run converges with one trailer commit per task

#### Scenario: Crash after claimable
- **WHEN** the daemon dies at `launch.afterClaimable` and restarts
- **THEN** the launch is still claimable with its worktree present and is claimed normally

#### Scenario: Claimable launch with a missing worktree
- **WHEN** a claimable launch's worktree has been deleted while the daemon was down
- **THEN** recovery re-prepares the worktree and brief for the same launch and it stays claimable

#### Scenario: Claimed launch survives a restart
- **WHEN** the daemon restarts while a worker holds a launch with an unexpired lease
- **THEN** the launch stays live without a pid and the worker's next call succeeds

### Requirement: Store transactions
The store's `transaction(fn)` SHALL run `fn` inside one SQLite transaction that commits when `fn` returns, returning its value, and that is rolled back entirely when `fn` throws, rethrowing the error. A `transaction` call made while a transaction is open SHALL nest as a savepoint: when the inner function throws, only the inner function's writes are undone and the outer transaction continues; when the outer function throws, the inner function's writes are undone with it. A primary key or unique violation SHALL throw an `Error` whose message names the constraint, and the transaction it happened in SHALL roll back. The store SHALL open in WAL mode with `synchronous = NORMAL` and a busy timeout of five seconds, so that a reader in another process never blocks the writer and a writer that finds the database locked by another connection waits for it rather than failing at once. An existing store file SHALL open unchanged.

#### Scenario: Inner rollback, outer commit
- **WHEN** an outer transaction writes entry T1, calls an inner `transaction` that writes entry T2 and throws, catches the error, and returns
- **THEN** T1 is present and T2 is absent after the outer transaction

#### Scenario: Outer rollback undoes the inner
- **WHEN** an outer transaction calls an inner `transaction` that writes entry T3 and returns, and then throws
- **THEN** T3 is absent after the error

#### Scenario: Duplicate launch rolls back
- **WHEN** a transaction appends an event and then creates a launch whose `launchId` exists
- **THEN** the call throws an error whose message contains `UNIQUE constraint failed` and the event is absent

#### Scenario: Second process waits for the writer
- **WHEN** another process holds a write transaction open on the store and this process writes a key
- **THEN** a read of that key made while the other transaction is open returns the previous value, and the write succeeds after the other process commits, having waited rather than thrown

#### Scenario: Existing file reopens
- **WHEN** a store is closed and opened again from its file
- **THEN** its entries, events, keys, and snapshot read back unchanged

### Requirement: Idle exit and revival
An idle exit SHALL be a graceful stop: the orchestrator loop stops, in-flight verification is awaited (none exists when quiescent), no agent is reaped, the store is closed, and the exit record is written. A daemon started afterwards SHALL run the same recovery as after any stop and SHALL find nothing to adopt or repair: a `submitted` milestone keeps its `integrationSha`, `reviewVersion`, and tag; a `blocked` task keeps its question and answer; pending outbox effects stay pending; parked launches stay `claimable` with their worktrees re-prepared when missing; and the next tick proceeds from the stored state. The exit record SHALL NOT be consulted by recovery. The crash matrix SHALL keep passing with the default idle window, because every run in it finishes well inside it. A daemon in container mode (`daemon.idleExitMs: 0`, reached through a non-loopback `ORCH_URL`) SHALL never exit idle and SHALL never be revived by a client spawning a local process; a signalled stop in that mode SHALL be recovered like any graceful stop, and a check abandoned at the shutdown grace SHALL restart from `queued` (see specs/operator-control "Container mode").

#### Scenario: Review survives an idle exit
- **WHEN** the daemon exits idle while MVP is `submitted` at version 2 and is revived by `accept` with that sha and version
- **THEN** MVP becomes `done` and no launch, job, or tag is created or changed by recovery

#### Scenario: Blocked question survives an idle exit
- **WHEN** the daemon exits idle while T3 is `blocked` with a question and is revived by `answer`
- **THEN** T3 becomes `unstarted` with the answer in its carry and is launched on the next tick

#### Scenario: Parked launches survive an idle exit
- **WHEN** the daemon exits idle with two launches parked in `pull` mode and is revived by a worker's `claim`
- **THEN** the worker receives the oldest parked launch with its worktree present

#### Scenario: Container mode never exits idle and is never revived locally
- **WHEN** `daemon.idleExitMs` is 0 and a client's `ORCH_URL` names the daemon's non-loopback Service
- **THEN** the daemon stays up while quiescent, and a client that cannot reach it reports the URL as unreachable instead of spawning a local daemon

### Requirement: Attachment end is durable
The end of an attachment SHALL be a durable record written before any launch is released, and the release of its launches SHALL happen in the next tick's reconcile as one transaction per launch, so that a daemon crash between the record and the release, or between two releases, converges after restart: recovery SHALL leave the record in place, reconcile SHALL release the remaining launches, and a launch already released SHALL NOT be released twice. The kept release SHALL preserve uncommitted work on the launch branch before the launch is ended, so a crash after the commit and before the transition leaves the branch with the work and the launch still live, and the next reconcile completes the release.

#### Scenario: Crash after the end record
- **WHEN** the daemon dies after recording an attachment's end and before releasing its two launches, and is restarted
- **THEN** both launches are released with `keep` by the first reconcile and the attachment record is removed

#### Scenario: Crash between preserve and transition
- **WHEN** the daemon dies after committing a launch's uncommitted work and before ending the launch
- **THEN** after restart the launch is released with `keep`, the branch holds the work-in-progress commit once, and the task is `unstarted` with `attempts` unchanged
