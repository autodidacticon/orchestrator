## ADDED Requirements

### Requirement: Codex brief states the network limit
As an exception to the `needsAccess` rule of "Check command and tool rules in the brief", a `codex` brief whose sandbox lacks network SHALL tell the worker to run the parts of the check that work, submit without asking, and name in the report summary what did not run; a login, a credential or a token SHALL stay a `needsAccess` question. The bullet SHALL follow the configuration in force when the brief was composed, so a launch parked before a change and claimed after it keeps it.

#### Scenario: Network access in the brief input
- **WHEN** the daemon builds the brief input of a `codex` launch
- **THEN** its `runner` carries `networkAccess`: true under `runner.codex.sandbox: danger-full-access`, true under `workspace-write` when `runner.codex.networkAccess` is true, false under `read-only` or under `workspace-write` with the key unset or false, whatever the text of a custom `runner.codex.command`
- **AND** the brief input of a launch of another kind carries no `networkAccess` key

#### Scenario: No network access
- **WHEN** a `codex` launch with `networkAccess` false is briefed with check command `npm ci && npm test`
- **THEN** its Definition of done holds, after the check command bullet, one bullet saying the commands have no network access, so an install that must download fails and a test that opens a port or a local socket can fail, and that an install can be refused for writing to a package store outside the worktree
- **AND** the bullet says the orchestrator runs the check command itself, outside the sandbox, after the submit; that the worker runs the parts that do run and, for the rest, does not ask with a `needsAccess` question and does not wait but submits and names in the report summary each part that did not run and its error
- **AND** the bullet says it is the exception to the `needsAccess` rule under Workspace and that a login, a credential or a token stays a `needsAccess` question
- **AND** the check command bullet and the sandbox paragraph, with its pointer to `runner.codex.sandbox`, are unchanged
- **AND** `brief.json` carries `runner.networkAccess` false

#### Scenario: Network access granted under workspace-write
- **WHEN** a `codex` launch under `workspace-write` with `networkAccess` true is briefed with a check command
- **THEN** its Definition of done holds one bullet saying `runner.codex.networkAccess` is on but a test that opens a port or a local socket, and an install that writes to a package store outside the worktree, may still be refused, with the same submit rule and the same login and credential exception
- **AND** the brief neither says the commands have no network access nor that they have network access

#### Scenario: Danger-full-access
- **WHEN** a `codex` launch under `danger-full-access` with `networkAccess` true is briefed
- **THEN** the brief holds neither bullet

#### Scenario: No networkAccess field
- **WHEN** a brief is composed from an input whose `runner` has no `networkAccess`
- **THEN** the brief and `brief.json` are byte for byte what they were before this requirement

#### Scenario: No check command
- **WHEN** a `codex` launch with `networkAccess` false, or true under `workspace-write`, is briefed with no check command configured
- **THEN** the bullet speaks of the project's test suite in place of the check and does not say the orchestrator runs a check after the submit

#### Scenario: Another kind
- **WHEN** a brief input of a `claude-code` or `opencode` launch is composed, even one carrying `networkAccess`
- **THEN** the brief holds neither bullet

#### Scenario: Parked launch claimed after a change
- **WHEN** a launch parked under one value of `runner.codex.sandbox` or `runner.codex.networkAccess` is claimed after the operator changes it
- **THEN** the worker gets the brief composed when the launch was prepared, with its bullet unchanged
