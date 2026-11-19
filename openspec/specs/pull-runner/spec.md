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
`POST /v1/launches/:id/release` with a `reason` and an optional boolean `keep` SHALL apply to a live launch held by a worker and SHALL answer 409 for any other launch. When no progress has been observed since the claim, meaning no commit or dirty file in the worktree and no API call under the token, the launch SHALL end with reason `released`, the task SHALL return to `unstarted` without consuming an attempt, and the worktree SHALL be removed so that the next admission prepares a new launch. When progress has been observed and `keep` is false, the release SHALL be a failed attempt with reason `released` and the worker's reason as message. When progress has been observed and `keep` is true, the orchestrator SHALL commit any uncommitted changes in the worktree as a work-in-progress commit on the launch branch, SHALL end the launch with reason `released`, SHALL remove the worktree and keep the branch, SHALL return the task to `unstarted` with `attempts` unchanged, and SHALL store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason }` so that the next brief carries it; the response SHALL report `kept` true with the branch and head sha. A release while the task is `waiting` SHALL act as process death: the task becomes `blocked` with its question preserved, and with `keep` the same `interrupted` context SHALL be stored and the branch kept. The overlay entry SHALL carry `interruptions`, increased by one on every kept release after progress or while waiting, reset to zero when the task submits, carried in the `interrupted` context, and reported with each live launch in `status`. The configuration SHALL accept `daemon.maxKeptReleases`, default 3, where 0 means unlimited; a release with `keep` for a task whose `interruptions` already equals or exceeds it SHALL behave as a release without `keep`. Lease expiry on a claimed launch SHALL follow "Lease expiry": a kept release when the worktree shows progress since the claim and the bound allows, a failed attempt with reason `leaseExpired` otherwise. A remote launch (`access: remote`) has no worktree on the daemon's host: the release body MAY carry `headSha`, the launch branch tip the worker pushed, and `wipCommit`, its work-in-progress commit, each a full hex object name (a malformed one SHALL be answered 400 naming the field, and a local release SHALL ignore both). For a remote launch, progress SHALL be any agent API call since the claim or a `headSha` that differs from the base sha, and the orchestrator SHALL NOT fingerprint, preserve or remove anything. A kept remote release SHALL fetch the launch branch from origin and require its tip to equal `headSha`: no branch on origin SHALL answer 409 `branchNotPushed`, another tip 409 `shaMismatch`, and an origin that cannot be fetched 503 `originUnreachable` or `originRefused`; on any of these the task and the launch SHALL be unchanged, the launch SHALL stay live, and no `launch.released` event SHALL be appended. A remote release with `keep` but no `headSha` cannot be kept and SHALL behave as a release without `keep`, with `keepError` naming `headSha`. Otherwise a kept remote release SHALL store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason, interruptions }` as a local one does, under the same `daemon.maxKeptReleases` bound, and its `launch.released` event SHALL carry `headSha`.

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

#### Scenario: Remote kept release
- **WHEN** a remote worker commits, pushes the launch branch and releases with `keep` true and `headSha` equal to the pushed tip
- **THEN** the answer has `kept: true`, the task is `unstarted` with `attempts` unchanged, `carry.interrupted.headSha` is the tip, the next remote claim carries it, and no fingerprint, preserve or worktree removal was made

#### Scenario: Remote keep with another tip
- **WHEN** a remote worker releases with `keep` and a `headSha` that is not the launch branch tip at origin, or the branch is not on origin
- **THEN** the answer is 409 with `shaMismatch` or `branchNotPushed` and the launch stays `live`

#### Scenario: Remote keep without progress
- **WHEN** a remote worker that made no API call since the claim releases with `keep` and `headSha` equal to the base sha
- **THEN** the answer has `kept: false` and the task is `unstarted` with `attempts` unchanged, as for a local release without progress

#### Scenario: Remote keeps are bounded
- **WHEN** a remote task's `interruptions` has reached `daemon.maxKeptReleases` and its worker releases with `keep` after pushing
- **THEN** the answer has `kept: false` and `keepError` naming the bound

### Requirement: Access modes
A run SHALL have one access, the file key `runner.access`, `local` or `remote`, default `local`, read at start; it SHALL NOT be a runtime override. `local` means the worker runs on the daemon's machine, reaches the loopback API, and works in the worktree the daemon prepared. `remote` means the worker runs elsewhere and gets no worktree from the daemon (see specs/remote-workspace). Any other value SHALL fail configuration loading with a message naming `runner.access`. The daemon SHALL refuse to start with `runner.access: remote` unless the runner mode in force is `pull`, `git.pushIntegration` is true, and `prepareCommand` is unset, with one message naming each unmet condition; on a remote run `PUT /v1/runner` SHALL refuse any mode other than `pull` with 409. Every launch row SHALL carry the run's access in `access`, set when the row is created and never changed; a row without it is `local`. A claim's `access` SHALL be `local` or `remote` and SHALL default to `local`; any other value SHALL be answered 400. A claim whose `access` differs from the run's SHALL be answered 409 with `reason`, `access` and `runAccess`, and SHALL change no launch.

#### Scenario: Local is the default
- **WHEN** a claim omits `access`
- **THEN** it is treated as `local`

#### Scenario: Remote worker on a local run
- **WHEN** a worker claims with `access: 'remote'` on a run whose `runner.access` is `local`
- **THEN** the response is 409 with `access: 'remote'` and `runAccess: 'local'`, and the claimable launch stays `claimable`

#### Scenario: Local worker on a remote run
- **WHEN** a worker claims with `access: 'local'`, or without `access`, on a run whose `runner.access` is `remote`
- **THEN** the response is 409 with `access: 'local'` and `runAccess: 'remote'`, and the claimable launch stays `claimable` with no worker

#### Scenario: Remote run in spawn mode refused
- **WHEN** the daemon starts with `runner.access: remote`, `runner.mode: spawn`, `git.pushIntegration: false` and `prepareCommand` set
- **THEN** startup fails with a message naming `runner.mode`, `git.pushIntegration` and `prepareCommand`, and no launch is created

#### Scenario: Launch rows carry the access
- **WHEN** a local run admits a task
- **THEN** its launch row has `access: 'local'` and a worktree path

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

### Requirement: Lease facts in the claim
The claim response, first and repeated, SHALL carry `leaseTtlMs`, `leaseExpiresAt` (the task's lease expiry when the response is made), and `lease: { ttlMs, expiresAt, renewEveryMs }`. `renewEveryMs` is a third of the TTL, rounded down: the longest a worker may go between calls. A repeated claim SHALL state the lease as it stands, not a fresh `now + leaseTtlMs`.

#### Scenario: First claim states the lease
- **WHEN** a worker claims a parked launch at time t under `leaseTtlMs: 60000`
- **THEN** the response has `leaseTtlMs: 60000`, `leaseExpiresAt: t + 60000`, and `lease: { ttlMs: 60000, expiresAt: t + 60000, renewEveryMs: 20000 }`

#### Scenario: Repeated claim states the current expiry
- **WHEN** the worker heartbeats 5 seconds after the claim and then claims again with the same worker id
- **THEN** the repeated response has `leaseExpiresAt: t + 5000 + 60000`

### Requirement: Lease renewal by the work loop
`POST /v1/launches/:id/renew` with `Authorization: Bearer <launch token>` SHALL set the lease of a live claimed launch to expire at `now + leaseTtlMs`, provided the task is `running` or `waiting` on that launch, and answer 200 with `{ ok, ttlMs, expiresAt, renewEveryMs }`. It SHALL answer 401 for a wrong token or an ended or revoked launch. It SHALL answer 409 for a launch with a pid or one that no longer holds its task.

#### Scenario: Renewal keeps a silent claim
- **WHEN** a claimed launch makes no call and changes nothing in its worktree for five TTLs while its loop renews every third of the TTL
- **THEN** the launch is still live, its task is `running` with `attempts` unchanged, and `launches` is 1

#### Scenario: Renewal stops
- **WHEN** the loop renews once and then stops
- **THEN** the lease expires no later than `leaseTtlMs` plus one tick after the last renewal, and a later renewal answers 401

#### Scenario: Renewal of a spawned launch
- **WHEN** the renew route is called for a launch the daemon spawned
- **THEN** it answers 409 and the lease is unchanged

### Requirement: Renewal is not progress
A renewal SHALL NOT be a progress signal. It SHALL leave `progressAt`, `lastSignal`, `progressText` and `stuckSince` unchanged, and SHALL append no event. A launch that only renews SHALL still be flagged stuck after `health.stuckAfterMs` and failed after `health.stuckFailAfterMs`.

#### Scenario: A launch that only renews goes stuck
- **WHEN** a claimed launch only renews for longer than `health.stuckAfterMs`
- **THEN** its `progressAt` is still the claim time, `lastSignal` is still `claimed`, a `launch.stuck` event is appended once, and `status.stuck` lists its task

### Requirement: Lease expiry
When a `running` claimed launch's lease expires, the orchestrator SHALL check the worktree for progress since the claim: a commit (head is not the base sha), a change to a tracked file, or a path the worker staged. An untracked file alone SHALL NOT be progress, and the work-in-progress commit of an expiry SHALL NOT include untracked files: a file is added to the kept commit only when the worker stages it. With progress and `interruptions` under `daemon.maxKeptReleases` (0: unlimited), the expiry SHALL be a kept release: the branch is kept with uncommitted tracked and staged work committed on it, the task is `unstarted` with `attempts` unchanged, and `carry.interrupted` has `reason: "leaseExpired"`. When the work-in-progress commit fails (another process holds the index lock, say), the orchestrator SHALL read the worktree head instead: a head that is not the base sha SHALL still make the expiry a kept release at that head, without `wipCommit`; a head at the base sha SHALL make it a failed attempt. A release with `keep` is unaffected: it commits untracked files too. A remote launch's expiry SHALL NOT check a worktree, preserve or remove anything: the orchestrator SHALL read the launch branch tip at origin (`ls-remote`). A tip other than the base sha, with `interruptions` under the bound, SHALL make the expiry a kept release at that tip with reason `leaseExpired` and no `wipCommit`; no branch, or a tip at the base sha, SHALL make it a failed attempt with reason `leaseExpired`. The tick SHALL NOT wait for this read beyond the short bound of integration-pipeline "The tick never waits for origin", and not at all while another remote command is queued or running; startup recovery SHALL await it in full. When origin cannot be read, or the tick's read is still running, the expiry SHALL be left for a later tick, with the launch live, until twice the lease TTL has passed since the lease was last renewed (its expiry time plus one TTL); then the attempt SHALL fail with `leaseExpired`. A read of the branch tip that the tick started SHALL be used only for the lease expiry it was started for (the lease's expiry time when it started): once the lease is renewed (by a worker call or after a gap in the daemon's clock), the next expiry SHALL drop that read and start a new one, so it decides on the tip at origin after the renewal. When a launch ends, for any reason, the orchestrator SHALL drop its read of the branch tip.

#### Scenario: Expiry after a commit is kept
- **WHEN** a claimed launch commits, the commit is observed, and the launch then makes no call past the TTL
- **THEN** the launch ends with `leaseExpired`, the task is `unstarted` with `attempts` 0 and `interruptions` 1, and the next launch's brief says the previous launch's branch holds the work at the commit

#### Scenario: Expiry with only a dirty file is kept
- **WHEN** a claimed launch leaves a modified tracked file, or a staged new file, uncommitted and then falls silent past the TTL
- **THEN** the file is committed as a work-in-progress commit on the branch and the next brief's `interrupted` carries `wipCommit`

#### Scenario: An untracked file alone is not progress
- **WHEN** a claimed launch's only change is an untracked file (a check command's artefact, say) and its lease expires
- **THEN** the expiry is a failed attempt with reason `leaseExpired` and the branch stays at the base sha

#### Scenario: An untracked file is left out of the kept commit
- **WHEN** a claimed launch stages a new file, leaves another file untracked, and its lease expires
- **THEN** the work-in-progress commit holds the staged file only

#### Scenario: The work-in-progress commit fails
- **WHEN** a claimed launch has committed, has uncommitted changes, and holds `index.lock` when its lease expires
- **THEN** the expiry is a kept release at the launch's last commit with no `wipCommit`, `attempts` is unchanged, and the branch is kept

#### Scenario: Remote expiry after a push is kept
- **WHEN** a remote launch pushed its branch one commit ahead of the base and its lease expires
- **THEN** `launch.released` has `kept: true`, `reasonCode: "leaseExpired"` and `headSha` the pushed tip, and the task is `unstarted` with `attempts` unchanged

#### Scenario: Remote expiry with nothing pushed
- **WHEN** a remote launch's lease expires and origin has no launch branch
- **THEN** the attempt fails with reason `leaseExpired`

#### Scenario: Remote expiry with origin unreachable
- **WHEN** a remote launch's lease expires while origin cannot be reached
- **THEN** the first tick fails nothing and the launch stays live, and once twice the lease TTL has passed the attempt fails with `leaseExpired`

#### Scenario: Remote expiry after a renewed lease
- **WHEN** a remote launch's lease expires while origin's queue is held, so the read of the branch tip is still running and the expiry is skipped, the worker then renews its lease by a heartbeat, the read settles with no branch (or an older tip), the worker pushes a commit, and the lease expires again
- **THEN** the second expiry reads the tip again and is a kept release at the commit pushed last, with `attempts` unchanged, and not a failed attempt or a release at the older tip

### Requirement: Kept expiry record
A kept expiry SHALL end the launch with reason `leaseExpired`, and its `launch.ended` event SHALL carry `kept: true`. It SHALL append `launch.released` with `reasonCode: "leaseExpired"`, `progressed: true` and `kept: true`; for a remote launch it SHALL also carry `headSha`, the tip read at origin. It SHALL increase `interruptions` by one and store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason, interruptions }`, so that the retry's brief names the kept branch.

