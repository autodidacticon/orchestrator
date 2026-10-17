## MODIFIED Requirements

### Requirement: Claim
`POST /v1/claims` SHALL take `workerId`, an optional `taskId`, and an optional `access`. Without `taskId` it SHALL hand over the oldest claimable launch by creation time; with `taskId` it SHALL hand over that task's claimable launch, answering 404 when the task has no launch and 409 naming the launch state when its launch is not claimable. When nothing is claimable, or the run is paused, it SHALL answer 404 with `paused` set accordingly. On success the launch SHALL become `live` with `worker: { id, claimedAt }` and no pid, its lease SHALL be reset to expire `leaseTtlMs` after the claim, and the response SHALL be `{ launchId, taskId, token, worktree, briefPath, brief, baseSha, apiUrl, model, effort }`, where `brief` is the launch's `brief.json` content, `briefPath` the path of its `brief.md`, and `model` and `effort` the values fixed when the launch was prepared. The token of a claimable launch SHALL NOT authenticate until the claim is recorded.

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

#### Scenario: Claim carries the selection
- **WHEN** a worker claims the launch of a task that declares `effort: high` under the run default model
- **THEN** the response has `effort: "high"` and `model: "claude-opus-5-5"`
