## MODIFIED Requirements

### Requirement: Session attachments
A claim MAY carry `attachment`, the id of a registered session attachment, which SHALL be stored on the launch's worker record as `worker.attachment`. When an attachment ends, by its own end request, by the first pid of its chain being found dead at reconcile, or by a session end naming any pid in its chain, every live claimed launch whose worker carries it SHALL be released with `keep` and reason `sessionEnded` at the next reconcile.

#### Scenario: Worker dies with its session
- **WHEN** a worker claimed T2 through attachment A, committed twice, and A's process dies
- **THEN** the next reconcile ends T2's launch with reason `released`, T2 is `unstarted` with `attempts` unchanged and `carry.interrupted` naming the branch, and a call with the old token answers 401

#### Scenario: Lease still governs an unattached claim
- **WHEN** a worker claims without an attachment and stops calling for longer than the lease TTL
- **THEN** the task is `failed` with reason `leaseExpired` as before

### Requirement: Worker usage
A claimed launch has no process for the daemon to observe and no log for a runner to read, so its worker SHALL be able to post the launch's usage after its agent exits: `POST /v1/launches/:id/usage` with `{ workerId, usage: { tokens, model?, costUsd? } }`, where `tokens` is `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }` of non-negative integers and `costUsd` is non-negative. A malformed body SHALL be refused with 400.

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

### Requirement: Lease expiry
When a `running` claimed launch's lease expires, the orchestrator SHALL check the worktree for progress since the claim: a commit (head is not the base sha), a change to a tracked file, or a path the worker staged. An untracked file alone SHALL NOT be progress, and the work-in-progress commit of an expiry SHALL NOT include untracked files: a file is added to the kept commit only when the worker stages it. A release with `keep` is unaffected: it commits untracked files too.

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

### Requirement: Silence limit in the claim
The claim response, first and repeated, SHALL carry `health: { stuckFailAfterMs }` with the daemon's `health.stuckFailAfterMs` in force.

#### Scenario: Claim states the threshold
- **WHEN** a worker claims a launch under `health.stuckFailAfterMs: 1800000`
- **THEN** the response has `health: { stuckFailAfterMs: 1800000 }`, and a loop without `--max-silence-ms` ends a silent agent after 1800000ms unless `status` names another value meanwhile

### Requirement: Lease renewal after a gap
Each write of gaps (health-monitoring "Gap in the daemon's clock") SHALL renew, in the same transaction, the lease of every live launch that holds the lease of a `running` or `waiting` task, to expire at the time of the write plus `leaseTtlMs`.

#### Scenario: A claimed launch survives a sleep between ticks
- **WHEN** a claimed launch in `pull` mode makes no call and the machine sleeps for five TTLs between two ticks
- **THEN** the tick at the wake leaves it live with `attempts` unchanged, its lease expires at or after the wake plus `leaseTtlMs`, and `progressAt` and `lastSignal` are unchanged; after a further TTL plus one tick without a call it ends with `leaseExpired`

#### Scenario: A spawned launch of unknown liveness survives a sleep
- **WHEN** the runner reports `unknown` for a running spawned launch and the machine sleeps for five TTLs
- **THEN** the tick at the wake leaves it live with `attempts` unchanged, and it is failed with reason `leaseExpired` only after a further TTL without contact

#### Scenario: A sleep inside the tick before the lease test
- **WHEN** the machine sleeps for five TTLs while the tick awaits the graph source, before the reconcile phase reads the clock
- **THEN** a claimed launch and a spawned launch of unknown liveness are both live after that tick with `attempts` unchanged

### Requirement: Prepare failure limit
The system SHALL count the prepare failures of each task in a row, as "Prepare failure" defines them, in one kv entry `prepareRetry`: a JSON object from task id to `{ failures, retryAt, last }`, `last` being `exit <code>`, `timeout`, `killed`, `spawn` or `dirty`. The count SHALL be read and written inside the transaction that applies the failure.

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
Besides the conditions of "Access modes", the daemon SHALL refuse to start with `runner.access: remote` when `apiBaseUrl` is unset, with a message naming `apiBaseUrl`, and when the commit policy of the runner kind in force is `daemon` (for `codex`, `runner.codex.commit`, or the policy derived from its sandbox when unset), with a message naming the commit policy, the kind and its `commit` key.

