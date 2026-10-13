## ADDED Requirements

### Requirement: Worker tools
The server SHALL additionally expose `claim` with `{ workerId, taskId?, access? }`, `release` with `{ launchId, reason }`, and the token-scoped tools `launch_heartbeat`, `launch_report`, `launch_block`, `launch_inbox`, and `launch_log`, each taking `{ launchId, token, ...body }` and forwarding to the agent API route of the same name with the token as the bearer, so that a session subagent, which cannot run the per-agent MCP shim, can act as the agent. `launch_block` SHALL stay a foreground call: it SHALL return the daemon's response when it arrives within at most ninety seconds and otherwise `{ pending: true, seq }`; the worker SHALL call it again with the same seq, and the daemon's replay rules SHALL return the answer once admitted. `start` SHALL accept an optional `mode` of `spawn`, `pull`, or `mixed` and apply it to the run whether or not it spawned the daemon.

#### Scenario: Claim through the tool
- **WHEN** `claim` is called with worker id `w1` while T1 is parked
- **THEN** the result carries T1's launch id, token, worktree, brief path, brief, base sha, and API URL, and `status` lists `w1` under `workers`

#### Scenario: Block stays in the foreground
- **WHEN** `launch_block` is called with seq 1 and no answer arrives for two minutes
- **THEN** the call returns `{ pending: true }` within ninety seconds, and a second call with seq 1 after the operator answers returns `{ answer }`

#### Scenario: Start sets the mode on a running daemon
- **WHEN** `start` is called with mode `pull` while the daemon is already running in `spawn` mode
- **THEN** no second daemon is spawned and `status` reports mode `pull`
