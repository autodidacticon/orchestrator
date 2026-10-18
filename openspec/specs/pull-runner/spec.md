# Pull Runner Specification

## Purpose
How a prepared launch is executed: the runner modes under which the daemon spawns a headless agent for every launch (`spawn`), parks every launch as `claimable` for a worker on the same machine to claim (`pull`), or parks it for a claim window and spawns it when nobody claims it in time (`mixed`); the claim that hands a parked launch to a worker and makes it live without a pid, with its lease starting at the claim; the release that hands a launch back, returning the task to `unstarted` without spending an attempt when no progress was observed and failing the attempt otherwise; the worker identity that limits a worker to one live launch and makes a repeated claim idempotent, carrying any pending question and answer so that a fresh worker can resume where the last one stopped; the `mode` override that `start` applies to a run; and the access modes, of which `local` is implemented and `remote` is reserved.

## Requirements

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
`POST /v1/launches/:id/release` with a `reason` and an optional boolean `keep` SHALL apply to a live launch held by a worker and SHALL answer 409 for any other launch. When no progress has been observed since the claim, meaning no commit or dirty file in the worktree and no API call under the token, the launch SHALL end with reason `released`, the task SHALL return to `unstarted` without consuming an attempt, and the worktree SHALL be removed so that the next admission prepares a new launch. When progress has been observed and `keep` is false, the release SHALL be a failed attempt with reason `released` and the worker's reason as message. When progress has been observed and `keep` is true, the orchestrator SHALL commit any uncommitted changes in the worktree as a work-in-progress commit on the launch branch, SHALL end the launch with reason `released`, SHALL remove the worktree and keep the branch, SHALL return the task to `unstarted` with `attempts` unchanged, and SHALL store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason }` so that the next brief carries it; the response SHALL report `kept` true with the branch and head sha. A release while the task is `waiting` SHALL act as process death: the task becomes `blocked` with its question preserved, and with `keep` the same `interrupted` context SHALL be stored and the branch kept. The overlay entry SHALL carry `interruptions`, increased by one on every kept release after progress or while waiting, reset to zero when the task submits, carried in the `interrupted` context, and reported with each live launch in `status`. The configuration SHALL accept `daemon.maxKeptReleases`, default 3, where 0 means unlimited; a release with `keep` for a task whose `interruptions` already equals or exceeds it SHALL behave as a release without `keep`. Lease expiry on a claimed launch SHALL follow the existing failure path with reason `leaseExpired`.

#### Scenario: Release without progress
- **WHEN** a worker releases a launch it has not touched
- **THEN** the task is `unstarted`, `attempts` is unchanged, the worktree is gone, and the next tick prepares a new claimable launch with `launches` increased

#### Scenario: Release after progress
- **WHEN** a worker commits in the worktree and then releases with a reason
- **THEN** the task is `failed` with reason `released`, `attempts` increases, and the retry brief carries the worker's reason

#### Scenario: Release while waiting
- **WHEN** a worker releases a launch whose task is `waiting` on its question
- **THEN** the task is `blocked` with the question preserved and the launch has ended

#### Scenario: Kept release after progress
- **WHEN** a worker commits once, leaves a modified file uncommitted, and releases with `keep` true
- **THEN** the branch holds the commit and a work-in-progress commit of the modified file, the worktree is gone, the task is `unstarted` with `attempts` unchanged, and the next claim's brief carries `interrupted` with that branch and head

#### Scenario: Kept release without progress
- **WHEN** a worker releases an untouched launch with `keep` true
- **THEN** the outcome is the same as a release without progress and no `interrupted` context is stored

#### Scenario: Kept release while waiting
- **WHEN** a worker releases a `waiting` launch with `keep` true after committing
- **THEN** the task is `blocked` with its question, the branch is kept, and the brief after `answer` carries both the answer and `interrupted`

#### Scenario: Interruptions bounded
- **WHEN** `daemon.maxKeptReleases` is 2 and T2, which has not submitted, is released with `keep` after progress for the third time
- **THEN** T2 is `failed` with reason `released`, `attempts` increases, and `interruptions` stays at 2