#### Scenario: Remote run without apiBaseUrl
- **WHEN** the daemon starts with `runner.access: remote`, `runner.mode: pull`, `git.pushIntegration: true` and no `apiBaseUrl`
- **THEN** startup fails with a message naming `apiBaseUrl`, and no launch is created

#### Scenario: Remote run whose default kind commits as the daemon
- **WHEN** the daemon starts a remote run with `runner.kind: codex` and `runner.codex.commit` unset under the default `workspace-write` sandbox
- **THEN** startup fails with a message naming the commit policy `daemon` and `runner.codex.commit`

#### Scenario: A task labelled to a daemon-commit kind on a remote run
- **WHEN** a remote run whose default kind is `claude-code` admits a task with the selector `runner: codex` and `runner.codex.commit` unset
- **THEN** the task is `blocked` with reason kind `remoteNeedsAgentCommit` and no launch is created

## ADDED Requirements

### Requirement: Session attachments: unattached claim
A claim without an attachment SHALL be governed by its lease alone, as before.

#### Scenario: An ended attachment leaves an unattached claim alone
- **WHEN** worker `w1` holds a launch it claimed without an attachment, and an attachment A that another worker registered ends
- **THEN** the next reconcile releases only the launches whose worker carries A, and `w1`'s launch stays live under its lease

### Requirement: Session attachments: kept release ends the launch
A kept release SHALL end the launch, so the former worker's token SHALL no longer authenticate.

#### Scenario: Old token refused after a kept release
- **WHEN** worker `w1` commits in its claimed launch's worktree, releases the launch with `keep: true`, and then calls its heartbeat with the launch token
- **THEN** the release answers `outcome: unstarted` with `kept: true`, and the heartbeat answers 401

### Requirement: Worker usage: route without the launch token
The worker usage route `POST /v1/launches/:id/usage` SHALL be identified by the body like `/v1/claims` and the release route and SHALL NOT need the launch token, because by the time the worker has the usage the task is `submitted` and the launch may have ended.

#### Scenario: Usage posted after the token stopped working
- **WHEN** worker `w1` submits its claimed launch, the launch ends, a report with the old token answers 401, and `w1` posts usage without any token
- **THEN** the usage post answers 200 with `recorded: true`

### Requirement: Worker usage: accepted launches
The daemon SHALL accept a worker usage post only for a launch that has a `worker` whose id equals `workerId`, has no pid, and is `live` or `ended`. Any other launch, including any launch with a pid, SHALL be refused with 409 and nothing recorded. A spawned launch's usage comes only from its runner.

#### Scenario: Usage for a launch no worker holds
- **WHEN** a worker posts usage for a launch that has no `worker`, such as one still `claimable`
- **THEN** the answer is 409 saying the launch is not a claimed launch and its runner reports its usage, and no usage is recorded

### Requirement: Worker usage: recording
When the launch already has usage, a worker usage post SHALL be a no-op answered 200 with `recorded: false`. Otherwise the daemon SHALL store the usage with `source: 'worker'` as health-monitoring "Usage accounting" states, pricing tokens without a cost with the posted `model` or else the launch's model, and SHALL answer 200 with `recorded: true` and the cost when known. Self-reported usage is not authoritative; its provenance keeps it distinguishable.

#### Scenario: Answer carries the priced cost
- **WHEN** `budgets.prices` has `claude-opus-5-5` at 100 USD input and 1000 USD output per million tokens and `w1` posts 40361 input and 260 output tokens with `model: claude-opus-5-5` and no cost
- **THEN** the answer is 200 with `recorded: true` and `costUsd` 4.2961

