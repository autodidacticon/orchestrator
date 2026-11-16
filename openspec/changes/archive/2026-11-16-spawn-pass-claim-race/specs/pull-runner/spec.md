## ADDED Requirements

### Requirement: Spawn pass reads each launch before it spawns it
The spawn pass SHALL read each launch's status and its task's entry again just before it changes the launch, not rely on a list read before earlier awaits. It SHALL move the launch from `claimable` to `launching` in the same synchronous store step as that read, and only while the launch is `claimable` and is the lease of a `running` task. A launch claimed meanwhile SHALL keep its worker, lease and worktree, and SHALL NOT be prepared again or spawned.

#### Scenario: Claim lands while the pass awaits another launch
- **WHEN** in `mixed` mode two parked launches are past their window, the pass is awaiting the prepare of the first, and a worker claims the second
- **THEN** the second launch stays `live` with the worker and no pid, its worktree and brief are untouched, its events end with `launch.claimed`, and only the first launch is spawned

### Requirement: Failed spawn of a parked launch
A launch the spawn pass moved to `launching` SHALL NOT stay `launching` when its worktree removal reports the worktree still present, or when its prepare or spawn throws. The pass SHALL NOT prepare over a worktree it could not remove. Within the same daemon process the pass SHALL end the launch with `endReason` `spawnFailed`, the stage (`remove`, `prepare` or `spawn`) and the error.

#### Scenario: Prepare fails
- **WHEN** in `mixed` mode the pass re-prepares a parked launch past its window and the prepare throws
- **THEN** no launch is left `launching`, the launch is `ended` with `spawnFailed` and stage `prepare`, and no agent was spawned for it

#### Scenario: Removal leaves the worktree
- **WHEN** the pass cannot remove a parked launch's worktree
- **THEN** the worktree is not prepared again, the launch is `ended` with `spawnFailed` and stage `remove`, and no agent is spawned for it

### Requirement: Failed spawn fails the attempt
In the transaction that ends a launch whose spawn failed, when the launch is still the lease of a `running` task, the pass SHALL fail the task's attempt with kind `exitedWithoutReport` and detail `spawnFailed: true` with the stage. The failure SHALL be charged as a death is: the task is launched again by the retry, and a failure that repeats ends in `blocked` once attempts are exhausted.

#### Scenario: Task launched again after a failed prepare
- **WHEN** the pass's prepare of a parked launch throws once
- **THEN** the attempt is counted, the task is `running` on a new launch, and the pass spawns that launch after its window

### Requirement: Failed launch at admission
A launch created at admission whose prepare or spawn throws SHALL NOT leave its task `running` on a `preparing` or `launching` row. In any runner mode the orchestrator SHALL end that launch and fail its attempt as for a failed spawn of a parked launch, with the stage `prepare` or `spawn`, and SHALL NOT let the error end the tick. A throw before the launch row exists SHALL leave the task as it was.

#### Scenario: Prepare that always fails
- **WHEN** in `mixed` mode every prepare throws
- **THEN** no tick throws, no launch is left `preparing` or `launching`, the task is never `running` without a parked or live launch, and it ends `blocked` once its attempts are exhausted

#### Scenario: Spawn fails at admission in spawn mode
- **WHEN** in `spawn` mode the spawn of a newly admitted launch throws
- **THEN** the launch is `ended` with `spawnFailed` and stage `spawn`, the attempt is counted, and the task is launched again on a later tick

### Requirement: Cleanup after a failed spawn
Only after the store work for a failed spawn SHALL the pass kill any process by the launch's id and remove its worktree. Both steps SHALL be best effort and SHALL NOT throw out of the pass. A worktree left behind SHALL join the pending removals retried on later ticks.

#### Scenario: Worktree of a failed spawn removed
- **WHEN** a spawn fails after the worktree was prepared
- **THEN** the worktree is removed, or retried on a later tick when the removal leaves it