### Requirement: Access modes
`access` SHALL be `local` or `remote` and SHALL default to `local`. `local` means the worker runs on the daemon's machine, reaches the loopback API, and works in the worktree the daemon prepared. `remote` SHALL be answered 501 naming it as reserved, so that a later change can implement it without changing the request shape.

#### Scenario: Local is the default
- **WHEN** a claim omits `access`
- **THEN** it is treated as `local`

#### Scenario: Remote is reserved
- **WHEN** a worker claims with `access: 'remote'`
- **THEN** the response is 501 naming `remote` as reserved and no launch changes

### Requirement: Session attachments
A claim MAY carry `attachment`, the id of a registered session attachment, which SHALL be stored on the launch's worker record as `worker.attachment`. When an attachment ends, by its own end request, by the first pid of its chain being found dead at reconcile, or by a session end naming any pid in its chain, every live claimed launch whose worker carries it SHALL be released with `keep` and reason `sessionEnded` at the next reconcile. A claim without an attachment SHALL be governed by its lease alone, as before. A kept release SHALL end the launch, so the former worker's token SHALL no longer authenticate.

#### Scenario: Worker dies with its session
- **WHEN** a worker claimed T2 through attachment A, committed twice, and A's process dies
- **THEN** the next reconcile ends T2's launch with reason `released`, T2 is `unstarted` with `attempts` unchanged and `carry.interrupted` naming the branch, and a call with the old token answers 401

#### Scenario: Lease still governs an unattached claim
- **WHEN** a worker claims without an attachment and stops calling for longer than the lease TTL
- **THEN** the task is `failed` with reason `leaseExpired` as before

### Requirement: Worker usage
A claimed launch has no process for the daemon to observe and no log for a runner to read, so its worker SHALL be able to post the launch's usage after its agent exits: `POST /v1/launches/:id/usage` with `{ workerId, usage: { tokens, model?, costUsd? } }`, where `tokens` is `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }` of non-negative integers and `costUsd` is non-negative. The route SHALL be identified by the body like `/v1/claims` and the release route and SHALL NOT need the launch token, because by the time the worker has the usage the task is `submitted` and the launch may have ended. The daemon SHALL accept the post only for a launch that has a `worker` whose id equals `workerId`, has no pid, and is `live` or `ended`. Any other launch, including any launch with a pid, SHALL be refused with 409 and nothing recorded. A spawned launch's usage comes only from its runner. A malformed body SHALL be refused with 400. When the launch already has usage, the post SHALL be a no-op answered 200 with `recorded: false`. Otherwise the daemon SHALL store the usage with `source: 'worker'` as health-monitoring "Usage accounting" states, pricing tokens without a cost with the posted `model` or else the launch's model, and SHALL answer 200 with `recorded: true` and the cost when known. Self-reported usage is not authoritative; its provenance keeps it distinguishable.

#### Scenario: Worker posts usage after submit
- **WHEN** worker `w1` claims T1, submits, the launch ends with no usage, and `w1` posts `tokens: { input: 40361, output: 260 }`
- **THEN** the launch row records the tokens with `usageSource` `worker`, and one `launch.usage` with `source: 'worker'` is appended

#### Scenario: Second post is a no-op
- **WHEN** `w1` posts usage again for the same launch
- **THEN** the answer is 200 with `recorded: false`, the row is unchanged, and no `launch.usage` is appended

#### Scenario: Another worker or a spawned launch is refused
- **WHEN** `w2` posts usage for `w1`'s launch, or any worker posts usage for a launch with a pid
- **THEN** the answer is 409 and no usage is recorded

#### Scenario: Posted tokens are priced
- **WHEN** `budgets.prices` has the launch's model at 100 USD input and 1000 USD output per million tokens and `w1` posts 40361 input and 260 output tokens with no cost
- **THEN** the row records `costUsd` 4.2961 with `costSource` `priced`, and `status.cost.runUsd` includes it
