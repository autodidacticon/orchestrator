## ADDED Requirements

### Requirement: Run skill handles health events
The `run` skill SHALL act on two more digest conditions. When `stuck` is non-empty it SHALL show each task with its idle time and last signal from `status` and offer the user a nudge with a message, cancellation, or continuing to wait, acting through `nudge` or `cancel`. When `pausedReason` is `costBudget` it SHALL report the run cost and the ceiling from `status` and offer `resume` with `overrideBudget` or stopping; it SHALL NOT override the budget without the user's say.

#### Scenario: Stuck task surfaced
- **WHEN** `wait` returns a digest with T3 under `stuck`
- **THEN** the skill shows T3 with its idle time and offers nudge, cancel, or wait, and sends the user's message through `nudge` if chosen

#### Scenario: Budget pause surfaced
- **WHEN** `wait` returns a digest with `pausedReason` `costBudget`
- **THEN** the skill reports the run cost and the ceiling and calls `resume` with `overrideBudget` only after the user agrees
