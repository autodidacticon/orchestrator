## MODIFIED Requirements

### Requirement: Status report: health facts
`status` SHALL additionally report `stuck` (task ids flagged stuck), `pausedReason` (`operator` or `costBudget` while paused), `cost` with `runUsd`, `byTask`, `ceilingUsd`, `overrides`, and `unpricedLaunches` (launches that recorded tokens but no cost, outside `runUsd`), `tokens` with `run` and `byTask` (token counts summed over launch rows in the shape `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }`), `budgets` with the configured `maxLaunchMs`, `maxRunCostUsd`, `stuckAfterMs`, and `stuckFailAfterMs`, and for every live launch `elapsedMs`, `progressAt`, `lastSignal`, `idleMs`, `stuck`, and `costUsd` and `tokens` when known.

#### Scenario: Stuck task is visible
- **WHEN** T3's launch has been flagged stuck for two minutes
- **THEN** `status` lists T3 under `stuck` and its launch entry shows `stuck` true with `idleMs` and `lastSignal`

#### Scenario: Cost is reported
- **WHEN** two launches recorded 1.25 and 0.75 USD
- **THEN** `status` shows `cost.runUsd` 2 and `cost.byTask` with both tasks, and `cost.unpricedLaunches` 0

#### Scenario: Tokens without a price are reported
- **WHEN** T1's launch recorded 40361 input and 260 output tokens and no cost
- **THEN** `status` shows `tokens.run` and `tokens.byTask.T1` as `{ input: 40361, output: 260 }`, `cost.runUsd` 0, and `cost.unpricedLaunches` 1