### Requirement: Lease expiry: kept release
With progress and `interruptions` under `daemon.maxKeptReleases` (0: unlimited), the lease expiry of a `running` claimed launch SHALL be a kept release: the branch is kept with uncommitted tracked and staged work committed on it, the task is `unstarted` with `attempts` unchanged, and `carry.interrupted` has `reason: "leaseExpired"`.

#### Scenario: Kept release carries the expiry reason
- **WHEN** a claimed launch whose worktree head moved past the base sha falls silent past the TTL with `daemon.maxKeptReleases` not reached
- **THEN** the task's `attempts` stays 0 and `interruptions` becomes 1, and the next launch's brief carries `interrupted` with `priorBranch` the launch's branch, `headSha` the head and `reason` `leaseExpired`

### Requirement: Lease expiry: failed work-in-progress commit
When the work-in-progress commit of a lease expiry fails (another process holds the index lock, say), the orchestrator SHALL read the worktree head instead: a head that is not the base sha SHALL still make the expiry a kept release at that head, without `wipCommit`; a head at the base sha SHALL make it a failed attempt.

#### Scenario: The work-in-progress commit fails on a branch without commits
- **WHEN** a claimed launch has only uncommitted changes, its head is the base sha, and `index.lock` is held when its lease expires
- **THEN** the launch ends with `leaseExpired` and the attempt is spent

### Requirement: Lease expiry: remote branch tip
A remote launch's expiry SHALL NOT check a worktree, preserve or remove anything: the orchestrator SHALL read the launch branch tip at origin (`ls-remote`). A tip other than the base sha, with `interruptions` under `daemon.maxKeptReleases`, SHALL make the expiry a kept release at that tip with reason `leaseExpired` and no `wipCommit`; no branch, or a tip at the base sha, SHALL make it a failed attempt with reason `leaseExpired`.

#### Scenario: Remote expiry touches no worktree
- **WHEN** a remote launch pushed its branch one commit ahead of the base and its lease expires
- **THEN** the expiry is a kept release at the pushed tip, and the workspace's `preserve` and `remove` are not called

### Requirement: Lease expiry: tick does not wait for origin
The tick SHALL NOT wait for the read of a remote launch's branch tip at origin beyond the short bound of integration-pipeline "The tick never waits for origin", and not at all while another remote command is queued or running; startup recovery SHALL await it in full.

#### Scenario: Busy origin does not hold the tick
- **WHEN** a remote launch pushed its branch one commit ahead of the base, and another remote command holds origin's queue when its lease expires
- **THEN** the expiry returns `skipped` in under a second with the launch still live, and once the queue is free a later expiry is a kept release at the pushed tip

### Requirement: Lease expiry: origin not read
When origin cannot be read, or the tick's read of the branch tip is still running, a remote launch's lease expiry SHALL be left for a later tick, with the launch live, until twice the lease TTL has passed since the lease was last renewed (its expiry time plus one TTL); then the attempt SHALL fail with `leaseExpired`.

#### Scenario: Expiry skipped while the read runs
- **WHEN** a remote launch's lease expires while the tick's read of its branch tip waits behind another remote command
- **THEN** the expiry is skipped, the launch stays live and the attempt is not spent

### Requirement: Lease expiry: read belongs to one expiry
A read of the branch tip that the tick started SHALL be used only for the lease expiry it was started for (the lease's expiry time when it started): once the lease is renewed (by a worker call or after a gap in the daemon's clock), the next expiry SHALL drop that read and start a new one, so it decides on the tip at origin after the renewal. When a launch ends, for any reason, the orchestrator SHALL drop its read of the branch tip.

#### Scenario: An accepted submit drops the read
- **WHEN** a remote launch's expiry left a read of its branch tip, the worker renews its lease, pushes and submits, and the submit is accepted
- **THEN** once the launch has ended the orchestrator holds no read of that branch tip

