## ADDED Requirements

### Requirement: Time budget of a claimed launch
For "Launch time budget", the elapsed time of a launch SHALL start at `spawnedAt`, else at `claimableAt`, else at `createdAt`. So a claimed launch's elapsed time starts when it became claimable: the prepare command and the worktree's preparation do not count, time parked does, a spawned launch counts from `spawnedAt`, and the stuck clock is unchanged. `status().liveLaunches[].elapsedMs` SHALL use the same start.

#### Scenario: Claimed after a long install
- **WHEN** in `pull` mode with `budgets.maxLaunchMs` of one hour a launch's prepare command took 30 minutes and the launch was claimed 20 minutes after it was parked
- **THEN** it is still live 59 minutes after `claimableAt` with `elapsedMs` of 59 minutes, and is ended with `endReason` `timeBudget` one hour after `claimableAt`

#### Scenario: Spawned launch
- **WHEN** in `spawn` mode a launch's prepare command took 30 minutes and its agent has run for 5 minutes
- **THEN** its `elapsedMs` is 5 minutes

#### Scenario: Row without claimableAt
- **WHEN** a live launch has neither `spawnedAt` nor `claimableAt`
- **THEN** its elapsed time starts at `createdAt`
