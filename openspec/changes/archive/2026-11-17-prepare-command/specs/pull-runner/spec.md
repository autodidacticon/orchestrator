## ADDED Requirements

### Requirement: Prepare command
With the top-level file key `prepareCommand` set, the daemon SHALL run it once after each `Workspace.prepare` of a launch, for every runner kind and mode, in the background so the tick does not wait. The launch SHALL be parked or spawned only after the command now configured exited 0 and left the worktree clean outside `.orchestrator/`. Unset, nothing changes. This narrows "Failed launch at admission": a task MAY be `running` on a `preparing` or `launching` row while its command runs.

#### Scenario: Keys
- **WHEN** the configuration file is read at start
- **THEN** `prepareCommand` is an optional non-empty string and `prepareTimeoutMs` a positive integer defaulting to 600000; neither is an override, neither is detected, and neither is in the config report

#### Scenario: Background run and row status
- **WHEN** admission creates a launch while `prepareCommand` is set
- **THEN** `launch.prepareStarted` with `{ command, timeoutMs }` is appended, the tick goes on, and the row stays `preparing` while the command runs; no launch status is added and the job is held in memory only

#### Scenario: Capacity and scope
- **WHEN** a launch's command runs
- **THEN** its task is `running`, so the launch holds a capacity slot and its task's scope, and at most `capacity` commands run at once

#### Scenario: Environment
- **WHEN** the command runs
- **THEN** it runs like the check command: in the worktree root, with the check command's environment, a 64 KiB output tail written to one daemon log line, and its process group killed at `prepareTimeoutMs`
- **AND** it is started as `/bin/sh -c '/bin/sh -c "$1"; exit $?' orch-prepare-<launchId> <prepareCommand>`, so `killByLaunchId` finds it after a crash

#### Scenario: Bounded wait after a kill
- **WHEN** a command the daemon killed, at the timeout or at an abort, has not closed 2000 ms later, or a command exited while another process still holds its output pipe
- **THEN** its outcome is recorded then, as `timeout` at the timeout and as aborted at an abort, and no job stays without an outcome

#### Scenario: Success and next step
- **WHEN** the command exited 0 and the worktree is clean
- **THEN** a tick appends `launch.prepared` with `{ command, durationMs }` and then parks the launch, or spawns it when the row is `launching` or the mode was `spawn` when the command started
- **AND** the lease is renewed for a full TTL immediately before the spawn

#### Scenario: Outcome applied by the tick
- **WHEN** the command ends
- **THEN** its callback only records the outcome in the job and wakes the loop; the tick applies it, and no job's error ends the tick or keeps the other jobs from being handled in the same pass

#### Scenario: Pause
- **WHEN** a command succeeds while the run is paused
- **THEN** a launch whose next step is park is parked at once, and one whose next step is spawn waits in `preparing` or `launching` until the resume; a running command is not stopped

#### Scenario: Hold after a gap
- **WHEN** the daemon is in the hold after a gap
- **THEN** no new command starts and no prepared launch is spawned, a running command is not interrupted, a success is applied, and a launch whose next step is park is parked

#### Scenario: Second run in mixed mode
- **WHEN** in `mixed` mode the daemon spawns a parked launch after the claim window
- **THEN** its worktree is prepared again and the command runs a second time while the row is `launching`; a failure of that run is a prepare failure
- **AND** a `launching` row can last for the length of a command, while no agent holds its token

#### Scenario: Not claimable before success
- **WHEN** a worker claims while a launch's command runs
- **THEN** that launch is not offered, and a claim naming its task answers 409 with `state` `preparing`

### Requirement: Prepare failure
A command that exits non-zero, times out, is killed from outside, cannot be started, or leaves the worktree dirty or unreadable SHALL be a prepare failure. It SHALL spend no attempt: the launch is ended with `prepareCommandFailed`, `launch.prepareFailed` appended, the worktree removed, and the task returned to `unstarted` by the orchestrator with trigger `prepareFailed`, attempts and carry unchanged.

#### Scenario: Event payload
- **WHEN** a prepare failure is applied
- **THEN** `launch.prepareFailed` carries `{ reason, exitCode, durationMs, output, dirty, error }`, `output` being the last 4096 characters of the command's output

#### Scenario: Reasons
- **WHEN** the command exits non-zero, times out, dies from a signal the daemon did not send, cannot be started (or the runner throws), or leaves the worktree dirty
- **THEN** the reason is `exit`, `timeout`, `killed`, `spawn` or `dirty` respectively; a `dirty` failure names up to 10 paths, and the daemon never edits ignore rules

#### Scenario: A throwing clean test
- **WHEN** the clean test after a zero exit throws
- **THEN** it is a prepare failure of reason `dirty` with `error` holding the error text, and the other jobs are handled in the same tick

#### Scenario: No attempt spent
- **WHEN** a prepare failure is applied
- **THEN** the task is not charged an attempt and has no `priorFailure` added; while the run is paused it is not admitted again before the resume

### Requirement: Prepare command and a task that left
When the task no longer runs on a launch whose command runs (cancelled, reset by a cascade, superseded), the next tick SHALL kill the command by its own handle and, once it has ended, end the launch (`cancelled` for a cancelled task, else `superseded`) and remove the worktree, appending no `launch.prepareFailed`. `stop()` SHALL abort every command and apply nothing.

#### Scenario: Cancel while the command runs
- **WHEN** a task is cancelled while its launch's command runs
- **THEN** the next tick aborts the command, and after it ended the launch is ended as `cancelled` and its worktree removed, with no `launch.live` or `launch.claimable`

#### Scenario: Cascade while the command runs
- **WHEN** a cascade resets the task while its command runs, and admission launches it again
- **THEN** the old launch alone is ended as `superseded`; the jobs are keyed by launch id and the two commands run in separate worktrees

#### Scenario: Left between success and spawn
- **WHEN** the task leaves after its success was applied and before the spawn
- **THEN** the launch is not spawned, its job is kept, and the next pass over the jobs ends it as above

#### Scenario: Stop
- **WHEN** `stop()` runs while commands run
- **THEN** each is aborted, `stop()` waits for them for no longer than 5000 ms in all, the rows stay `preparing` or `launching` for the next start, and no command starts after it

#### Scenario: Fatal store
- **WHEN** the store goes fatal while a command runs
- **THEN** the job records nothing and the row stays for the next start
