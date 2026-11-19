## MODIFIED Requirements

### Requirement: Runner modes
Every launch prepared in `pull` or `mixed` mode SHALL be parked as `claimable` once its worktree and brief exist; in `spawn` mode the launch SHALL be spawned immediately as before. A parked launch SHALL have a claim window: unbounded in `pull`, `runner.claimWindowMs` from the moment it became claimable in `mixed`, and zero in `spawn`. On each tick the orchestrator SHALL spawn every parked launch whose window has elapsed.

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
Without `taskId` `POST /v1/claims` SHALL hand over the oldest claimable launch by creation time among those whose kind the filter names (any kind without a filter); with `taskId` it SHALL hand over that task's claimable launch, answering 404 when the task has no launch, 409 naming the launch state when its launch is not claimable, and 409 naming the launch's `runner` when its kind is outside the filter. A worker that already holds a launch SHALL get it back whatever its filter.

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
`workerId` SHALL be an opaque string chosen by the worker and unique within a run. A worker SHALL hold at most one live launch. A claim by a worker that already holds a live launch SHALL return that launch again with the same token when `taskId` is absent or matches, and 409 otherwise. `status` SHALL list every worker with its launch.

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
`POST /v1/launches/:id/release` with a `reason` and an optional boolean `keep` SHALL apply to a live launch held by a worker and SHALL answer 409 for any other launch. When no progress has been observed since the claim, meaning no commit or dirty file in the worktree and no API call under the token, the launch SHALL end with reason `released`, the task SHALL return to `unstarted` without consuming an attempt, and the worktree SHALL be removed so that the next admission prepares a new launch.

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
A run SHALL have one access, the file key `runner.access`, `local` or `remote`, default `local`, read at start; it SHALL NOT be a runtime override. `local` means the worker runs on the daemon's machine, reaches the loopback API, and works in the worktree the daemon prepared. `remote` means the worker runs elsewhere and gets no worktree from the daemon (see specs/remote-workspace). Any other value SHALL fail configuration loading with a message naming `runner.access`.

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

## ADDED Requirements

### Requirement: Runner modes: configuration keys
The configuration SHALL accept `runner.mode` with values `spawn`, `pull`, and `mixed`, defaulting to `spawn`, and `runner.claimWindowMs`, defaulting to 60000.

#### Scenario: Runner keys left unset
- **WHEN** the configuration sets neither `runner.mode` nor `runner.claimWindowMs`
- **THEN** the runner mode is `spawn` and the claim window is 60000 ms, and a `runner.mode` other than `spawn`, `pull` or `mixed` fails configuration loading

### Requirement: Runner modes: mode override
`start` with a `mode` argument SHALL override the configured mode for the run, passed to the daemon it spawns or set through the `runner` route on a daemon already running; the override SHALL be stored durably and SHALL apply from the next tick, including to launches already parked.

#### Scenario: Override stored and applied to parked launches
- **WHEN** two launches are parked in `pull` mode and the mode is set to `spawn`
- **THEN** the store's `runner.mode` key holds `spawn`, an `operator.mode` event records `mode: spawn`, the mode in force is `spawn`, and the first tick while the run is not paused spawns both launches

### Requirement: Runner modes: paused run
While the run is paused, parked launches SHALL stay parked: they SHALL NOT be spawned and SHALL NOT be claimed.

#### Scenario: Pause holds parked launches
- **WHEN** two launches are parked in `pull` mode, the run is paused, and the mode is switched to `spawn`
- **THEN** a tick leaves both `claimable` with no process spawned, a claim answers 404 with `paused: true`, and after `resume` the next tick spawns both

### Requirement: Claim: request fields
`POST /v1/claims` SHALL take `workerId`, an optional `taskId`, an optional `access`, and an optional `runner`: one runner kind or a list of the kinds the worker can run; a value outside the kinds SHALL be refused with 400.

#### Scenario: Kind outside the runner kinds
- **WHEN** a worker claims with `runner: "gemini"`, and then with `runner: ["claude-code", "codex"]` while only a `codex` launch is parked
- **THEN** the first claim answers 400 naming the kinds and the launch stays `claimable`, and the second hands over the `codex` launch