### Requirement: Silence limit in the claim: work loop limit
A work loop without `--max-silence-ms` SHALL take the claim's `health.stuckFailAfterMs` as its first silence limit when it is positive, and SHALL then follow `budgets.stuckFailAfterMs` from `GET /v1/status` as host-integration "Work loop silence limit" states; when the value is 0 (the daemon never fails a stuck launch) the loop SHALL keep its own default, so a hung agent whose lease the loop renews is still bounded.

#### Scenario: A zero limit in the claim keeps the loop's default
- **WHEN** a work loop without `--max-silence-ms` claims a launch whose claim has `health: { stuckFailAfterMs: 0 }`
- **THEN** its silence limit is its own default of 45 minutes

### Requirement: Lease renewal after a gap: renewal is not progress
The lease renewal at a write of gaps SHALL NOT be a progress signal: it SHALL leave `progressAt`, `lastSignal`, `progressText` and `stuckSince` unchanged and SHALL append no `launch.unstuck` and no `launch.notice`. The renewal excepts pull-runner "Lease renewal by the work loop" scenario "Renewal stops" and health-monitoring "Process liveness" scenario "Unknown liveness falls back to the lease": a gap after the last contact lengthens the time to expiry by up to the gap plus a TTL.

#### Scenario: A stuck launch stays stuck across a gap
- **WHEN** a launch is flagged stuck, the machine then sleeps for twice `health.stuckFailAfterMs`, and the next tick writes the gap
- **THEN** the launch is live with `stuckSince`, `progressAt` and `lastSignal` unchanged, and no `launch.unstuck` and no new `launch.notice` are appended

### Requirement: Lease renewal after a gap: gaps written before the lease test
The tick SHALL write pending gaps before it tests any lease against the clock it reads in the reconcile phase, and the lease-expiry test of a claimed launch SHALL note the clock and write pending gaps before each test, so no lease is expired while a noted gap is unwritten.

#### Scenario: The lease-expiry test notes the clock
- **WHEN** a claimed launch's lease is past its expiry against the clock the reconcile phase read, and the machine slept after that read in a gap not yet written
- **THEN** the lease-expiry test notes the clock and writes the gap before it tests, which renews the lease, so the expiry is skipped and the launch stays live with `attempts` unchanged

### Requirement: Prepare failure limit: counted failures
A failure SHALL be counted only when the task still runs on the failed launch; a cancel, a cascade reset, a stop or a crash during a command counts nothing, and a failure whose run overlapped a machine sleep counts like any other.

#### Scenario: A cancel during a command counts nothing
- **WHEN** a task with one counted failure is cancelled while its next launch's prepare command runs, and the command then exits 1
- **THEN** the launch ends `cancelled`, no further `launch.prepareFailed` is appended, and the task's entry still holds `failures` 1

### Requirement: Prepare failure limit: retry backoff
Below `prepareFailureLimit` (a top-level file key read at start, positive integer, default 3) the task SHALL return to `unstarted` as "Prepare failure" says, and SHALL be admitted again only at `retryAt`: the failure time plus `prepareRetryBackoffMs` (a top-level file key read at start, non-negative integer, default 30000) times 2 to the power of the earlier failures, the factor capped at 32. The wait for `retryAt` SHALL count wall time and SHALL go on during a pause.

#### Scenario: Limit and backoff keys
- **WHEN** the configuration sets `prepareFailureLimit` to 0 or `prepareRetryBackoffMs` to -1, or sets neither
- **THEN** the first two are refused, and with neither set the limit is 3 and the backoff 30000

### Requirement: Prepare failure limit: waiting task
A task before its `retryAt` SHALL NOT be a candidate for admission and SHALL hold no capacity slot. Nothing wakes the loop at `retryAt`: the task is admitted on the first tick at or after it.

#### Scenario: Admitted on the first tick at retryAt
- **WHEN** a task's first prepare failure set `retryAt`, ticks run before it, and a tick then runs at `retryAt`
- **THEN** no launch is created for the task before `retryAt` and it stays `unstarted`, and the tick at `retryAt` creates its next launch

