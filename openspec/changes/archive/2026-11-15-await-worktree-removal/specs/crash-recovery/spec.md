## MODIFIED Requirements

### Requirement: Fencing
A token SHALL be valid only for its launch. Recovery SHALL revoke tokens it cannot confirm. A revoked launch's calls SHALL return 401, its commits SHALL remain on its own branch, and its worktree SHALL be swept, so that a surviving orphan can waste compute but cannot affect task state or the integration branch. A call accepted before its launch was revoked SHALL check again before it records anything: a submit that was sealing its worktree when the launch was revoked SHALL return 401, and one whose task's lease moved to another launch SHALL return 409, with no task state changed.

#### Scenario: Orphan keeps running after revocation
- **WHEN** a revoked agent ignores the 401 and continues committing and calling the API
- **THEN** no task state changes, nothing reaches the integration branch, and its commits stay on the revoked branch

#### Scenario: Revoked while its submit was sealing
- **WHEN** an agent spawned before a crash at `launch.afterSpawn` submits after the restart, and recovery revokes its launch and relaunches the task while the submit seals the worktree
- **THEN** the submit returns 401, the task stays `running` under the new launch, and no verifier job is queued

## ADDED Requirements

### Requirement: Worktrees of done tasks removed at startup
Startup recovery, after it removes the registered worktrees of launches that are not live, SHALL remove the worktree of every `ended` or `revoked` launch whose task is `done` and whose worktree directory still exists, whether or not `git worktree list` still names it. A removal that leaves the worktree behind SHALL be retried by the tick.

#### Scenario: Unregistered directory of a done task removed
- **WHEN** the daemon restarts and a done task's ended launch still has its worktree directory, which the clone no longer lists
- **THEN** recovery deletes the directory

#### Scenario: Registered worktree of a done task removed
- **WHEN** the daemon restarts and a done task's ended launch still has a registered worktree
- **THEN** recovery removes it and `git worktree list` no longer names it
