## ADDED Requirements

### Requirement: Nudge
`nudge` SHALL take a task id and a message, SHALL record an operator event, and SHALL queue an inbox notice `{ kind: 'nudge', message }` on the task's live launch. It SHALL be reachable as `POST /v1/tasks/:id/nudge`, as the CLI command `nudge <task> <message>`, and as the MCP tool `nudge`. A task with no live launch SHALL be answered with 409 naming its status.

#### Scenario: Nudge a running task
- **WHEN** an operator nudges running task T2 with a message
- **THEN** the event log contains an operator nudge event for T2 with the message and T2's live launch holds the notice

#### Scenario: Nudge without a live launch
- **WHEN** an operator nudges a task that is `unstarted`
- **THEN** the response is 409 naming `unstarted` and no notice is queued

### Requirement: Status report: health facts
`status` SHALL additionally report `stuck` (task ids flagged stuck), `pausedReason` (`operator` or `costBudget` while paused), `cost` with `runUsd`, `byTask`, `ceilingUsd`, and `overrides`, `budgets` with the configured `maxLaunchMs`, `maxRunCostUsd`, `stuckAfterMs`, and `stuckFailAfterMs`, and for every live launch `elapsedMs`, `progressAt`, `lastSignal`, `idleMs`, `stuck`, and `costUsd` when known.

#### Scenario: Stuck task is visible
- **WHEN** T3's launch has been flagged stuck for two minutes
- **THEN** `status` lists T3 under `stuck` and its launch entry shows `stuck` true with `idleMs` and `lastSignal`

#### Scenario: Cost is reported
- **WHEN** two launches recorded 1.25 and 0.75 USD
- **THEN** `status` shows `cost.runUsd` 2 and `cost.byTask` with both tasks

### Requirement: Budget pause and override
When the run cost budget is reached, the run SHALL be paused with `pausedReason: 'costBudget'`, stored as durably as an operator pause, while running work and verification continue. `resume` SHALL accept `overrideBudget`. Without it, `resume` while the run cost is at or above the ceiling SHALL be refused with 409 naming `costBudget`, the run cost, and the ceiling. With it, the override SHALL be recorded as an operator event and the pause lifted. The CLI flag SHALL be `--override-budget`.

#### Scenario: Resume refused over budget
- **WHEN** the run is paused for `costBudget` and `resume` is called without `overrideBudget`
- **THEN** the response is 409 with `costBudget`, the run cost, and the ceiling, and the run stays paused

#### Scenario: Resume with override
- **WHEN** `resume` is called with `overrideBudget` true
- **THEN** an operator resume event with the override is recorded, the pause is lifted, and admission continues
