## ADDED Requirements

### Requirement: Prepare command at recovery
With `prepareCommand` set, recovery SHALL end a parked launch the configured command has not run for, with `endReason` `notPrepared`, and fail its task with `worktreeLost` at no cost, so admission makes the launch again. This narrows "Re-preparing a parked launch": such a launch is not prepared in place and no `launch.reprepared` is appended. Recovery SHALL NOT wait for a command.

#### Scenario: Three cases
- **WHEN** a parked launch's worktree is lost, or it has no `launch.prepared` event, or its latest `launch.prepared` names another command
- **THEN** the launch is ended with `notPrepared`, the task is retried with `attempts` unchanged, and the next tick makes a new launch whose command runs

#### Scenario: Brief of the next launch
- **WHEN** such a task is launched again
- **THEN** its prior failure says the launch is made again because the prepare command had not run for it, that nothing was wrong with the task, and that no attempt is spent

#### Scenario: A prepared parked launch stays
- **WHEN** a parked launch's latest `launch.prepared` names the configured command and its worktree is present
- **THEN** it stays `claimable` and the command does not run for it

#### Scenario: A claim during recovery
- **WHEN** a claim lands while recovery walks the parked launches
- **THEN** recovery reads the row and the task again and ends nothing unless the row is still `claimable` for a running task

#### Scenario: Command left by a crash
- **WHEN** the daemon crashed while a command ran
- **THEN** recovery revokes the `preparing` or `launching` row, kills the command by launch id, removes the worktree and starts the same attempt again, which starts the command again; recovery returns without waiting, and the first ticks apply the outcome