#### Scenario: Events of a kept expiry
- **WHEN** a claimed launch with a commit expires
- **THEN** its `launch.ended` payload is `{ endReason: "leaseExpired", kept: true }` and its `launch.released` payload has `reasonCode: "leaseExpired"`

### Requirement: Lease expiry without progress
An expiry without progress in the worktree SHALL be a failed attempt with reason `leaseExpired`, as before, even when the launch made calls. So SHALL an expiry once the task's kept releases have reached `daemon.maxKeptReleases`. If a call renews the lease while the worktree is being checked, the launch SHALL stay live.

#### Scenario: Expiry without progress spends the attempt
- **WHEN** a claimed launch heartbeats but never touches its worktree, then falls silent past the TTL
- **THEN** the task fails with reason `leaseExpired`, `attempts` is 1, and the next brief carries `priorFailure` with kind `leaseExpired`

#### Scenario: Kept expiries are bounded
- **WHEN** `daemon.maxKeptReleases` is 1 and a task's second claimed launch expires after a commit
- **THEN** the expiry spends an attempt and `interruptions` stays at 1

### Requirement: Silence limit in the claim
The claim response, first and repeated, SHALL carry `health: { stuckFailAfterMs }` with the daemon's `health.stuckFailAfterMs` in force. A work loop without `--max-silence-ms` SHALL take it as its first silence limit when it is positive, and SHALL then follow `budgets.stuckFailAfterMs` from `GET /v1/status` as host-integration "Work loop silence limit" states; when the value is 0 (the daemon never fails a stuck launch) the loop SHALL keep its own default, so a hung agent whose lease the loop renews is still bounded.

