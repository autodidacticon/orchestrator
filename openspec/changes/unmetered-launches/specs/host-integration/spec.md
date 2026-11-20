## ADDED Requirements

### Requirement: Run skill names unmetered launches
Each run skill edition SHALL hold one paragraph, after the configuration-keys paragraph and the same in the Codex and OpenCode editions, saying that a launch that ended with no usage recorded counts in `cost.unmeteredLaunches`, outside `budgets.maxRunCostUsd`, and that the count is named with the run cost when a cost budget is set. Each `costBudget` bullet SHALL name the count, and the Claude Code edition's section 1a SHALL say its subagents record no usage.

#### Scenario: The three editions
- **WHEN** the three run skills are read
- **THEN** each holds one paragraph with `cost.unmeteredLaunches`, `no usage recorded` and `budgets.maxRunCostUsd`, and each `costBudget` bullet names `cost.unmeteredLaunches`

#### Scenario: Session subagents
- **WHEN** the Claude Code edition's section 1a is read
- **THEN** it says that launches worked by this session's subagents record no usage with the daemon
