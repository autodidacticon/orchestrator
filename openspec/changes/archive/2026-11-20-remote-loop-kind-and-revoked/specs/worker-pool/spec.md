## ADDED Requirements

### Requirement: Worker loop: runner filter
The loop SHALL read `ORCH_WORKER_RUNNER`, one runner kind or a comma-separated list of kinds, and SHALL send it on every claim as `runner`: a string for one kind, a list for several. Unset, the claim SHALL carry no `runner`, and a loop with the `command` agent SHALL write one stderr line at its start that names `ORCH_WORKER_RUNNER` and says it claims launches of every runner kind.

#### Scenario: One kind
- **WHEN** a loop with `ORCH_WORKER_RUNNER=claude-code` claims on a remote run where an `opencode` launch and a `claude-code` launch are claimable
- **THEN** its claim body is `{ workerId, access: 'remote', runner: 'claude-code' }`, it works the `claude-code` launch, and the `opencode` launch stays `claimable`

#### Scenario: Several kinds
- **WHEN** `ORCH_WORKER_RUNNER` is ` codex , opencode `
- **THEN** every claim carries `runner: ['codex', 'opencode']`

#### Scenario: Unset
- **WHEN** a loop with the `command` agent starts without `ORCH_WORKER_RUNNER`
- **THEN** its claims carry no `runner` and its stderr holds one line naming `ORCH_WORKER_RUNNER` and `every runner kind`; a loop with the scripted agent writes no such line

### Requirement: Worker loop: runner filter: malformed value
A value of `ORCH_WORKER_RUNNER` with a part outside the runner kinds, an empty part included, SHALL refuse the start with exit 2 and a message naming `ORCH_WORKER_RUNNER`.

#### Scenario: Unknown kind
- **WHEN** the loop starts with `ORCH_WORKER_RUNNER=gemini` or `ORCH_WORKER_RUNNER=codex,`
- **THEN** it exits 2 with a message naming `ORCH_WORKER_RUNNER` and claims nothing

### Requirement: Worker loop: revoked launch: command agent
When a heartbeat for a launch whose command agent still runs is answered 401, the loop SHALL read `GET /v1/status` once and stop the agent as on termination: SIGTERM to its process group, then SIGKILL after `ORCH_WORKER_AGENT_STOP_MS`. It SHALL print `agent-ended` for the launch, then take the steps after the agent as for any exit. The loop SHALL keep no silence clock of its own.

#### Scenario: Launch cancelled
- **WHEN** the task of a launch whose command agent runs is cancelled and the daemon ticks
- **THEN** within one heartbeat interval and the stop limit the agent is gone, the loop prints `agent-ended` and then `ended`, releases nothing, and claims again

#### Scenario: Launch failed as stuck
- **WHEN** the daemon fails a claimed launch as `stuck` past `health.stuckFailAfterMs`
- **THEN** the next heartbeat is answered 401, the agent is stopped, the task's attempt is spent by the daemon, and the loop releases nothing

#### Scenario: No clock of its own
- **WHEN** the daemon's stuck limits are 0 and a command agent prints nothing for three lease TTLs
- **THEN** the agent still runs and the loop has sent no `GET /v1/status`

### Requirement: Worker loop: revoked launch: report grace
When the status read after the 401 shows the task `submitted` or `done`, the loop SHALL let the command agent run up to 30000 ms more to exit by itself, so its usage object is printed and posted, and SHALL stop it after that. A termination request during the grace SHALL stop it at once.

#### Scenario: Agent lingers after its report
- **WHEN** an agent that submitted keeps running after a heartbeat answered 401
- **THEN** it still runs right after the 401, is stopped once the grace has passed, and the loop prints `agent-ended` and then `report accepted`

#### Scenario: Agent exits within the grace
- **WHEN** an agent that submitted prints its result object and exits within the grace
- **THEN** the loop prints no `agent-ended`, and the launch's usage is recorded with `usageSource` `worker`

### Requirement: Worker loop: revoked launch: unreadable status
When the status read after a heartbeat answered 401 is answered with another status than 200, or not answered, the loop SHALL stop the command agent at once, without the report grace.

#### Scenario: Status answered 500
- **WHEN** the status read after the 401 is answered 500 while the agent's task is submitted
- **THEN** the agent is stopped at once and the loop prints `agent-ended`
