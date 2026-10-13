## MODIFIED Requirements

### Requirement: Named crash points
The code SHALL call `crashPoint(name)` at each boundary. When the environment variable `ORCH_CRASH_AT` equals the name, or the file named by `ORCH_CRASH_AT_FILE` contains it, the process SHALL exit immediately; otherwise the call SHALL do nothing. The named points SHALL be `launch.afterRow`, `launch.afterWorktree`, `launch.afterSpawn`, `launch.afterPid`, `launch.afterClaimable`, `claim.afterRecord`, `api.afterEventCommit`, `verify.afterQueued`, `verify.afterRebase`, `verify.afterCheck`, `verify.afterSquash`, `verify.afterPublish`, `milestone.afterTag`, `cascade.afterPlan`, and `tick.afterPhase<n>` for each phase.

#### Scenario: Crash point fires only when named
- **WHEN** `ORCH_CRASH_AT` is `verify.afterSquash`
- **THEN** the daemon exits exactly there and nowhere else

#### Scenario: Crash point armed through a file while running
- **WHEN** the file named by `ORCH_CRASH_AT_FILE` is written with `tick.afterPhase1` while the daemon runs
- **THEN** the daemon exits at the end of the next phase 1 and not before

## ADDED Requirements

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
