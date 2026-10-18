## ADDED Requirements

### Requirement: Agent environment
A launch the daemon spawns SHALL inherit the daemon's environment with `ORCH_HOME` replaced by a directory inside the run's data directory and with `ORCH_URL`, `ORCH_REPO`, and `ORCH_DATA_DIR` removed, in addition to the agent variables `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_API`, `ORCH_TASK_ID`, and `ORCH_WORKTREE`. An orchestrator client the agent runs therefore SHALL find no run under its `ORCH_HOME` and SHALL NOT be able to start, stop, or list a daemon of the user's. `ORCH_API` SHALL remain set so the shim reaches the agent's own daemon.

#### Scenario: Agent sees an isolated home
- **WHEN** a spawned agent's command writes `$ORCH_HOME` to a file
- **THEN** the path is inside the run's data directory, not the user's `~/.orchestrator`, and `ORCH_URL` is unset in the agent's environment

#### Scenario: Agent cannot list the user's runs
- **WHEN** a spawned agent runs `orchestrator-ctl runs`
- **THEN** the result lists no runs