### Requirement: Prepare failure limit: block at the limit
When `failures` reaches `prepareFailureLimit` the orchestrator SHALL apply `running -> blocked` with trigger `prepareFailed` and reason kind `prepareFailed`, attempts and carry unchanged, and remove the task's entry. The message SHALL be `` prepare command `<command>` failed <n> times in a row; last: <reason> `` and SHALL carry no command output; the output stays in `launch.prepareFailed` and the daemon log.

#### Scenario: Block message without output
- **WHEN** the prepare command `install` prints `boom` and exits 1 for the third time in a row under the defaults
- **THEN** the task's block message is `` prepare command `install` failed 3 times in a row; last: exit 1 `` and does not hold `boom`, the transition has trigger `prepareFailed`, and the last `launch.prepareFailed` output holds `boom`

### Requirement: Prepare failure limit: event fields
`launch.prepareFailed` SHALL carry `failures` and `limit` when the failure is counted, and `retryAt` when the task is not blocked.

#### Scenario: Event of a failure under backoff 0
- **WHEN** `prepareRetryBackoffMs` is 0 and a task's first prepare failure is applied
- **THEN** `launch.prepareFailed` carries `failures` 1 and `retryAt` the failure time itself

### Requirement: Prepare failure limit: entry removal
The entry of a task SHALL be removed when its prepare command succeeds (in the transaction that appends `launch.prepared`), when it is blocked at the limit, and by every transition of it with trigger `unblock`, `reopen`, `uncancel` or `cascade`. A cancel alone SHALL leave the task's entry; the uncancel removes it. The store has no kv delete: an emptied object is stored as `''`, which reads as no entries.

#### Scenario: Reset by an unblock
- **WHEN** a task blocked at the limit is unblocked, launched again, and its command fails
- **THEN** that failure has `failures` 1

### Requirement: Prepare failure limit: entry kept by the cascade
A task the cascade does not reset, such as an `unstarted` dependent of the reopened task, SHALL keep its prepare retry entry.

#### Scenario: An unstarted task waiting out a retry keeps its entry
- **WHEN** a task with one counted failure is `unstarted` waiting out its retry and a task it depends on is reopened with cascade
- **THEN** after the next tick the waiting task's entry still holds `failures` 1

### Requirement: Prepare failure limit: idle exit
Per operator-control "Idle exit", a retry entry whose id is a task node of the loaded graph that is `unstarted` SHALL keep the daemon from being quiescent, whatever its `retryAt` says. An entry for an id that is not a task node of the loaded graph SHALL NOT.

#### Scenario: An entry naming no task of the graph
- **WHEN** the only task of the graph is cancelled and `prepareRetry` holds an entry for an id `ZZ` that is no task of the graph
- **THEN** the daemon is quiescent

### Requirement: Prepare failure limit: no prepare command
With `prepareCommand` unset the prepare retry entry SHALL never be read or written.

#### Scenario: No entry without a prepare command
- **WHEN** `prepareCommand` is unset, one task is done and another is cancelled and reopened
- **THEN** the store holds no `prepareRetry` key

### Requirement: Remote run requirements: configuration in force
The `apiBaseUrl` and commit policy conditions of a remote run SHALL be checked against the configuration in force, overrides included, and named in the same message as the others.

#### Scenario: One message names every unmet condition
- **WHEN** a remote run starts in `spawn` mode with no `apiBaseUrl`
- **THEN** startup fails with one message beginning `runner.access remote refused:` that names both `runner.mode must be pull, not spawn` and `apiBaseUrl must be set`, the conditions separated by `; `

### Requirement: Remote run requirements: admission block
On a remote run, admission SHALL block a task whose runner kind (its `runner` selector, else the kind in force) has commit policy `daemon` with reason kind `remoteNeedsAgentCommit`, before brief validation and without creating a launch.

#### Scenario: Admission block names the fix
- **WHEN** a remote run whose default kind is `claude-code` admits a task with the selector `runner: codex` and `runner.codex.commit` unset
- **THEN** the block message says runner kind `codex` has commit policy daemon and names `runner.codex.commit` to set to agent, and no launch is created
