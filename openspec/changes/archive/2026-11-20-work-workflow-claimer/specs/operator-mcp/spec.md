## MODIFIED Requirements

### Requirement: Worker tools
The server SHALL additionally expose `claim` with `{ workerId, taskId?, access?, runner?, brief? }`, forwarding its attachment in the body, `release` with `{ launchId, reason, keep? }`, and the token-scoped tools `launch_heartbeat`, `launch_report`, `launch_block`, `launch_inbox`, and `launch_log`. With `brief: false`, `claim` SHALL remove `brief` from the daemon's answer and keep every other field; without it, or with `true`, the answer SHALL be the daemon's, unchanged.

#### Scenario: Claim through the tool
- **WHEN** `claim` is called with worker id `w1` while T1 is parked
- **THEN** the result carries T1's launch id, token, worktree, brief path, brief, base sha, and API URL, `status` lists `w1` under `workers`, and the launch's worker record carries the server's attachment

#### Scenario: Claim without the brief
- **WHEN** `claim` is called with worker id `w1` and `brief: false` while T1 is parked
- **THEN** the result carries T1's launch id, token, worktree, `briefPath`, model, effort and lease, and has no `brief` field, and a second `claim` by `w1` without the option answers the same launch with `repeated: true` and `brief.acceptanceCriteria`

#### Scenario: Block stays in the foreground
- **WHEN** `launch_block` is called with seq 1 and no answer arrives for two minutes
- **THEN** the call returns `{ pending: true }` within ninety seconds, and a second call with seq 1 after the operator answers returns `{ answer }`

#### Scenario: Start sets the mode on a running daemon
- **WHEN** `start` is called with mode `pull` while the daemon is already running in `spawn` mode
- **THEN** no second daemon is spawned and `status` reports mode `pull`

#### Scenario: Release with keep through the tool
- **WHEN** `release` is called with `keep` true for a launch with commits
- **THEN** the route receives `keep` true and the result reports `kept` true with the branch and head sha
