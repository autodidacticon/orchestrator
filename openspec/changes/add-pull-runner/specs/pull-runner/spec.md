## ADDED Requirements

### Requirement: Runner modes
The configuration SHALL accept `runner.mode` with values `spawn`, `pull`, and `mixed`, defaulting to `spawn`, and `runner.claimWindowMs`, defaulting to 60000. Every launch prepared in `pull` or `mixed` mode SHALL be parked as `claimable` once its worktree and brief exist; in `spawn` mode the launch SHALL be spawned immediately as before. A parked launch SHALL have a claim window: unbounded in `pull`, `runner.claimWindowMs` from the moment it became claimable in `mixed`, and zero in `spawn`. On each tick the orchestrator SHALL spawn every parked launch whose window has elapsed. `start` with a `mode` argument SHALL override the configured mode for the run, passed to the daemon it spawns or set through the `runner` route on a daemon already running; the override SHALL be stored durably and SHALL apply from the next tick, including to launches already parked. While the run is paused, parked launches SHALL stay parked: they SHALL NOT be spawned and SHALL NOT be claimed.

#### Scenario: Pull parks and never spawns
- **WHEN** the mode is `pull` and a ready task is admitted
- **THEN** its launch becomes `claimable` with a worktree and brief, no process is spawned, and it is still `claimable` after any amount of time

#### Scenario: Mixed spawns after the window
- **WHEN** the mode is `mixed` with a 2 s window and nobody claims the launch within 2 s
- **THEN** the next tick spawns it and records a pid, and the launch is `live` without a worker

#### Scenario: Spawn is unchanged
- **WHEN** the mode is `spawn`
- **THEN** no launch is ever `claimable` and the launch records pass through `preparing`, `launching`, and `live` as before

#### Scenario: Mode switch drains parked launches
- **WHEN** two launches are parked in `pull` mode and `start` is called with mode `spawn`
- **THEN** both are spawned on the next tick

### Requirement: Claim
`POST /v1/claims` SHALL take `workerId`, an optional `taskId`, and an optional `access`. Without `taskId` it SHALL hand over the oldest claimable launch by creation time; with `taskId` it SHALL hand over that task's claimable launch, answering 404 when the task has no launch and 409 naming the launch state when its launch is not claimable. When nothing is claimable, or the run is paused, it SHALL answer 404 with `paused` set accordingly. On success the launch SHALL become `live` with `worker: { id, claimedAt }` and no pid, its lease SHALL be reset to expire `leaseTtlMs` after the claim, and the response SHALL be `{ launchId, taskId, token, worktree, briefPath, brief, baseSha, apiUrl }`, where `brief` is the launch's `brief.json` content and `briefPath` the path of its `brief.md`. The token of a claimable launch SHALL NOT authenticate until the claim is recorded.

#### Scenario: Oldest first
- **WHEN** T1 and then T2 were parked and a worker claims without a task id
- **THEN** it receives T1's launch, and a second worker receives T2's

#### Scenario: Named task not claimable
- **WHEN** a worker claims T3 while T3's launch is live with a pid
- **THEN** the response is 409 naming `live` and no launch changes

#### Scenario: Nothing claimable
- **WHEN** a worker claims while no launch is claimable
- **THEN** the response is 404 and no launch changes

#### Scenario: Claim makes the launch live
- **WHEN** a worker claims T1's parked launch
- **THEN** the launch is `live` with the worker id and no pid, its lease expires `leaseTtlMs` later, and the token now authenticates

### Requirement: Worker identity
`workerId` SHALL be an opaque string chosen by the worker and unique within a run. A worker SHALL hold at most one live launch. A claim by a worker that already holds a live launch SHALL return that launch again with the same token when `taskId` is absent or matches, and 409 otherwise. The repeated response SHALL also carry `pending: { seq, question, answer? }` when the launch has an open question or an admitted answer, so that a fresh worker can collect the answer with `block` and the same seq. `status` SHALL list every worker with its launch.

#### Scenario: Idempotent re-claim
- **WHEN** a worker claims, the response is lost, and it claims again with the same worker id
- **THEN** it receives the same launch id and token, and the lease and worker record are unchanged

#### Scenario: Re-claim carries the answer
- **WHEN** a worker blocked with seq 2, its agent died, the operator answered, and a worker with the same id claims again
- **THEN** the response carries `pending` with seq 2 and the answer, and `block` with seq 2 returns the answer once admitted

#### Scenario: One launch per worker
- **WHEN** a worker holding T1's launch claims T2 by name
- **THEN** the response is 409 naming T1's launch

### Requirement: Release
`POST /v1/launches/:id/release` with a `reason` SHALL apply to a live launch held by a worker and SHALL answer 409 for any other launch. When no progress has been observed since the claim, meaning no commit or dirty file in the worktree and no API call under the token, the launch SHALL end with reason `released`, the task SHALL return to `unstarted` without consuming an attempt, and the worktree SHALL be removed so that the next admission prepares a new launch. When progress has been observed, the release SHALL be a failed attempt with reason `released` and the worker's reason as message. A release while the task is `waiting` SHALL act as process death: the task becomes `blocked` with its question preserved. Lease expiry on a claimed launch SHALL follow the existing failure path with reason `leaseExpired`.

#### Scenario: Release without progress
- **WHEN** a worker releases a launch it has not touched
- **THEN** the task is `unstarted`, `attempts` is unchanged, the worktree is gone, and the next tick prepares a new claimable launch with `launches` increased

#### Scenario: Release after progress
- **WHEN** a worker commits in the worktree and then releases with a reason
- **THEN** the task is `failed` with reason `released`, `attempts` increases, and the retry brief carries the worker's reason

#### Scenario: Release while waiting
- **WHEN** a worker releases a launch whose task is `waiting` on its question
- **THEN** the task is `blocked` with the question preserved and the launch has ended

### Requirement: Access modes
`access` SHALL be `local` or `remote` and SHALL default to `local`. `local` means the worker runs on the daemon's machine, reaches the loopback API, and works in the worktree the daemon prepared. `remote` SHALL be answered 501 naming it as reserved, so that a later change can implement it without changing the request shape.

#### Scenario: Local is the default
- **WHEN** a claim omits `access`
- **THEN** it is treated as `local`

#### Scenario: Remote is reserved
- **WHEN** a worker claims with `access: 'remote'`
- **THEN** the response is 501 naming `remote` as reserved and no launch changes
