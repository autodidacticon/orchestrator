## ADDED Requirements

### Requirement: Status report: launches being prepared
The status report SHALL always carry `preparing`, the task ids of launches being prepared (row `preparing` or `launching`), oldest first; `prepareRetry`, `[{ taskId, failures, retryAt }]` for every retry entry whose task is `unstarted`, by `retryAt`, then task id; and `preparingByKind`, per runner kind the launches being prepared plus the tasks in `prepareRetry`, every kind present. The wait digest SHALL carry `preparing`, the sum of `preparingByKind`, and `preparingByKind`.

#### Scenario: Command running
- **WHEN** a `pull` run's only task, of kind `codex`, has a launch whose prepare command is running
- **THEN** `status.preparing` lists the task, `preparingByKind.codex` is 1, `claimable` is empty, and the digest has `preparing: 1`; after the command succeeds `preparing` is empty and `claimableByKind.codex` is 1

#### Scenario: Retry entry counted until the task is launched
- **WHEN** a task's prepare command failed once and the clock has passed its `retryAt` but no tick has run
- **THEN** `prepareRetry` still lists it with its `failures` and `retryAt` and `preparingByKind` counts it; after the next tick launches it, it is in `preparing` only and counted once

#### Scenario: A task counted once
- **WHEN** a task with a retry entry runs on a launch being prepared
- **THEN** it is in `preparing` and not in `prepareRetry`, and `preparingByKind` counts it once

#### Scenario: Entry no longer counted
- **WHEN** a task with a retry entry is cancelled, blocked with `prepareFailed`, done, or no longer a task of the loaded graph
- **THEN** it is in neither list and is not counted

#### Scenario: Prepare command unset
- **WHEN** `prepareCommand` is unset
- **THEN** `prepareRetry` is empty, the retry entries are not read, and `preparing` holds only `launching` rows of an ordinary spawn

#### Scenario: Derived from the store
- **WHEN** a daemon restarts on a store with a launch left `preparing` and a retry entry of an `unstarted` task
- **THEN** before its first tick its status lists the launch's task in `preparing` and the entry in `prepareRetry` with the same `failures` and `retryAt`

#### Scenario: Launching row in mixed mode
- **WHEN** in `mixed` mode the daemon takes back a parked launch after the claim window and its prepare command runs again with the row `launching`
- **THEN** the task is in `preparing` and counted under its kind, so a work loop of that kind can stay up for the length of that install though nothing becomes claimable from it

#### Scenario: Bodies without a graph
- **WHEN** no graph is loaded
- **THEN** the status body carries `preparing: []`, `prepareRetry: []` and `preparingByKind` all zero, and the digest carries `preparing: 0` and `preparingByKind` all zero