#### Scenario: Claim states the threshold
- **WHEN** a worker claims a launch under `health.stuckFailAfterMs: 1800000`
- **THEN** the response has `health: { stuckFailAfterMs: 1800000 }`, and a loop without `--max-silence-ms` ends a silent agent after 1800000ms unless `status` names another value meanwhile

### Requirement: Spawn pass reads each launch before it spawns it
The spawn pass SHALL read each launch's status and its task's entry again just before it changes the launch, not rely on a list read before earlier awaits. It SHALL move the launch from `claimable` to `launching` in the same synchronous store step as that read, and only while the launch is `claimable` and is the lease of a `running` task. A launch claimed meanwhile SHALL keep its worker, lease and worktree, and SHALL NOT be prepared again or spawned.

#### Scenario: Claim lands while the pass awaits another launch
- **WHEN** in `mixed` mode two parked launches are past their window, the pass is awaiting the prepare of the first, and a worker claims the second
- **THEN** the second launch stays `live` with the worker and no pid, its worktree and brief are untouched, its events end with `launch.claimed`, and only the first launch is spawned

### Requirement: Failed spawn of a parked launch
A launch the spawn pass moved to `launching` SHALL NOT stay `launching` when its worktree removal reports the worktree still present, or when its prepare or spawn throws. The pass SHALL NOT prepare over a worktree it could not remove. Within the same daemon process the pass SHALL end the launch with `endReason` `spawnFailed`, the stage (`remove`, `prepare` or `spawn`) and the error.

