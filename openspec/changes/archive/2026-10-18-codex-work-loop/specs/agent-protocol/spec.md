## MODIFIED Requirements

### Requirement: Worker access
A worker that holds a claimed launch SHALL use the same five operations with the launch token, either directly against the loopback API or through the token-scoped operator tools, and SHALL be subject to the same scoping, deduplication, sealing, and fencing rules as a spawned agent. The daemon SHALL NOT spawn the per-launch MCP façade for a claimed launch. A worker loop that runs the agent as its own process, such as the Codex work loop, MAY register the façade for that process the way the runner of that kind registers it for a spawned launch, with the launch's identity in the same env file, so that the agent sees the same tool names. The fallback file SHALL NOT be available to workers: the orchestrator reads `.orchestrator/report.json` only when it finds a launch's process dead, and a claimed launch has no process the daemon watches, so a worker that cannot reach the API SHALL keep retrying until the daemon answers or its lease expires. The brief SHALL be the same document for spawned and claimed launches, and the worker instructions SHALL override its fallback-file guidance.

#### Scenario: Worker submits through the operator server
- **WHEN** a worker commits in the worktree and calls `launch_report` with kind `submit` and its token
- **THEN** the submission is sealed and the task is `submitted` exactly as for a spawned agent

#### Scenario: Worker loop registers the façade for its agent
- **WHEN** the Codex work loop claims a codex launch and runs `codex exec` for it
- **THEN** the command registers the shim as `mcp_servers.orchestrator` with the launch's env file, the agent reports through `orchestrator.report`, and the daemon spawned no process for the launch

#### Scenario: Fallback file is not read for a claimed launch
- **WHEN** a worker writes `.orchestrator/report.json` with a submit and stops calling the API
- **THEN** the lease expires, the task is `failed` with reason `leaseExpired`, and the file is swept with the worktree

#### Scenario: Worker fenced after release
- **WHEN** a launch is released and its former worker calls `launch_heartbeat` with the old token
- **THEN** the response is 401 and nothing changes
