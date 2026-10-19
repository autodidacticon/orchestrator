## MODIFIED Requirements

### Requirement: Claim
`POST /v1/claims` SHALL take `workerId`, an optional `taskId`, an optional `access`, and an optional `runner`: one runner kind or a list of the kinds the worker can run; a value outside the kinds SHALL be refused with 400. Without `taskId` it SHALL hand over the oldest claimable launch by creation time among those whose kind the filter names (any kind without a filter); with `taskId` it SHALL hand over that task's claimable launch, answering 404 when the task has no launch, 409 naming the launch state when its launch is not claimable, and 409 naming the launch's `runner` when its kind is outside the filter. When nothing is claimable for the filter, or the run is paused, it SHALL answer 404 with `paused` set accordingly, and a launch of another kind SHALL stay parked. A worker that already holds a launch SHALL get it back whatever its filter. On success the launch SHALL become `live` with `worker: { id, claimedAt }` and no pid, its lease SHALL be reset to expire `leaseTtlMs` after the claim, and the response SHALL be `{ launchId, taskId, token, worktree, briefPath, brief, baseSha, apiUrl, runner, commitPolicy, model, effort }`, where `brief` is the launch's `brief.json` content, `briefPath` the path of its `brief.md`, and `runner`, `commitPolicy`, `model`, and `effort` the values fixed when the launch was prepared. For a `codex` launch the response SHALL also carry `codex: { settings, maxWaitMs, retryWindowMs, env }`: the effective `runner.codex` keys, the long-poll ceiling, the retry window, and the agent environment a spawned launch would get, so that a worker loop composes the same `codex exec` command. For an `opencode` launch the response SHALL carry `opencode: { settings, allowedTools, maxWaitMs, retryWindowMs, env }` instead: the effective `runner.opencode` keys, the rules the OpenCode runner derives its permission ruleset from (the composed allow list, else the detected toolchain and the claude file rules, the same list the runner is given), the long-poll ceiling, the retry window, and the agent environment, so that a worker loop composes the same `opencode run` command and per-launch config, including the derived permission ruleset. A launch of one kind SHALL NOT carry another kind's block. The token of a claimable launch SHALL NOT authenticate until the claim is recorded. The work workflow's Claude Code workers SHALL claim with `runner: "claude-code"`, and the work loop with `runner: "codex"` or `runner: "opencode"`, the kind it was started for.

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

#### Scenario: OpenCode claim carries the runner settings
- **WHEN** a worker claims an `opencode` launch under `runner.opencode.permission: allow` and `dataDir: launch`
- **THEN** the response has `runner: "opencode"`, `commitPolicy: "agent"`, no `codex` block, `opencode.settings` with that permission and data dir, `opencode.allowedTools` equal to the list the OpenCode runner is given, `opencode.maxWaitMs` and `opencode.retryWindowMs` from the daemon's configuration, and `opencode.env` carrying the launch's `ORCH_TOKEN` and `ORCH_API`

#### Scenario: Filter skips other kinds
- **WHEN** T1's launch is parked for `claude-code` and T2's for `codex`, and a worker claims with `runner: "claude-code"`
- **THEN** it receives T1's launch; a second claim with `runner: "claude-code"` is 404 and T2's launch stays claimable

#### Scenario: Named task of another kind
- **WHEN** a worker claims T2 with `runner: "claude-code"` while T2's launch is parked for `codex`
- **THEN** the response is 409 with `runner: "codex"` and no launch changes

#### Scenario: Null filter refused
- **WHEN** a worker claims with `runner: null` or `runner: []`
- **THEN** the response is 400 naming the kinds, because only an absent `runner` means any kind

#### Scenario: No filter takes any kind
- **WHEN** T1's launch is parked for `codex` and then T2's for `claude-code`, and a worker claims without `runner`
- **THEN** it receives T1's launch, oldest first as before

### Requirement: Worker usage
A claimed launch has no process for the daemon to observe and no log for a runner to read, so its worker SHALL be able to post the launch's usage after its agent exits: `POST /v1/launches/:id/usage` with `{ workerId, usage: { tokens, model?, costUsd? } }`, where `tokens` is `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }` of non-negative integers and `costUsd` is non-negative. The route SHALL be identified by the body like `/v1/claims` and the release route and SHALL NOT need the launch token, because by the time the worker has the usage the task is `submitted` and the launch may have ended. The daemon SHALL accept the post only for a launch that has a `worker` whose id equals `workerId`, has no pid, and is `live` or `ended`. Any other launch, including any launch with a pid, SHALL be refused with 409 and nothing recorded. A spawned launch's usage comes only from its runner. A malformed body SHALL be refused with 400. When the launch already has usage, the post SHALL be a no-op answered 200 with `recorded: false`. Otherwise the daemon SHALL store the usage with `source: 'worker'` as health-monitoring "Usage accounting" states, pricing tokens without a cost with the posted `model` or else the launch's model, and SHALL answer 200 with `recorded: true` and the cost when known. Self-reported usage is not authoritative; its provenance keeps it distinguishable.

#### Scenario: Worker posts usage after submit
- **WHEN** worker `w1` claims T1, submits, the launch ends with no usage, and `w1` posts `tokens: { input: 40361, output: 260 }`
- **THEN** the launch row records the tokens with `usageSource` `worker`, and one `launch.usage` with `source: 'worker'` is appended

#### Scenario: OpenCode worker posts usage
- **WHEN** worker `oc-1` holds an `opencode` launch, its `opencode run` prints one `step_finish` with `tokens: { input: 14534, output: 11, reasoning: 19 }`, and the work loop posts the sum `parseOpenCodeUsage` gives, with the summed `cost` as `costUsd` when it is above zero
- **THEN** the launch row records input 14534 with `usageSource` `worker`, and the launch has no pid

#### Scenario: Second post is a no-op
- **WHEN** `w1` posts usage again for the same launch
- **THEN** the answer is 200 with `recorded: false`, the row is unchanged, and no `launch.usage` is appended

#### Scenario: Another worker or a spawned launch is refused
- **WHEN** `w2` posts usage for `w1`'s launch, or any worker posts usage for a launch with a pid
- **THEN** the answer is 409 and no usage is recorded

#### Scenario: Posted tokens are priced
- **WHEN** `budgets.prices` has the launch's model at 100 USD input and 1000 USD output per million tokens and `w1` posts 40361 input and 260 output tokens with no cost
- **THEN** the row records `costUsd` 4.2961 with `costSource` `priced`, and `status.cost.runUsd` includes it