#### Scenario: Prepare fails
- **WHEN** in `mixed` mode the pass re-prepares a parked launch past its window and the prepare throws
- **THEN** no launch is left `launching`, the launch is `ended` with `spawnFailed` and stage `prepare`, and no agent was spawned for it

#### Scenario: Removal leaves the worktree
- **WHEN** the pass cannot remove a parked launch's worktree
- **THEN** the worktree is not prepared again, the launch is `ended` with `spawnFailed` and stage `remove`, and no agent is spawned for it

### Requirement: Failed spawn fails the attempt
In the transaction that ends a launch whose spawn failed, when the launch is still the lease of a `running` task, the pass SHALL fail the task's attempt with kind `exitedWithoutReport` and detail `spawnFailed: true` with the stage. The failure SHALL be charged as a death is: the task is launched again by the retry, and a failure that repeats ends in `blocked` once attempts are exhausted.

#### Scenario: Task launched again after a failed prepare
- **WHEN** the pass's prepare of a parked launch throws once
- **THEN** the attempt is counted, the task is `running` on a new launch, and the pass spawns that launch after its window

### Requirement: Failed launch at admission
A launch created at admission whose prepare or spawn throws SHALL NOT leave its task `running` on a `preparing` or `launching` row. In any runner mode the orchestrator SHALL end that launch and fail its attempt as for a failed spawn of a parked launch, with the stage `prepare` or `spawn`, and SHALL NOT let the error end the tick. A throw before the launch row exists SHALL leave the task as it was.

