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
A launch SHALL move through the durable states `preparing` (row written), `launching` (worktree ready, spawn in flight), `live` (pid recorded), and `ended` or `revoked`. The row written at `preparing` SHALL carry the runner kind, model, and effort fixed for the launch, so that liveness, reaping, and usage after a restart reach the runner the launch was prepared for; a row without a kind SHALL read as `claude-code`. The pid SHALL be recorded immediately after spawn returns, and `spawnedAt` SHALL be set only then.

#### Scenario: States recorded in order
- **WHEN** a task is launched without interruption
- **THEN** the launch row passes through `preparing`, `launching`, and `live` with a pid

#### Scenario: Kind survives a restart
- **WHEN** a `codex` launch is live and the daemon restarts
- **THEN** the row still carries `runner: "codex"` and its liveness and usage are read through the `codex` runner

### Requirement: Recovery per boundary
On start, before the first tick, the orchestrator SHALL run idempotent recovery:
- a launch in `preparing` SHALL have any worktree removed and SHALL be retried;
- a launch in `launching` SHALL be treated as unknown: its token revoked, any process whose command line contains the launch id killed, its worktree removed, and a new launch of the same attempt started without increasing `attempts`;
- a launch in `live` whose process is alive SHALL be adopted with its lease intact;
- a launch in `live` whose process is dead and whose fallback file exists SHALL have the file applied;
- a launch in `live` whose process is dead with no fallback file, while its task is `running`, SHALL be failed through the same path as a death the tick observes (task-lifecycle "Retry and exhaustion"): it is recorded as a `launch.failed` event, and the task ends as `failed` with `attempts` increased unless the runner diagnoses `startupContended` within the `health.contendedRetries` allowance, in which case the task returns to `unstarted` with `attempts` unchanged;
- a verifier job in `queued`, `checking`, or `verified` SHALL have any temporary worktree removed and SHALL restart from `queued`;
- a verifier job in `publishing` SHALL be resolved by inspecting the integration branch for the launch trailer: present means record `published` and `done`, absent means requeue. With `git.pushIntegration` on, recovery SHALL fetch and inspect origin's integration branch first. A trailer only on the clone, at the job's `squashSha`, while origin is still at the job's `expectedHead`, SHALL be pushed once with that lease and recorded `published`. A lease that no longer holds SHALL undo the local compare-and-swap and requeue, as SHALL an origin that cannot be reached;
- a milestone tag SHALL be re-created idempotently, and with `git.pushIntegration` on, pushed to origin.

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

#### Scenario: Contended death found at restart
- **WHEN** a running task's launch died while the daemon was down, left no fallback file, and the runner diagnoses `startupContended`, with the task under its `health.contendedRetries` allowance
- **THEN** recovery records one `launch.failed` event with `reason: startupContended` and `charged: false`, and the task is `unstarted` with `attempts` unchanged

#### Scenario: Other death found at restart
- **WHEN** a running task's launch died while the daemon was down, left no fallback file, and the runner gives any other diagnosis or none
- **THEN** recovery records one `launch.failed` event with `charged: true` and the task is failed with `attempts` increased

#### Scenario: Crash between swap and push
- **WHEN** the daemon dies after the local compare-and-swap succeeded but before the push to origin, with pushing on
- **THEN** on restart the squash is pushed to origin once, the task is `done`, a second recovery pushes nothing, and origin holds exactly one commit with the launch trailer

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
The launch lifecycle SHALL gain the durable state `claimable`, entered after the worktree and brief exist in `pull` and `mixed` modes; a parked launch whose window elapses SHALL move through `launching` and `live` as a spawned launch does. The claim's external effect is its response. Its durable record SHALL be one transaction that sets the launch to `live` with the worker id, resets the lease, and appends the event, committed before the response is sent, and a lost response SHALL be repaired by the idempotent re-claim. The named crash points SHALL additionally include `launch.afterClaimable`, after the row becomes claimable, and `claim.afterRecord`, after the claim transaction and before the response. On start, recovery SHALL keep a `claimable` launch claimable, verifying that its worktree exists and re-preparing it when missing; SHALL keep a live launch held by a worker while its lease is unexpired, judging liveness by the lease rather than by a process; and SHALL expire an expired one as the tick would, keeping it with progress and failing it with reason `leaseExpired` without (see "Claimed lease expired while the daemon was down"). Sweeps SHALL treat claimable launches as live. The convergence invariants SHALL hold for the crash matrix run in `pull` mode with scripted workers.

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
The store's `transaction(fn)` SHALL run `fn` as one transaction that commits when `fn` returns, returning its value, and that is rolled back entirely when `fn` throws, rethrowing the error. A `transaction` call made while a transaction is open SHALL nest: when the inner function throws, only the inner function's writes are undone and the outer transaction continues; when the outer function throws, the inner function's writes are undone with it. A primary key or unique violation SHALL throw an `Error` whose message names the constraint, and the transaction it happened in SHALL roll back. An existing store SHALL open unchanged. These rules hold for every backend: a plain SQLite store and a journaled store (see specs/state-backend), whose image applies them and whose sink receives only what committed.

