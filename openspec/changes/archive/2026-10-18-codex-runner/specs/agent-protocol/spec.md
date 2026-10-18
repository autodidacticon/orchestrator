## MODIFIED Requirements

### Requirement: Launch token scoping
Every API call SHALL carry a bearer token issued for one launch. A call whose token does not match the launch in the path, or whose launch has been revoked or ended, SHALL be answered with 401 and SHALL have no effect.

A runner SHALL NOT put the launch token on the argv of any process it starts. The token SHALL reach the shim through a file in `<worktree>/.orchestrator/` with mode 0600: `mcp.json` for Claude Code, or `shim.env`, named by the shim's `--orch-env-file`, for Codex.

#### Scenario: Token for another launch
- **WHEN** launch L1's token is used against launch L2's endpoints
- **THEN** the response is 401 and no event is recorded

#### Scenario: Revoked launch
- **WHEN** a launch has been revoked by recovery and its process calls `report`
- **THEN** the response is 401 and the task state is unchanged

#### Scenario: Token off argv
- **WHEN** a codex launch is spawned
- **THEN** its command line names `.orchestrator/shim.env` but does not contain the token, and the file's mode is 0600

### Requirement: Block and wait
`block` SHALL persist the question, move the task to `waiting`, release its run slot, and hold the connection open until an answer is delivered or `maxWait` elapses. An operator answer SHALL be persisted before any resume. The task SHALL return to `running`, and the long-poll SHALL complete only after the scheduler admits it. A dropped connection SHALL be recoverable by re-issuing `block` with the same `seq`, which returns the stored answer once admitted. When `maxWait` elapses, the task SHALL become `blocked` with the question preserved, and a later answer SHALL act as unblock-with-answer.

A runner whose CLI times out MCP tool calls SHALL size that timeout above `maxWait`. The Codex runner's default is `ceil(maxWaitMs/1000)+60` seconds.

#### Scenario: Answer then admission then resume
- **WHEN** an agent blocks, a human answers, and a slot is free
- **THEN** the task is `running` and the long-poll returns the answer

#### Scenario: Replay after disconnect
- **WHEN** the long-poll connection drops, a human answers, and the agent re-issues `block` with the same seq
- **THEN** the call returns the answer after admission and no second question is recorded

#### Scenario: maxWait degrades to blocked
- **WHEN** no answer arrives within `maxWait`
- **THEN** the long-poll returns a timeout, the task is `blocked` with the question, and an answer given later produces a new launch whose brief carries it

### Requirement: MCP façade
A stdio MCP server launched per agent SHALL expose the five operations as tools, forward them to the HTTP API with the token from its environment, and retry through daemon restarts for the retry window before surfacing an error.

Started with `--orch-env-file <path>`, the façade SHALL layer the file's `KEY=VALUE` lines over its environment. When the file is missing or unreadable, it SHALL exit 1 with a message naming the path. The flag is not `--env-file`, because Node takes that flag from anywhere in argv.

The `report` tool's description SHALL state that a submit requires a committed, clean worktree only when `ORCH_COMMIT_POLICY` is unset or `agent`.

A runner whose CLI can treat an MCP server as optional or gate its tools behind approvals SHALL register the façade as required and with its tools pre-approved. For Codex this means `required=true`, plus the default and per-tool `approve` keys.

#### Scenario: Daemon restart during a call
- **WHEN** the daemon is restarting while an agent calls the `report` tool
- **THEN** the façade retries until the daemon is back and the call succeeds within the retry window

#### Scenario: Report tool under daemon commits
- **WHEN** the façade starts with `ORCH_COMMIT_POLICY=daemon`
- **THEN** the `report` tool's description does not require a committed, clean worktree

#### Scenario: Env file
- **WHEN** the façade starts with `--orch-env-file` naming a file that holds the launch's variables, and none of them is in its environment
- **THEN** a `heartbeat` call is forwarded with the token from the file

#### Scenario: Env file missing
- **WHEN** the façade starts with `--orch-env-file` naming a file that does not exist
- **THEN** it exits 1 and stderr names the file

### Requirement: Agent environment
A launch the daemon spawns SHALL inherit the daemon's environment with these changes:
- `ORCH_HOME` replaced by a directory inside the run's data directory;
- `ORCH_URL`, `ORCH_REPO`, and `ORCH_DATA_DIR` removed;
- the agent variables `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_API`, `ORCH_RETRY_WINDOW_MS`, `ORCH_TASK_ID`, and `ORCH_WORKTREE` added.

An orchestrator client the agent runs therefore SHALL find no run under its `ORCH_HOME` and SHALL NOT be able to start, stop, or list a daemon of the user's. `ORCH_API` SHALL remain set so the shim reaches the agent's own daemon.

An MCP server that the agent's CLI spawns SHALL be assumed to receive only what the runner forwards to it explicitly. Codex passes the server a fixed set of variables plus its `env` entries. Both runners SHALL build the shim's variables through one `shimEnv` helper.

#### Scenario: Agent sees an isolated home
- **WHEN** a spawned agent's command writes `$ORCH_HOME` to a file
- **THEN** the path is inside the run's data directory, not the user's `~/.orchestrator`, and `ORCH_URL` is unset in the agent's environment

#### Scenario: Agent cannot list the user's runs
- **WHEN** a spawned agent runs `orchestrator-ctl runs`
- **THEN** the result lists no runs
