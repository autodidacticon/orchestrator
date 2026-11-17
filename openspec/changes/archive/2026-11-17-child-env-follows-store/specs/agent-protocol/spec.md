## MODIFIED Requirements

### Requirement: Agent environment
A launch the daemon spawns SHALL inherit the daemon's environment with these changes:
- `ORCH_HOME` replaced by a directory inside the run's data directory;
- `ORCH_URL`, `ORCH_REPO`, `ORCH_DATA_DIR` and `ORCH_RUN_ID` removed on every store kind;
- while the daemon withholds (specs/state-backend "Withholding follows the store": always on a Postgres store), `DATABASE_URL`, `DATABASE_URL_FILE`, every libpq connection variable named in `LIBPQ_VARS`, and every variable whose value is the resolved store URL removed (specs/state-backend "No store URL in child environments"), for every runner kind. While it does not withhold (a SQLite store with no Postgres input), they are passed unchanged;
- the agent variables `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_API`, `ORCH_RETRY_WINDOW_MS`, `ORCH_TASK_ID`, and `ORCH_WORKTREE` added.

The `env` block of a codex or opencode claim SHALL carry the same changes. A removed name appears there as an empty value, which the work loop deletes. A name that is passed does not appear there at all, so the worker's own value stays.

An orchestrator client the agent runs therefore SHALL find no run under its `ORCH_HOME` and SHALL NOT be able to start, stop, or list a daemon of the user's. `ORCH_API` SHALL remain set so the shim reaches the agent's own daemon. What a spawned agent running as the daemon's user can still reach of the store's credentials is stated in specs/state-backend "Store credentials a child can still reach".

An MCP server that the agent's CLI spawns SHALL be assumed to receive only what the runner forwards to it explicitly, unless the CLI is known to pass its whole environment on. Codex passes the server a fixed set of variables plus its `env` entries. OpenCode passes the MCP child its whole environment plus the server's `environment`, so the OpenCode runner SHALL forward nothing: it puts the shim's variables in the agent environment, registers the server with no `environment` block, and keeps the token off argv and out of every file. The runners SHALL build the shim's variables through one `shimEnv` helper.

#### Scenario: Agent sees an isolated home
- **WHEN** a spawned agent's command writes `$ORCH_HOME` to a file
- **THEN** the path is inside the run's data directory, not the user's `~/.orchestrator`, and `ORCH_URL` is unset in the agent's environment

#### Scenario: Agent cannot list the user's runs
- **WHEN** a spawned agent runs `orchestrator-ctl runs`
- **THEN** the result lists no runs

#### Scenario: Agent sees no store URL
- **WHEN** a daemon that withholds has `DATABASE_URL` and `APP_DATABASE` set to the store URL, `DATABASE_URL_FILE`, and every name in `LIBPQ_VARS` with `PGPASSWORD` set in its environment, and a spawned agent's command prints its environment
- **THEN** the printout has none of those variables, not the password and not the `PGPASSWORD` value

#### Scenario: Agent on a SQLite run keeps the project's database variables
- **WHEN** a daemon with a SQLite store and no Postgres input has `DATABASE_URL`, `APP_DATABASE` set to the same value, `DATABASE_URL_FILE`, `PGHOST` and `PGPASSWORD` in its environment, and a spawned agent's command prints its environment; or a codex or opencode worker claims a launch from that daemon
- **THEN** the printout holds each of them with its value and no `ORCH_URL` or `ORCH_RUN_ID` line; the claim's `env` block has no key for any of them and has `ORCH_RUN_ID` empty
