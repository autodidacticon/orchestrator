## MODIFIED Requirements

### Requirement: Leases
A `running` or `waiting` task SHALL hold a lease recording `launchId`, `token`, `claimedAt`, `spawnedAt`, `expiresAt`, `baseSha`, and `graphRev`. A heartbeat, any API call, and an open long-poll SHALL renew the lease. For a launch whose process the daemon can observe, the daemon SHALL also renew the lease on every tick while the runner reports the process alive, including the first tick after adoption, so that the lease TTL bounds silence only for launches the daemon cannot observe. The orchestrator SHALL treat an expired lease on a `running` task as failure with reason `leaseExpired`. Silence from a live process SHALL NOT fail the task; it is handled by stuck detection.

#### Scenario: Silent but alive agent keeps its lease
- **WHEN** a running agent with a recorded pid makes no API call for longer than the lease TTL while its process is alive
- **THEN** its lease is renewed each tick, the task stays `running`, and `attempts` is unchanged

#### Scenario: Silence past the TTL fails an unobserved launch
- **WHEN** the runner reports `unknown` liveness for a running launch and no API call arrives for longer than the lease TTL
- **THEN** the task becomes `failed` with reason `leaseExpired`, `attempts` increases, and any process the runner can reach is reaped

#### Scenario: Long-poll keeps the lease alive
- **WHEN** an agent is parked in `block` with the connection open
- **THEN** its lease does not expire while the connection stays open

#### Scenario: Outage longer than the TTL
- **WHEN** the daemon is down for longer than the lease TTL while an agent process survives, then restarts
- **THEN** the launch is adopted, its lease is renewed before any expiry check, and the task stays `running`

## ADDED Requirements

### Requirement: Health failure reasons
A `running` task SHALL become `failed` with reason `stuck` when stuck detection escalates and with reason `timeBudget` when its launch exceeds the launch time budget. Both SHALL use the orchestrator's `running -> failed` transition, SHALL increase `attempts`, and SHALL follow the retry and exhaustion rules like any other failure, so the next brief carries the reason as the prior failure.

#### Scenario: Stuck failure spends an attempt and retries with context
- **WHEN** a task on its first attempt is failed with reason `stuck` and `maxAttempts` is 2
- **THEN** `attempts` is one, the task returns to `unstarted`, and its next brief names `stuck` as the prior failure

#### Scenario: Time budget failure exhausts
- **WHEN** a task on its last attempt is failed with reason `timeBudget`
- **THEN** it becomes `blocked` and appears in `stallRoots` with that reason