### Requirement: Claim: nothing to hand over
When nothing is claimable for the filter, or the run is paused, `POST /v1/claims` SHALL answer 404 with `paused` set accordingly, and a launch of another kind SHALL stay parked.

#### Scenario: Paused run and empty run answer 404
- **WHEN** a worker that holds no launch claims while nothing is claimable, and another worker that holds no launch claims after the run is paused
- **THEN** both answers are 404, the first with `paused: false` and the second with `paused: true`

### Requirement: Claim: launch handed over
On success the launch SHALL become `live` with `worker: { id, claimedAt }` and no pid, its lease SHALL be reset to expire `leaseTtlMs` after the claim, and the response SHALL be `{ launchId, taskId, token, worktree, briefPath, brief, baseSha, apiUrl, runner, commitPolicy, model, effort }`, where `brief` is the launch's `brief.json` content, `briefPath` the path of its `brief.md`, and `runner`, `commitPolicy`, `model`, and `effort` the values fixed when the launch was prepared.

#### Scenario: Local claim response names the brief
- **WHEN** a worker claims T1's parked launch on a local pull run
- **THEN** the response's `brief` holds T1's description from `brief.json`, `briefPath` names a file that exists, `worktree`, `baseSha` and `token` are the launch's, and the entry's lease expires `leaseTtlMs` after `worker.claimedAt`

### Requirement: Claim: token fenced until the claim
The token of a claimable launch SHALL NOT authenticate until the claim is recorded.

#### Scenario: Heartbeat with the token of a parked launch
- **WHEN** a heartbeat is sent with the token of a `claimable` launch, and another with the token of a launch a worker has claimed
- **THEN** the first heartbeat answers 401 and the second answers 200

### Requirement: Claim: Codex block
For a `codex` launch the response SHALL also carry `codex: { settings, maxWaitMs, retryWindowMs, env }`: the effective `runner.codex` keys, the long-poll ceiling, the retry window, and the agent environment a spawned launch would get, so that a worker loop composes the same `codex exec` command. A launch of one kind SHALL NOT carry another kind's block.

#### Scenario: Codex claim carries the long-poll facts
- **WHEN** a worker claims a `codex` launch with `runner: "codex"`
- **THEN** `codex.maxWaitMs` and `codex.retryWindowMs` equal the daemon's `maxWaitMs` and `retryWindowMs` and `codex.env.ORCH_TOKEN` is the claim's token, while the response to a claim of an `opencode` launch has no `codex` block

### Requirement: Claim: OpenCode block
For an `opencode` launch the response SHALL carry `opencode: { settings, allowedTools, maxWaitMs, retryWindowMs, env }` instead: the effective `runner.opencode` keys, the long-poll ceiling, the retry window, and the agent environment, so that a worker loop composes the same `opencode run` command and per-launch config, including the derived permission ruleset.

#### Scenario: OpenCode claim carries the settings and the environment
- **WHEN** a worker claims an `opencode` launch with `runner: "opencode"` under `runner.opencode.permission: allow`
- **THEN** `opencode.settings.permission` is `allow`, `opencode.maxWaitMs` and `opencode.retryWindowMs` equal the daemon's values, and `opencode.env` carries `ORCH_TOKEN` equal to the claim's token and `ORCH_API` equal to the daemon's URL

### Requirement: Claim: OpenCode permission rules
For an `opencode` launch the response SHALL carry `opencode: { settings, allowedTools, maxWaitMs, retryWindowMs, env }` instead: the rules the OpenCode runner derives its permission ruleset from (the composed allow list, else the detected toolchain and the claude file rules, the same list the runner is given).

#### Scenario: Rules equal the runner's list
- **WHEN** a worker claims an `opencode` launch
- **THEN** `opencode.allowedTools` equals the daemon's `openCodeAllowedTools()`: the composed allow list when it holds rules, else the list composed from the detected toolchain and the `runner.claude` file rules

