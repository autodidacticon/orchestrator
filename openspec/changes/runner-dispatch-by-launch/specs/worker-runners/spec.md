## ADDED Requirements

### Requirement: Runner dispatch by launch kind
The daemon SHALL hold one agent runner per runner kind behind a single dispatching runner, and SHALL route `spawn`, `alive`, `liveness`, `reap`, and `readUsage` for a launch to the runner of the kind fixed on its row, so a launch observed after a restart reaches the runner and the usage parser it was prepared for. A row without a kind SHALL be treated as `claude-code`. Killing by launch id, where only the id is known, SHALL be asked of every registered runner. A launch whose kind has no registered runner SHALL fail at spawn with an error naming the kind; its liveness SHALL be `unknown` and it SHALL have no usage. The allow list SHALL be given only to the brief of a `claude-code` launch.

#### Scenario: Calls follow the row
- **WHEN** a `claude-code` launch and a `codex` launch are spawned, observed, reaped, and their usage read
- **THEN** each call reaches the runner of the launch's own kind and never the other

#### Scenario: Row without a kind
- **WHEN** a launch row written before the kind was recorded is spawned or its usage read
- **THEN** the `claude-code` runner handles it

#### Scenario: Usage per kind
- **WHEN** a `claude-code` launch submits and a `codex` launch exits in the same run
- **THEN** each launch row records the usage its own kind's runner reads

#### Scenario: Kill by id reaches every runner
- **WHEN** recovery kills a launch by id
- **THEN** every registered runner is asked to kill processes of that id

#### Scenario: No runner for the kind
- **WHEN** a `codex` launch is spawned while no `codex` runner is registered
- **THEN** the spawn fails with an error naming `codex`
