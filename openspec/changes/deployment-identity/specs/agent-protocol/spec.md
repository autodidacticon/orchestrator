## MODIFIED Requirements

### Requirement: Agent environment
A launch the daemon spawns SHALL inherit the daemon's environment with these changes:
- `ORCH_HOME` replaced by a directory inside the run's data directory;
- `ORCH_URL`, `ORCH_REPO`, and `ORCH_DATA_DIR` removed;
- `DATABASE_URL`, `ORCH_RUN_ID`, and every variable whose value is the resolved store URL removed (specs/state-backend "No store URL in child environments"), for every runner kind;
- the agent variables `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_API`, `ORCH_RETRY_WINDOW_MS`, `ORCH_TASK_ID`, and `ORCH_WORKTREE` added.

An orchestrator client the agent runs therefore SHALL find no run under its `ORCH_HOME` and SHALL NOT be able to start, stop, or list a daemon of the user's. `ORCH_API` SHALL remain set so the shim reaches the agent's own daemon.

An MCP server that the agent's CLI spawns SHALL be assumed to receive only what the runner forwards to it explicitly, unless the CLI is known to pass its whole environment on. Codex passes the server a fixed set of variables plus its `env` entries. OpenCode passes the MCP child its whole environment plus the server's `environment`, so the OpenCode runner SHALL forward nothing: it puts the shim's variables in the agent environment, registers the server with no `environment` block, and keeps the token off argv and out of every file. The runners SHALL build the shim's variables through one `shimEnv` helper.

#### Scenario: Agent sees an isolated home
- **WHEN** a spawned agent's command writes `$ORCH_HOME` to a file
- **THEN** the path is inside the run's data directory, not the user's `~/.orchestrator`, and `ORCH_URL` is unset in the agent's environment

#### Scenario: Agent cannot list the user's runs
- **WHEN** a spawned agent runs `orchestrator-ctl runs`
- **THEN** the result lists no runs

#### Scenario: Agent sees no store URL
- **WHEN** the daemon's environment holds `DATABASE_URL` and `APP_DATABASE` set to the store URL, and a spawned agent's command prints its environment
- **THEN** the printout has neither variable nor the password