For the SQLite store (and a journaled store's SQLite image), a transaction SHALL be one SQLite transaction and a nested call a savepoint. The store SHALL open in WAL mode with `synchronous = NORMAL` and a busy timeout of five seconds, so that a reader in another process never blocks the writer and a writer that finds the database locked by another connection waits for it rather than failing at once. The busy timeout SHALL be set before the switch to WAL mode, and opening the store SHALL retry the WAL switch and the schema creation while SQLite reports `SQLITE_BUSY`, for up to the same five seconds, because SQLite returns `SQLITE_BUSY` from the switch without calling the busy handler when two connections open a new file at once.

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
- **WHEN** (SQLite only) another process holds a write transaction open on the SQLite store file and this process writes a key
- **THEN** a read of that key made while the other transaction is open returns the previous value, and the write succeeds after the other process commits, having waited rather than thrown

#### Scenario: Opening a store another process is creating
- **WHEN** (SQLite only) another process has created the SQLite store file, still in rollback-journal mode, and holds its exclusive lock for one second while this process opens the store
- **THEN** the open waits for the lock and succeeds, rather than throwing "database is locked"; a daemon starting in that moment keeps running instead of exiting at startup

#### Scenario: Existing file reopens
- **WHEN** a store is closed and opened again (a SQLite store from its file, a journaled store as a fresh image loaded from its sink)
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

### Requirement: Startup on a fresh clone
A daemon restarted with no volume has a new clone and no worktrees. Startup recovery SHALL first read the integration head (fetching origin when it is the source of truth), then handle each claimable launch, claimed launch and queued verifier job as its scenarios state. None of these cases SHALL spend an attempt of the task.

#### Scenario: Parked launch on a fresh clone
- **WHEN** the daemon starts on a fresh clone with a claimable launch
- **THEN** the same launch stays claimable, its worktree is prepared again, and `launch.reprepared` is recorded

#### Scenario: Claimed launch without a worktree
- **WHEN** the daemon starts on a fresh clone with a claimed launch whose worktree is gone
- **THEN** the launch ends with `worktreeLost`, the task's attempts are unchanged, and it is admitted again without waiting for lease expiry

#### Scenario: Sealed commit lost
- **WHEN** the daemon starts on a fresh clone with a queued job whose sealed commit is not in the clone
- **THEN** the job is dropped, `verify.commitLost` is recorded, and the task is retried with prior failure `commitLost` naming the commit and attempts unchanged

#### Scenario: Not a lost commit
- **WHEN** the commit check fails for another reason (no repository, a malformed sha)
- **THEN** the job is left queued

### Requirement: Origin lookup before commit lost
With `git.pushIntegration` on, recovery SHALL fetch origin before it decides any unapplied job in `queued`, `checking`, `verified` or `publishing`. A job whose `Orchestrator-Launch` trailer is on origin's integration branch SHALL be recorded `published` at that commit, whatever its status and whether or not its sealed commit is in the clone. Only a job with neither SHALL be `commitLost`. This takes precedence over "Startup on a fresh clone" and "Recovery per boundary".

#### Scenario: Landed while its record lagged
- **WHEN** the daemon starts on a fresh clone with a job stored as `checking`, `verified` or `publishing` whose launch trailer is on origin
- **THEN** the task is `done` at origin's commit, no `verify.commitLost` is recorded, and the task is not launched again

#### Scenario: Neither on origin nor in the clone
- **WHEN** origin answers, it lacks the launch trailer, and the sealed commit is not in the clone
- **THEN** the job is `commitLost` and the task is retried with attempts unchanged

### Requirement: Unreachable origin decides nothing
When origin cannot be fetched at recovery, no undecided job SHALL be published, pushed or dropped: each SHALL be queued, kept from the verifier, and decided by a later pass once origin answers.

#### Scenario: Origin cannot be fetched
- **WHEN** the daemon starts on a fresh clone and origin cannot be fetched
- **THEN** the job is still queued afterwards, is not handed to the verifier, and is decided once origin answers

### Requirement: Publishing recovery while origin is unreachable
Recovery SHALL hand every job found `publishing` to the verifier backend, saying whether origin could be fetched. When the backend cannot confirm the push (origin unreachable, the lease lost, or the push refused), it SHALL put the clone's integration branch back on the job's expected head if the job's squash is still the tip. The job SHALL be requeued, and deferred while origin is unreachable. The clone MUST NOT keep an unpushed squash at its tip.

#### Scenario: Restarted while origin is unreachable
- **WHEN** the daemon is killed between the local swap and the push for a task whose branch has two commits that edit one file, and it restarts on the same clone while origin is unreachable
- **THEN** the clone's branch is back at the job's expected head and the task stays `submitted`. Once origin answers, the task is `done` exactly once, with one commit carrying its trailer on origin, one launch, and no integration retry.

### Requirement: A landed push is found by its trailer
A job whose swap recovery undid SHALL be published at origin's commit when its launch trailer is found on origin, once origin answers. Nothing SHALL be pushed again for it.

#### Scenario: The push had landed
- **WHEN** the lost push had reached origin before the kill
- **THEN** once origin answers, the job is recorded `published` at origin's commit, and nothing is pushed again

### Requirement: Claimed lease expired while the daemon was down
At startup, recovery SHALL treat a `running` claimed launch whose lease expired while the daemon was down as the tick treats an expired claim (specs/pull-runner "Lease expiry"): with progress in its worktree and `interruptions` under `daemon.maxKeptReleases`, a kept release that keeps the branch and spends no attempt; otherwise a failed attempt with reason `leaseExpired`. Either way the launch ends with `leaseExpired` and its worktree is removed.

#### Scenario: Expired claim with a commit
- **WHEN** the daemon is down past the lease of a claimed launch that has committed, and restarts
- **THEN** the launch ends with `leaseExpired` and `kept: true`, its branch stays at the commit, and the task is `unstarted` with `attempts` 0 and `interruptions` 1

#### Scenario: Expired claim without progress
- **WHEN** the daemon is down past the lease of a claimed launch that changed nothing, and restarts
- **THEN** the launch ends with `leaseExpired` and the task's `attempts` is 1

### Requirement: Waiting claim with a lost worktree
At startup, recovery SHALL end a `waiting` claimed launch whose worktree is gone with `worktreeLost`. If the task's answer has already arrived, the task SHALL be retried without spending an attempt, with the question and answer in the next brief's context. If not, the task SHALL stay `waiting`. An answer to a `waiting` task whose launch is no longer live SHALL retry the task the same way, because nothing can resume.

#### Scenario: Answer arrived before the restart
- **WHEN** a claimed launch blocks, its answer is recorded, and the daemon restarts on a fresh clone before the worker collects it
- **THEN** the launch ends with `worktreeLost`, the task is `unstarted` with `attempts` 0, and the next launch's brief carries the question and the answer

#### Scenario: Answer not yet arrived
- **WHEN** a claimed launch blocks and the daemon restarts on a fresh clone before anyone answers
- **THEN** the launch ends with `worktreeLost` and the task stays `waiting` on its question

#### Scenario: Answer after the restart
- **WHEN** the operator answers that waiting task
- **THEN** the task is `unstarted` with `attempts` 0 and the answer in its carry, and the next launch's brief carries it

### Requirement: Lost refs found at startup
With a git workspace, recovery SHALL find, before any brief is composed:
- lost launch branches: the branch of every launch not in flight that is missing from the clone's `refs/heads`;
- lost commits: those named in stored attempt context that the clone definitely lacks (an interrupted context's `headSha` and `wipCommit`, a revision's `priorPublishedSha`).

The daemon SHALL keep these refs for its life.

#### Scenario: Fresh clone
- **WHEN** the daemon restarts on a fresh clone after a launch ended with its branch kept
- **THEN** that branch is among the lost refs

### Requirement: Context naming lost work
Recovery SHALL rewrite every stored attempt context that names a lost ref, and record each rewrite as a `recovery.workLost` event naming what was lost:
- an `interrupted` context SHALL become `lostWork { priorLaunchId, reason }`;
- a conflict SHALL lose `previousBranch`;
- a revision SHALL lose `priorBranch` or `priorPublishedSha`.

#### Scenario: Kept release lost with the clone
- **WHEN** a claimed launch commits, is released with `keep`, its relaunch is parked, and the daemon restarts on a fresh clone
- **THEN** a `recovery.workLost` event names the prior launch, branch, head and reason, and the task's carry holds `lostWork` and no `interrupted`

### Requirement: No brief names a lost ref
No brief SHALL name a lost ref, in `brief.md` or `brief.json`. This includes a context composed after startup, such as a reopen's revision. A `lostWork` context SHALL tell the worker that the kept work was lost with the previous clone and that it starts from its base commit.

#### Scenario: Parked launch briefed again
- **WHEN** the parked relaunch of a kept release is prepared again on a fresh clone
- **THEN** its brief names neither the lost branch nor its commit, and says the previous launch's work was lost

### Requirement: Re-preparing a parked launch
When recovery prepares a claimable launch's missing worktree again, it SHALL NOT prepare a base commit the clone definitely lacks. Such a launch SHALL end with `baseLost`, and one whose preparation throws SHALL end with `prepareFailed`. Either way, its task SHALL fail with reason `worktreeLost`, without spending an attempt, and the daemon SHALL NOT exit.

#### Scenario: Base commit not in the clone
- **WHEN** the daemon restarts on a fresh clone that lacks a parked launch's base commit
- **THEN** the launch ends with `baseLost`, the task is `unstarted` with `attempts` 0 and a `worktreeLost` prior failure naming the base, and the next tick parks a new launch on the integration head

#### Scenario: Preparation throws
- **WHEN** preparing a parked launch's worktree fails for another reason
- **THEN** the launch ends with `prepareFailed`, the task is retried without spending an attempt, and startup completes

