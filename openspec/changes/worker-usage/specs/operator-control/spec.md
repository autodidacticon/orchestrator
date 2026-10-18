## MODIFIED Requirements

### Requirement: Claims and releases
The operator routes SHALL include `POST /v1/claims`, `POST /v1/launches/:id/release`, `POST /v1/launches/:id/usage`, and `PUT /v1/runner` with `{ mode }`, with the semantics given in the pull-runner specification; a claim body MAY carry `attachment` and a release body MAY carry `keep`. Each SHALL be recorded as an event with its arguments before its effect; a usage post SHALL be recorded as `operator.usage`. The CLI and the MCP server SHALL expose `claim`, `release` (with `--keep` on the CLI and `keep` on the tool), and the mode override through these routes; the usage route is for worker loops and SHALL be reachable over HTTP. A reaping shutdown SHALL NOT fail claimed launches: the daemon cannot terminate a worker, and the lease governs them.

#### Scenario: Claim is auditable
- **WHEN** a worker claims T1
- **THEN** the event log contains a `launch.claimed` event for T1 with the worker id, followed by the launch becoming live

#### Scenario: Mode override is durable
- **WHEN** `PUT /v1/runner` sets mode `pull` and the daemon restarts
- **THEN** the mode is still `pull`

#### Scenario: Reap leaves workers alone
- **WHEN** the daemon is stopped with reap while a worker holds a launch
- **THEN** the launch stays live, its task stays `running`, and the worker's next call succeeds after the daemon restarts

#### Scenario: Kept release through the CLI
- **WHEN** `orchestrator-ctl release <launchId> --keep --reason "session ending"` is run for a launch with commits
- **THEN** the `operator.release` event carries `keep` true and the task is `unstarted` with `attempts` unchanged

#### Scenario: Usage post is auditable
- **WHEN** a worker posts usage for its ended claimed launch
- **THEN** the event log contains `operator.usage` with the body, followed by `launch.usage` with `source: 'worker'`
