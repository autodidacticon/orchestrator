## ADDED Requirements

### Requirement: Worktree commands are serialized per clone
Every `git worktree` command the daemon runs in a clone (adding a launch worktree, re-attaching a launch branch, removing, pruning, listing, and the verifier's temporary worktrees) SHALL wait for every such command already started in the same clone, so that no two overlap. The clone SHALL be identified by its real path, so that two spellings of one clone share the lock. A failed command SHALL release the lock to the next.

#### Scenario: Removal and add in one clone do not overlap
- **WHEN** the removal of a published launch's worktree and the next launch's `git worktree add` are started at the same time in one clone
- **THEN** one runs after the other, the add succeeds, and the removed worktree is neither on disk nor listed by `git worktree list`

#### Scenario: Two spellings of one clone share the lock
- **WHEN** worktree commands name the clone once through a symbolic link and once through its real path
- **THEN** they still run one at a time

### Requirement: Worktree removal on publish
When the tick applies a terminal verifier job, it SHALL await the removal of the job's launch worktree before later phases, and for a task now `done`, of its other ended launches' worktrees. A removal SHALL never throw and SHALL count as done only when the path is neither on disk nor registered with the clone. A worktree left behind SHALL be retried on every later tick until it is gone, with one attempt per tick while the launch is live.

#### Scenario: Worktree gone at the end of the publishing tick
- **WHEN** a task's verifier job is published while its launch is still live
- **THEN** at the end of the tick that marks the task `done`, the launch has no worktree

#### Scenario: Left-behind worktree retried
- **WHEN** the removal after a publication leaves the worktree behind
- **THEN** the next tick removes it

#### Scenario: Other ended launches of the task cleared
- **WHEN** a task is published while an earlier ended launch of the same task still has its worktree
- **THEN** that worktree is removed too

#### Scenario: Stale registration cleared
- **WHEN** a launch worktree's directory is already gone but the clone still lists it
- **THEN** the removal prunes the registration and reports the worktree gone
