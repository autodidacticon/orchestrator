## MODIFIED Requirements

### Requirement: Inbox notices for health
The inbox SHALL deliver notices of kind `stuck` with `idleMs` and a `message`, `nudge` with the operator's `message`, `baseMoved` with the new integration `head` and the `files` its commit touched, and `payloadChanged` with the new graph `rev`. The brief's workspace section SHALL state that such notices may arrive in the inbox, name the four kinds, tell the agent to check `inbox` after long steps, and state that rebasing the launch branch onto the integration head is allowed while merging into, pushing to, or checking out the integration branch is not.

#### Scenario: Nudge reaches the agent on its next inbox call
- **WHEN** an operator nudges a running task with "commit what you have"
- **THEN** the agent's next `inbox` call returns `{ kind: 'nudge', message: 'commit what you have' }` and the notice is not returned again

#### Scenario: Brief names the notices and allows rebasing
- **WHEN** a brief is composed
- **THEN** its workspace section names `stuck`, `nudge`, `baseMoved`, and `payloadChanged` and says the launch branch may be rebased onto the integration head

## ADDED Requirements

### Requirement: Worker access
A worker that holds a claimed launch SHALL use the same five operations with the launch token, either directly against the loopback API or through the token-scoped operator tools, and SHALL be subject to the same scoping, deduplication, sealing, and fencing rules as a spawned agent. The per-launch MCP façade SHALL NOT be spawned for a claimed launch. The fallback file SHALL NOT be available to workers: the orchestrator reads `.orchestrator/report.json` only when it finds a launch's process dead, and a claimed launch has no process, so a worker that cannot reach the API SHALL keep retrying until the daemon answers or its lease expires. The brief SHALL be the same document for spawned and claimed launches, and the worker instructions SHALL override its fallback-file guidance.

#### Scenario: Worker submits through the operator server
- **WHEN** a worker commits in the worktree and calls `launch_report` with kind `submit` and its token
- **THEN** the submission is sealed and the task is `submitted` exactly as for a spawned agent

#### Scenario: Fallback file is not read for a claimed launch
- **WHEN** a worker writes `.orchestrator/report.json` with a submit and stops calling the API
- **THEN** the lease expires, the task is `failed` with reason `leaseExpired`, and the file is swept with the worktree

#### Scenario: Worker fenced after release
- **WHEN** a launch is released and its former worker calls `launch_heartbeat` with the old token
- **THEN** the response is 401 and nothing changes
