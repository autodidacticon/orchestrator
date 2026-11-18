## MODIFIED Requirements

### Requirement: Claim
`POST /v1/claims` SHALL take `workerId`, an optional `taskId`, an optional `access`, and an optional `runner`: one runner kind or a list of the kinds the worker can run; a value outside the kinds SHALL be refused with 400. Without `taskId` it SHALL hand over the oldest claimable launch by creation time among those whose kind the filter names (any kind without a filter); with `taskId` it SHALL hand over that task's claimable launch, answering 404 when the task has no launch, 409 naming the launch state when its launch is not claimable, and 409 naming the launch's `runner` when its kind is outside the filter. When nothing is claimable for the filter, or the run is paused, it SHALL answer 404 with `paused` set accordingly, and a launch of another kind SHALL stay parked. A worker that already holds a launch SHALL get it back whatever its filter. On success the launch SHALL become `live` with `worker: { id, claimedAt }` and no pid, its lease SHALL be reset to expire `leaseTtlMs` after the claim, and the response SHALL be `{ launchId, taskId, token, worktree, briefPath, brief, baseSha, apiUrl, runner, commitPolicy, model, effort }`, where `brief` is the launch's `brief.json` content, `briefPath` the path of its `brief.md`, and `runner`, `commitPolicy`, `model`, and `effort` the values fixed when the launch was prepared. For a `codex` launch the response SHALL also carry `codex: { settings, maxWaitMs, retryWindowMs, env }`: the effective `runner.codex` keys, the long-poll ceiling, the retry window, and the agent environment a spawned launch would get, so that a worker loop composes the same `codex exec` command. For an `opencode` launch the response SHALL carry `opencode: { settings, allowedTools, maxWaitMs, retryWindowMs, env }` instead: the effective `runner.opencode` keys, the rules the OpenCode runner derives its permission ruleset from (the composed allow list, else the detected toolchain and the claude file rules, the same list the runner is given), the long-poll ceiling, the retry window, and the agent environment, so that a worker loop composes the same `opencode run` command and per-launch config, including the derived permission ruleset. A launch of one kind SHALL NOT carry another kind's block. The token of a claimable launch SHALL NOT authenticate until the claim is recorded. For a launch with `access: remote` the response SHALL carry every field of the local response except `worktree` and `briefPath`, plus `access: "remote"`, `repoUrl`, `integrationBranch`, and `briefMarkdown`: `repoUrl` is `git.workerOriginUrl` when set, else `git.originUrl`, else the URL of the daemon clone's `origin` remote, passed through as written (user information included); `brief` is the launch row's stored `briefJson` and `briefMarkdown` its stored brief text, neither read from disk. When the stored brief's context holds `interrupted` (a kept release), the remote response SHALL carry it as `carry`, so that the worker starts its branch at `carry.interrupted.headSha`. A repeated claim of a remote launch SHALL answer the same body with `repeated: true`. A remote claim SHALL record no baseline `fingerprint` on the launch and SHALL NOT read the workspace fingerprint. `git.workerOriginUrl` is a config-file key read at start; it SHALL NOT change the meaning of `git.originUrl`, which stays the URL of the daemon clone's `origin` and the input of the run id. The local response SHALL be unchanged. The work workflow's Claude Code workers SHALL claim with `runner: "claude-code"`, and the work loop with `runner: "codex"` or `runner: "opencode"`, the kind it was started for.

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

#### Scenario: Remote claim response
- **WHEN** a remote worker claims T1's parked launch on a run with `runner.access: remote`
- **THEN** the response is 200 with `access: "remote"`, `launchId`, `taskId`, `token`, `branch`, `baseSha`, `repoUrl`, `integrationBranch`, `brief` equal to the stored `briefJson`, `briefMarkdown` equal to the stored text, `apiUrl`, `workerId`, and `leaseTtlMs`, and it has no `worktree` and no `briefPath`

#### Scenario: Repository URL for a remote worker
- **WHEN** a remote claim is answered
- **THEN** `repoUrl` is `git.workerOriginUrl` when set, `git.originUrl` when only that is set, and the clone's `origin` URL when neither is

#### Scenario: Remote claim after a kept release
- **WHEN** a remote worker claims the launch of a task whose carry holds `interrupted` with `headSha` and `priorBranch`
- **THEN** the response carries `carry.interrupted.headSha` and `carry.interrupted.priorBranch`, and a repeated claim carries them too

#### Scenario: Remote claim records no fingerprint
- **WHEN** a remote worker claims a launch
- **THEN** the launch has no `fingerprint` and the workspace fingerprint is not read

#### Scenario: Remote worker clones the repository URL
- **WHEN** a remote worker on a run with `git.pushIntegration: true` runs `git clone <repoUrl>`
- **THEN** the clone succeeds and `origin/<integrationBranch>` in it equals the claim's `baseSha`
