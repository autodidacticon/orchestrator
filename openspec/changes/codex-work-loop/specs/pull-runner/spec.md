## MODIFIED Requirements

### Requirement: Claim
`POST /v1/claims` SHALL take `workerId`, an optional `taskId`, an optional `access`, and an optional `runner`: one runner kind or a list of the kinds the worker can run; a value outside the kinds SHALL be refused with 400. Without `taskId` it SHALL hand over the oldest claimable launch by creation time among those whose kind the filter names (any kind without a filter); with `taskId` it SHALL hand over that task's claimable launch, answering 404 when the task has no launch, 409 naming the launch state when its launch is not claimable, and 409 naming the launch's `runner` when its kind is outside the filter. When nothing is claimable for the filter, or the run is paused, it SHALL answer 404 with `paused` set accordingly, and a launch of another kind SHALL stay parked. A worker that already holds a launch SHALL get it back whatever its filter. On success the launch SHALL become `live` with `worker: { id, claimedAt }` and no pid, its lease SHALL be reset to expire `leaseTtlMs` after the claim, and the response SHALL be `{ launchId, taskId, token, worktree, briefPath, brief, baseSha, apiUrl, runner, commitPolicy, model, effort }`, where `brief` is the launch's `brief.json` content, `briefPath` the path of its `brief.md`, and `runner`, `commitPolicy`, `model`, and `effort` the values fixed when the launch was prepared. For a `codex` launch the response SHALL also carry `codex: { settings, maxWaitMs, retryWindowMs, env }`: the effective `runner.codex` keys, the long-poll ceiling, the retry window, and the agent environment a spawned launch would get, so that a worker loop composes the same `codex exec` command. The token of a claimable launch SHALL NOT authenticate until the claim is recorded. The work workflow's Claude Code workers SHALL claim with `runner: "claude-code"`, and the Codex work loop with `runner: "codex"`.

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
- **THEN** the response has `effort: "high"`, `model: "claude-opus-5-5"`, `runner: "claude-code"`, and `commitPolicy: "agent"`

#### Scenario: Codex claim carries the runner settings
- **WHEN** a worker claims a `codex` launch under the default `runner.codex` keys
- **THEN** the response has `runner: "codex"`, `commitPolicy: "daemon"`, and `codex.settings.sandbox: "workspace-write"`, and `codex.env` carries the launch's `ORCH_TOKEN` and `ORCH_COMMIT_POLICY: "daemon"`

#### Scenario: Filter skips other kinds
- **WHEN** T1's launch is parked for `claude-code` and T2's for `codex`, and a worker claims with `runner: "claude-code"`
- **THEN** it receives T1's launch; a second claim with `runner: "claude-code"` is 404 and T2's launch stays claimable

#### Scenario: Named task of another kind
- **WHEN** a worker claims T2 with `runner: "claude-code"` while T2's launch is parked for `codex`
- **THEN** the response is 409 with `runner: "codex"` and no launch changes

#### Scenario: No filter takes any kind
- **WHEN** T1's launch is parked for `codex` and then T2's for `claude-code`, and a worker claims without `runner`
- **THEN** it receives T1's launch, oldest first as before