#### Scenario: Prepare that always fails
- **WHEN** in `mixed` mode every prepare throws
- **THEN** no tick throws, no launch is left `preparing` or `launching`, the task is never `running` without a parked or live launch, and it ends `blocked` once its attempts are exhausted

#### Scenario: Spawn fails at admission in spawn mode
- **WHEN** in `spawn` mode the spawn of a newly admitted launch throws
- **THEN** the launch is `ended` with `spawnFailed` and stage `spawn`, the attempt is counted, and the task is launched again on a later tick

### Requirement: Cleanup after a failed spawn
Only after the store work for a failed spawn SHALL the pass kill any process by the launch's id and remove its worktree. Both steps SHALL be best effort and SHALL NOT throw out of the pass. A worktree left behind SHALL join the pending removals retried on later ticks.

#### Scenario: Worktree of a failed spawn removed
- **WHEN** a spawn fails after the worktree was prepared
- **THEN** the worktree is removed, or retried on a later tick when the removal leaves it

### Requirement: Lease renewal after a gap
Each write of gaps (health-monitoring "Gap in the daemon's clock") SHALL renew, in the same transaction, the lease of every live launch that holds the lease of a `running` or `waiting` task, to expire at the time of the write plus `leaseTtlMs`. The renewal SHALL NOT be a progress signal: it SHALL leave `progressAt`, `lastSignal`, `progressText` and `stuckSince` unchanged and SHALL append no `launch.unstuck` and no `launch.notice`. The tick SHALL write pending gaps before it tests any lease against the clock it reads in the reconcile phase, and the lease-expiry test of a claimed launch SHALL note the clock and write pending gaps before each test, so no lease is expired while a noted gap is unwritten. This excepts pull-runner "Lease renewal by the work loop" scenario "Renewal stops" and health-monitoring "Process liveness" scenario "Unknown liveness falls back to the lease": a gap after the last contact lengthens the time to expiry by up to the gap plus a TTL.

#### Scenario: A claimed launch survives a sleep between ticks
- **WHEN** a claimed launch in `pull` mode makes no call and the machine sleeps for five TTLs between two ticks
- **THEN** the tick at the wake leaves it live with `attempts` unchanged, its lease expires at or after the wake plus `leaseTtlMs`, and `progressAt` and `lastSignal` are unchanged; after a further TTL plus one tick without a call it ends with `leaseExpired`

#### Scenario: A spawned launch of unknown liveness survives a sleep
- **WHEN** the runner reports `unknown` for a running spawned launch and the machine sleeps for five TTLs
- **THEN** the tick at the wake leaves it live with `attempts` unchanged, and it is failed with reason `leaseExpired` only after a further TTL without contact

#### Scenario: A sleep inside the tick before the lease test
- **WHEN** the machine sleeps for five TTLs while the tick awaits the graph source, before the reconcile phase reads the clock
- **THEN** a claimed launch and a spawned launch of unknown liveness are both live after that tick with `attempts` unchanged