### Requirement: Claim: remote response
For a launch with `access: remote` the response SHALL carry every field of the local response except `worktree` and `briefPath`, plus `access: "remote"`, `repoUrl`, `integrationBranch`, and `briefMarkdown`: `repoUrl` is `git.workerOriginUrl` when set, else `git.originUrl`, else the URL of the daemon clone's `origin` remote, passed through as written (user information included); `brief` is the launch row's stored `briefJson` and `briefMarkdown` its stored brief text, neither read from disk.

#### Scenario: Remote brief from the launch row
- **WHEN** a remote worker claims a parked remote launch whose row has no worktree, on a run whose `git.workerOriginUrl` holds a user and a token
- **THEN** the response's `brief` equals the row's `briefJson`, `briefMarkdown` equals the row's brief text, `repoUrl` is `git.workerOriginUrl` with its user and token unchanged, and the response has no `worktree` and no `briefPath`

### Requirement: Claim: remote carry and repeated claim
When the stored brief's context holds `interrupted` (a kept release), the remote response SHALL carry it as `carry`, so that the worker starts its branch at `carry.interrupted.headSha`. A repeated claim of a remote launch SHALL answer the same body with `repeated: true`. The local response SHALL be unchanged.

#### Scenario: Repeated remote claim answers the same body
- **WHEN** a remote worker claims a parked remote launch and then claims again with the same worker id
- **THEN** the second response has `repeated: true` and is otherwise the first response apart from the lease fields, while a local claim's response keeps `worktree` and `briefPath` and has no `access`, `repoUrl` or `briefMarkdown`

### Requirement: Claim: remote fingerprint
A remote claim SHALL record no baseline `fingerprint` on the launch and SHALL NOT read the workspace fingerprint.

#### Scenario: No fingerprint call on a remote claim
- **WHEN** a remote worker claims a parked remote launch while the calls to `Workspace.fingerprint` are counted, and a tick follows
- **THEN** no call was made, the launch is `live`, and its row has no `fingerprint`

### Requirement: Claim: worker origin URL key
`git.workerOriginUrl` is a config-file key read at start; it SHALL NOT change the meaning of `git.originUrl`, which stays the URL of the daemon clone's `origin` and the input of the run id.

#### Scenario: Worker URL leaves the run id alone
- **WHEN** the configuration sets both `git.originUrl` and `git.workerOriginUrl` under a Postgres store
- **THEN** `git.originUrl` keeps its value, the run id equals the one chosen with `git.originUrl` alone, and an empty `git.workerOriginUrl` fails configuration naming `workerOriginUrl`

### Requirement: Claim: workers claim by kind
The work workflow's Claude Code workers SHALL claim with `runner: "claude-code"`, and the work loop with `runner: "codex"` or `runner: "opencode"`, the kind it was started for.

#### Scenario: Claim lines of the workflow and the loop
- **WHEN** the work workflow tells a worker how to claim, and the work loop claims after starting with `--runner opencode` or with no `--runner`
- **THEN** the workflow names `access "local", and runner "claude-code"`, and the loop posts `/v1/claims` with `runner: "opencode"` or with `runner: "codex"`, the default

### Requirement: Worker identity: pending question in a repeated claim
The response to a repeated claim SHALL also carry `pending: { seq, question, answer? }` when the launch has an open question or an admitted answer, so that a fresh worker can collect the answer with `block` and the same seq.

#### Scenario: Re-claim carries the open question
- **WHEN** a worker holding T1's launch blocks with seq 1 and the message `which?`, and claims again with the same worker id while T1 is `waiting`
- **THEN** the response has `repeated: true` and `pending` with seq 1 and the question whose message is `which?`

### Requirement: Release: after progress without keep
When progress has been observed and `keep` is false, the release SHALL be a failed attempt with reason `released` and the worker's reason as message.

#### Scenario: Failed release reaches the next brief
- **WHEN** a worker commits in its worktree and releases without `keep` with the reason `cannot finish`
- **THEN** the answer has `outcome: "failed"` and `progressed: true`, the task is `unstarted` with `attempts` 1, and the next claim's brief carries `priorFailure` with kind `released` and message `cannot finish`

