## ADDED Requirements

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