### Requirement: Prepare command
With the top-level file key `prepareCommand` set, the daemon SHALL run it once after each `Workspace.prepare` of a launch, for every runner kind and mode, in the background so the tick does not wait. The launch SHALL be parked or spawned only after the command now configured exited 0 and left the worktree clean outside `.orchestrator/`. Unset, nothing changes. This narrows "Failed launch at admission": a task MAY be `running` on a `preparing` or `launching` row while its command runs.

#### Scenario: Keys
- **WHEN** the configuration file is read at start
- **THEN** `prepareCommand` is an optional non-empty string and `prepareTimeoutMs` a positive integer defaulting to 600000; neither is an override, neither is detected, and neither is in the config report

#### Scenario: Background run and row status
- **WHEN** admission creates a launch while `prepareCommand` is set
- **THEN** `launch.prepareStarted` with `{ command, timeoutMs }` is appended, the tick goes on, and the row stays `preparing` while the command runs; no launch status is added and the job is held in memory only

#### Scenario: Capacity and scope
- **WHEN** a launch's command runs
- **THEN** its task is `running`, so the launch holds a capacity slot and its task's scope, and at most `capacity` commands run at once

#### Scenario: Environment
- **WHEN** the command runs
- **THEN** it runs like the check command: in the worktree root, with the check command's environment, a 64 KiB output tail written to one daemon log line, and its process group killed at `prepareTimeoutMs`
- **AND** it is started as `/bin/sh -c '/bin/sh -c "$1"; exit $?' orch-prepare-<launchId> <prepareCommand>`, so `killByLaunchId` finds it after a crash

#### Scenario: Bounded wait after a kill
- **WHEN** a command the daemon killed, at the timeout or at an abort, has not closed 2000 ms later, or a command exited while another process still holds its output pipe
- **THEN** its outcome is recorded then, as `timeout` at the timeout and as aborted at an abort, and no job stays without an outcome

#### Scenario: Success and next step
- **WHEN** the command exited 0 and the worktree is clean
- **THEN** a tick appends `launch.prepared` with `{ command, durationMs }` and then parks the launch, or spawns it when the row is `launching` or the mode was `spawn` when the command started
- **AND** the lease is renewed for a full TTL immediately before the spawn

#### Scenario: Outcome applied by the tick
- **WHEN** the command ends
- **THEN** its callback only records the outcome in the job and wakes the loop; the tick applies it, and no job's error ends the tick or keeps the other jobs from being handled in the same pass

#### Scenario: Pause
- **WHEN** a command succeeds while the run is paused
- **THEN** a launch whose next step is park is parked at once, and one whose next step is spawn waits in `preparing` or `launching` until the resume; a running command is not stopped

#### Scenario: Hold after a gap
- **WHEN** the daemon is in the hold after a gap
- **THEN** no new command starts and no prepared launch is spawned, a running command is not interrupted, a success is applied, and a launch whose next step is park is parked

#### Scenario: Second run in mixed mode
- **WHEN** in `mixed` mode the daemon spawns a parked launch after the claim window
- **THEN** its worktree is prepared again and the command runs a second time while the row is `launching`; a failure of that run is a prepare failure
- **AND** a `launching` row can last for the length of a command, while no agent holds its token

#### Scenario: Not claimable before success
- **WHEN** a worker claims while a launch's command runs
- **THEN** that launch is not offered, and a claim naming its task answers 409 with `state` `preparing`

### Requirement: Prepare failure
A command that exits non-zero, times out, is killed from outside, cannot be started, or leaves the worktree dirty or unreadable SHALL be a prepare failure. It SHALL spend no attempt: the launch is ended with `prepareCommandFailed`, `launch.prepareFailed` appended, the worktree removed, and the task returned to `unstarted` by the orchestrator with trigger `prepareFailed`, attempts and carry unchanged.

#### Scenario: Event payload
- **WHEN** a prepare failure is applied
- **THEN** `launch.prepareFailed` carries `{ reason, exitCode, durationMs, output, dirty, error }`, `output` being the last 4096 characters of the command's output

#### Scenario: Reasons
- **WHEN** the command exits non-zero, times out, dies from a signal the daemon did not send, cannot be started (or the runner throws), or leaves the worktree dirty
- **THEN** the reason is `exit`, `timeout`, `killed`, `spawn` or `dirty` respectively; a `dirty` failure names up to 10 paths, and the daemon never edits ignore rules

#### Scenario: A throwing clean test
- **WHEN** the clean test after a zero exit throws
- **THEN** it is a prepare failure of reason `dirty` with `error` holding the error text, and the other jobs are handled in the same tick

