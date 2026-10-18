## MODIFIED Requirements

### Requirement: Launch lifecycle records
A launch SHALL move through the durable states `preparing` (row written), `launching` (worktree ready, spawn in flight), `live` (pid recorded), and `ended` or `revoked`. The row written at `preparing` SHALL carry the runner kind, model, and effort fixed for the launch, so that liveness, reaping, and usage after a restart reach the runner the launch was prepared for; a row without a kind SHALL read as `claude-code`. The pid SHALL be recorded immediately after spawn returns, and `spawnedAt` SHALL be set only then.

#### Scenario: States recorded in order
- **WHEN** a task is launched without interruption
- **THEN** the launch row passes through `preparing`, `launching`, and `live` with a pid

#### Scenario: Kind survives a restart
- **WHEN** a `codex` launch is live and the daemon restarts
- **THEN** the row still carries `runner: "codex"` and its liveness and usage are read through the `codex` runner
