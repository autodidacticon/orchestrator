## ADDED Requirements

### Requirement: Claimed lease expired while the daemon was down
At startup, recovery SHALL treat a `running` claimed launch whose lease expired while the daemon was down as the tick treats an expired claim (specs/pull-runner "Lease expiry"): with progress in its worktree and `interruptions` under `daemon.maxKeptReleases`, a kept release that keeps the branch and spends no attempt; otherwise a failed attempt with reason `leaseExpired`. Either way the launch ends with `leaseExpired` and its worktree is removed.

#### Scenario: Expired claim with a commit
- **WHEN** the daemon is down past the lease of a claimed launch that has committed, and restarts
- **THEN** the launch ends with `leaseExpired` and `kept: true`, its branch stays at the commit, and the task is `unstarted` with `attempts` 0 and `interruptions` 1

#### Scenario: Expired claim without progress
- **WHEN** the daemon is down past the lease of a claimed launch that changed nothing, and restarts
- **THEN** the launch ends with `leaseExpired` and the task's `attempts` is 1

## MODIFIED Requirements

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
