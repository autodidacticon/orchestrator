## MODIFIED Requirements

### Requirement: Operator interface
The orchestrator SHALL expose operator routes on its loopback HTTP server, and both a CLI and an MCP server SHALL speak to them. The operations SHALL be `status`, `answer`, `cancel` with optional release, `reopen` with optional cascade, `unblock`, `accept`, `reject`, `pause`, `resume` with optional budget override, `logs`, `events`, `review`, `import`, `shutdown`, `start` with optional mode, `stop`, `runs`, `outbox`, `ack`, `nudge`, `proposals`, `accept_proposal`, `reject_proposal`, `claim`, `release`, and `mode`. Humans and host sessions SHALL act only through this interface.

#### Scenario: CLI reaches the daemon
- **WHEN** `status` is run while the daemon is up
- **THEN** it prints the current report from the daemon

#### Scenario: MCP and CLI share one implementation
- **WHEN** the same operation is invoked through the CLI and through the MCP server
- **THEN** both produce the same event and the same effect

## ADDED Requirements

### Requirement: Claims and releases
The operator routes SHALL include `POST /v1/claims`, `POST /v1/launches/:id/release`, and `PUT /v1/runner` with `{ mode }`, with the semantics given in the pull-runner specification. Each SHALL be recorded as an event with its arguments before its effect. The CLI and the MCP server SHALL expose `claim`, `release`, and the mode override through these routes. A reaping shutdown SHALL NOT fail claimed launches: the daemon cannot terminate a worker, and the lease governs them.

#### Scenario: Claim is auditable
- **WHEN** a worker claims T1
- **THEN** the event log contains a `launch.claimed` event for T1 with the worker id, followed by the launch becoming live

#### Scenario: Mode override is durable
- **WHEN** `PUT /v1/runner` sets mode `pull` and the daemon restarts
- **THEN** the mode is still `pull`

#### Scenario: Reap leaves workers alone
- **WHEN** the daemon is stopped with reap while a worker holds a launch
- **THEN** the launch stays live, its task stays `running`, and the worker's next call succeeds after the daemon restarts

### Requirement: Status report: workers
`status` SHALL additionally report `runner` with the effective `mode` and `claimWindowMs`, `claimable` as the ids of tasks whose launch is claimable in claim order, and `workers` as `[{ id, launchId, taskId, claimedAt }]` for every live launch held by a worker. The `events` digest SHALL additionally include `claimable`, the number of claimable launches.

#### Scenario: Parked and claimed launches are visible
- **WHEN** T1 is parked and T2 is held by worker `w1`
- **THEN** `status` shows `claimable: [T1]` and `workers` containing `w1` with T2's launch, and the digest shows `claimable: 1`