### Requirement: Release: kept release after progress
When progress has been observed and `keep` is true, the orchestrator SHALL commit any uncommitted changes in the worktree as a work-in-progress commit on the launch branch, SHALL end the launch with reason `released`, SHALL remove the worktree and keep the branch, SHALL return the task to `unstarted` with `attempts` unchanged, and SHALL store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason }` so that the next brief carries it.

#### Scenario: Kept release ends the launch and stores the context
- **WHEN** the worker of T1's launch L1 has progress and releases with `keep` true and the reason `closing the laptop`
- **THEN** L1 is `ended` with reason `released`, its worktree is gone, T1 is `unstarted` with `attempts` 0, `carry.interrupted` holds L1, `task/T1/l1`, the head and work-in-progress shas and that reason, and the brief of T1's next parked launch carries it

### Requirement: Release: kept release response
When progress has been observed and `keep` is true, the response SHALL report `kept` true with the branch and head sha.

#### Scenario: Answer names the kept branch and head
- **WHEN** the worker of T1's launch has progress and releases with `keep` true
- **THEN** the answer has `ok: true`, `outcome: "unstarted"`, `progressed: true`, `kept: true`, `branch: "task/T1/l1"`, and the `headSha` and `wipCommit` of the preserved work

### Requirement: Release: release while waiting
A release while the task is `waiting` SHALL act as process death: the task becomes `blocked` with its question preserved, and with `keep` the same `interrupted` context SHALL be stored and the branch kept.

#### Scenario: Kept release of a waiting launch
- **WHEN** T1 is `waiting` on the question `which way?`, its worktree shows progress at `c1`, and its worker releases with `keep` true
- **THEN** the answer has `outcome: "blocked"` and `kept: true`, T1 is `blocked` with that question, `attempts` 0 and `interruptions` 1, `carry.interrupted.headSha` is `c1`, and after `unblock` with the answer `left` the carry holds both the answer and `interrupted`

### Requirement: Release: interruptions
The overlay entry SHALL carry `interruptions`, increased by one on every kept release after progress or while waiting, reset to zero when the task submits, carried in the `interrupted` context, and reported with each live launch in `status`.

#### Scenario: Interruptions counted, shown and reset
- **WHEN** T1 is released with `keep` after progress, claimed again, and its next launch is submitted
- **THEN** `carry.interrupted.interruptions` is 1, the live launch of T1 in `status` shows `interruptions` 1, and after the accepted submit the entry's `interruptions` is 0

### Requirement: Release: kept release bound
The configuration SHALL accept `daemon.maxKeptReleases`, default 3, where 0 means unlimited; a release with `keep` for a task whose `interruptions` already equals or exceeds it SHALL behave as a release without `keep`.

#### Scenario: A bound of 0 keeps every release
- **WHEN** `daemon.maxKeptReleases` is 0 and a task whose `interruptions` is 5 is released with `keep` after progress
- **THEN** the answer has `kept: true` and the task's `interruptions` becomes 6, while with the key unset the bound in force is 3

### Requirement: Release: lease expiry of a claimed launch
Lease expiry on a claimed launch SHALL follow "Lease expiry": a kept release when the worktree shows progress since the claim and the bound allows, a failed attempt with reason `leaseExpired` otherwise.

#### Scenario: Expired claim kept, untouched retry failed
- **WHEN** the lease of T1's claimed launch expires with a staged file in its worktree, and the retry's claim then expires untouched
- **THEN** the first launch ends with `leaseExpired`, its branch holds a work-in-progress commit of the file on the base, and T1 has `attempts` 0 and `interruptions` 1; after the retry expires T1 has `attempts` 1

### Requirement: Release: remote release body
A remote launch (`access: remote`) has no worktree on the daemon's host: the release body MAY carry `headSha`, the launch branch tip the worker pushed, and `wipCommit`, its work-in-progress commit, each a full hex object name (a malformed one SHALL be answered 400 naming the field, and a local release SHALL ignore both).

#### Scenario: Malformed shas refused before origin is asked
- **WHEN** a remote worker releases with `keep` and `headSha: "abc123"`, and then with a full `headSha` and `wipCommit: "nope"`
- **THEN** the answers are 400 with `field: "headSha"` and 400 with `field: "wipCommit"`, and the launch stays `live`

### Requirement: Release: remote progress
For a remote launch, progress SHALL be any agent API call since the claim or a `headSha` that differs from the base sha, and the orchestrator SHALL NOT fingerprint, preserve or remove anything.

#### Scenario: Remote release touches no workspace
- **WHEN** a remote worker heartbeats, pushes a commit on the launch branch, and releases with `keep` and `headSha` equal to the pushed tip, while the workspace calls are counted
- **THEN** the answer has `kept: true` and `headSha` the tip, and `Workspace.fingerprint`, `preserve` and `remove` were each called 0 times

### Requirement: Release: remote keep checks origin
A kept remote release SHALL fetch the launch branch from origin and require its tip to equal `headSha`: no branch on origin SHALL answer 409 `branchNotPushed`, another tip 409 `shaMismatch`, and an origin that cannot be fetched 503 `originUnreachable` or `originRefused`; on any of these the task and the launch SHALL be unchanged, the launch SHALL stay live, and no `launch.released` event SHALL be appended.

#### Scenario: Refused keep changes nothing
- **WHEN** a remote worker releases with `keep` and a `headSha` it has not pushed, and then with that `headSha` after pushing a later commit
- **THEN** the answers are 409 `branchNotPushed` and 409 `shaMismatch` with `expected` the reported sha and `actual` the pushed tip, the launch is `live`, the task is `running` with `attempts` 0, and no `launch.released` event exists

### Requirement: Release: remote keep without headSha
A remote release with `keep` but no `headSha` cannot be kept and SHALL behave as a release without `keep`, with `keepError` naming `headSha`.

#### Scenario: Keep without a pushed tip
- **WHEN** a remote worker that has made an API call since the claim releases with `keep` true and no `headSha`
- **THEN** the answer has `kept: false`, `progressed: true` and a `keepError` naming `headSha`, and the release is a failed attempt with reason `released`

### Requirement: Release: remote kept carry
When origin's tip of the launch branch equals the reported `headSha`, a kept remote release SHALL store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason, interruptions }` as a local one does, under the same `daemon.maxKeptReleases` bound, and its `launch.released` event SHALL carry `headSha`.