#### Scenario: No attempt spent
- **WHEN** a prepare failure is applied
- **THEN** the task is not charged an attempt and has no `priorFailure` added; while the run is paused it is not admitted again before the resume

### Requirement: Prepare command and a task that left
When the task no longer runs on a launch whose command runs (cancelled, reset by a cascade, superseded), the next tick SHALL kill the command by its own handle and, once it has ended, end the launch (`cancelled` for a cancelled task, else `superseded`) and remove the worktree, appending no `launch.prepareFailed`. `stop()` SHALL abort every command and apply nothing.

#### Scenario: Cancel while the command runs
- **WHEN** a task is cancelled while its launch's command runs
- **THEN** the next tick aborts the command, and after it ended the launch is ended as `cancelled` and its worktree removed, with no `launch.live` or `launch.claimable`

#### Scenario: Cascade while the command runs
- **WHEN** a cascade resets the task while its command runs, and admission launches it again
- **THEN** the old launch alone is ended as `superseded`; the jobs are keyed by launch id and the two commands run in separate worktrees

#### Scenario: Left between success and spawn
- **WHEN** the task leaves after its success was applied and before the spawn
- **THEN** the launch is not spawned, its job is kept, and the next pass over the jobs ends it as above

#### Scenario: Stop
- **WHEN** `stop()` runs while commands run
- **THEN** each is aborted, `stop()` waits for them for no longer than 5000 ms in all, the rows stay `preparing` or `launching` for the next start, and no command starts after it

#### Scenario: Fatal store
- **WHEN** the store goes fatal while a command runs
- **THEN** the job records nothing and the row stays for the next start

### Requirement: Claim states the limit in force
The `health.stuckFailAfterMs` of a claim response, a repeated claim included, SHALL be the value in force when the response is built, overrides applied: an override of 0 SHALL give 0, and a cleared override SHALL give the file value, else the default. A work loop that has already taken the value for a launch keeps it for that launch.

#### Scenario: A claim after an override
- **WHEN** `health: { stuckFailAfterMs: 1800000 }` is applied and a worker claims a launch
- **THEN** the claim carries `health.stuckFailAfterMs` 1800000

#### Scenario: A repeated claim after a further change
- **WHEN** the override is changed to 3600000 and the worker repeats its claim
- **THEN** the repeated claim carries 3600000

#### Scenario: A claim after an override of 0
- **WHEN** `health: { stuckFailAfterMs: 0 }` is applied and a worker claims a launch
- **THEN** the claim carries `health.stuckFailAfterMs` 0

### Requirement: Prepare failure limit
The system SHALL count the prepare failures of each task in a row, as "Prepare failure" defines them, in one kv entry `prepareRetry`: a JSON object from task id to `{ failures, retryAt, last }`, `last` being `exit <code>`, `timeout`, `killed`, `spawn` or `dirty`. A failure SHALL be counted only when the task still runs on the failed launch; a cancel, a cascade reset, a stop or a crash during a command counts nothing, and a failure whose run overlapped a machine sleep counts like any other. The count SHALL be read and written inside the transaction that applies the failure.

Below `prepareFailureLimit` (a top-level file key read at start, positive integer, default 3) the task SHALL return to `unstarted` as "Prepare failure" says, and SHALL be admitted again only at `retryAt`: the failure time plus `prepareRetryBackoffMs` (a top-level file key read at start, non-negative integer, default 30000) times 2 to the power of the earlier failures, the factor capped at 32. The wait SHALL count wall time and SHALL go on during a pause. A task before its `retryAt` SHALL NOT be a candidate for admission and SHALL hold no capacity slot. Nothing wakes the loop at `retryAt`: the task is admitted on the first tick at or after it.

When `failures` reaches `prepareFailureLimit` the orchestrator SHALL apply `running -> blocked` with trigger `prepareFailed` and reason kind `prepareFailed`, attempts and carry unchanged, and remove the task's entry. The message SHALL be `` prepare command `<command>` failed <n> times in a row; last: <reason> `` and SHALL carry no command output; the output stays in `launch.prepareFailed` and the daemon log.

`launch.prepareFailed` SHALL carry `failures` and `limit` when the failure is counted, and `retryAt` when the task is not blocked.

