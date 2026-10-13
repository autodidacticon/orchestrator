# Crash Recovery Specification

## Purpose
Durable record bracketing around every external effect, including the outbox boundary around tracker writes and the cascade boundary that records the plan before any reset so that a cascade reopen resumes after a crash, recovery per boundary, adoption of surviving agents, fencing, sweeps, named crash points including `cascade.afterPlan`, and the convergence invariants the orchestrator must satisfy after any crash.

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
The code SHALL call `crashPoint(name)` at each boundary. When the environment variable `ORCH_CRASH_AT` equals the name the process SHALL exit immediately; otherwise the call SHALL do nothing. The named points SHALL be `launch.afterRow`, `launch.afterWorktree`, `launch.afterSpawn`, `launch.afterPid`, `api.afterEventCommit`, `verify.afterQueued`, `verify.afterRebase`, `verify.afterCheck`, `verify.afterSquash`, `verify.afterPublish`, `milestone.afterTag`, and `tick.afterPhase<n>` for each phase.

#### Scenario: Crash point fires only when named
- **WHEN** `ORCH_CRASH_AT` is `verify.afterSquash`
- **THEN** the daemon exits exactly there and nowhere else

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