#### Scenario: Pushed tip kept at no cost
- **WHEN** a remote worker pushes two commits and releases with `keep`, `headSha` and `wipCommit` equal to the pushed tip, and the reason `handing back`
- **THEN** `carry.interrupted` equals the prior launch id, its branch, that tip as `headSha` and `wipCommit`, the reason and `interruptions` 1, the `launch.released` event carries `headSha`, and the next remote claim's `carry` holds the tip

### Requirement: Access modes: remote run preconditions
The daemon SHALL refuse to start with `runner.access: remote` unless the runner mode in force is `pull`, `git.pushIntegration` is true, and `prepareCommand` is unset, with one message naming each unmet condition; on a remote run `PUT /v1/runner` SHALL refuse any mode other than `pull` with 409.

#### Scenario: Mode route on a remote run
- **WHEN** `PUT /v1/runner` is called on a remote run with mode `spawn`, and then with mode `pull`
- **THEN** the first answers 409 naming `access: remote` and `mode: spawn`, and the second answers 200

### Requirement: Access modes: access on launch rows
Every launch row SHALL carry the run's access in `access`, set when the row is created and never changed; a row without it is `local`.

#### Scenario: Rows of a remote run
- **WHEN** a remote run admits T1
- **THEN** T1's launch row has `access: 'remote'` and no worktree, and its `launch.created` event carries `access: 'remote'`

### Requirement: Access modes: claim access
A claim's `access` SHALL be `local` or `remote` and SHALL default to `local`; any other value SHALL be answered 400. A claim whose `access` differs from the run's SHALL be answered 409 with `reason`, `access` and `runAccess`, and SHALL change no launch.

#### Scenario: Claim access outside the two
- **WHEN** a worker claims with `access: 'other'` on a local run
- **THEN** the answer is 400 and the parked launch stays `claimable`