The entry of a task SHALL be removed when its prepare command succeeds (in the transaction that appends `launch.prepared`), when it is blocked at the limit, and by every transition of it with trigger `unblock`, `reopen`, `uncancel` or `cascade`. A cancel alone SHALL leave it; the uncancel removes it. A task the cascade does not reset, such as an `unstarted` dependent of the reopened task, SHALL keep its entry. The store has no kv delete: an emptied object is stored as `''`, which reads as no entries.

Per operator-control "Idle exit", a retry entry whose id is a task node of the loaded graph that is `unstarted` SHALL keep the daemon from being quiescent, whatever its `retryAt` says. An entry for an id that is not a task node of the loaded graph SHALL NOT.

With `prepareCommand` unset the entry SHALL never be read or written.

#### Scenario: First failure is counted
- **WHEN** the prepare command of a task's first launch exits 1 under the defaults
- **THEN** `launch.prepareFailed` carries `failures` 1, `limit` 3 and `retryAt` the failure time plus 30000, the task is `unstarted` with `attempts` unchanged, and its entry holds the same `failures` and `retryAt`

#### Scenario: Doubling backoff
- **WHEN** the task is launched again at `retryAt` and its command fails again
- **THEN** no launch was created for it before `retryAt`, and the new `retryAt` is the failure time plus 60000

#### Scenario: A waiting task holds no slot
- **WHEN** capacity is 1 and a task waits out its retry while another task is ready
- **THEN** the other task is launched

#### Scenario: Block at the limit
- **WHEN** the third failure in a row of a task is applied under the defaults
- **THEN** the task is `blocked` with reason kind `prepareFailed`, attempts unchanged, the message names the command, the count and the last reason and holds no output, the event carries `failures` 3 and no `retryAt`, and the task has no entry

#### Scenario: Reset by a success
- **WHEN** a task's command fails, then succeeds, then fails
- **THEN** the last failure has `failures` 1

#### Scenario: Reset by an uncancel
- **WHEN** a task with an entry is cancelled and then uncancelled
- **THEN** the cancel leaves the entry, the uncancel removes it, and the task is admitted on the next tick without waiting for the old `retryAt`

#### Scenario: Cascade
- **WHEN** a cascade reopen resets a task whose command runs, and another task waits out its retry as an `unstarted` dependent of a reopened task
- **THEN** the reset task has no entry and the waiting task keeps its entry

#### Scenario: Not quiescent while a retry waits
- **WHEN** a task with an entry is `unstarted`, before or after its `retryAt`
- **THEN** the daemon is not quiescent; once the task is cancelled or blocked, or when the entry names no task of the graph, the entry does not count

#### Scenario: Limit 1 and backoff 0
- **WHEN** `prepareFailureLimit` is 1, or `prepareRetryBackoffMs` is 0
- **THEN** the first failure blocks the task and writes no entry, or the task is admitted again in the same tick that applies the failure

### Requirement: Remote run requirements
Besides the conditions of "Access modes", the daemon SHALL refuse to start with `runner.access: remote` when `apiBaseUrl` is unset, with a message naming `apiBaseUrl`, and when the commit policy of the runner kind in force is `daemon` (for `codex`, `runner.codex.commit`, or the policy derived from its sandbox when unset), with a message naming the commit policy, the kind and its `commit` key. These conditions SHALL be checked against the configuration in force, overrides included, and named in the same message as the others. On a remote run, admission SHALL block a task whose runner kind (its `runner` selector, else the kind in force) has commit policy `daemon` with reason kind `remoteNeedsAgentCommit`, before brief validation and without creating a launch.

#### Scenario: Remote run without apiBaseUrl
- **WHEN** the daemon starts with `runner.access: remote`, `runner.mode: pull`, `git.pushIntegration: true` and no `apiBaseUrl`
- **THEN** startup fails with a message naming `apiBaseUrl`, and no launch is created

#### Scenario: Remote run whose default kind commits as the daemon
- **WHEN** the daemon starts a remote run with `runner.kind: codex` and `runner.codex.commit` unset under the default `workspace-write` sandbox
- **THEN** startup fails with a message naming the commit policy `daemon` and `runner.codex.commit`

#### Scenario: A task labelled to a daemon-commit kind on a remote run
- **WHEN** a remote run whose default kind is `claude-code` admits a task with the selector `runner: codex` and `runner.codex.commit` unset
- **THEN** the task is `blocked` with reason kind `remoteNeedsAgentCommit` and no launch is created
