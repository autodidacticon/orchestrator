## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. In `pull-runner`, 12 of the 26 requirements are over the limit. This change splits 7 of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. The other 5 (Runner modes, Claim, Worker identity, Release, Access modes) are split by `openspec-2-pull-runner-1`, which touches none of the requirements this change touches. It is part of the OpenSpec 2.1 migration (#139, task #176).

## What Changes

- Seven requirements are MODIFIED. Each keeps its header and every scenario, with names and text unchanged, and its description is cut to one behavior of at most 500 characters:

  | Requirement | Before | After | Scenarios kept | ADDED from it |
  |---|---|---|---|---|
  | Session attachments | 613 | 438 | 2 | 2 |
  | Worker usage | 1398 | 444 | 5 | 3 |
  | Lease expiry | 2442 | 477 | 9 | 6 |
  | Silence limit in the claim | 521 | 136 | 1 | 1 |
  | Lease renewal after a gap | 972 | 244 | 3 | 2 |
  | Prepare failure limit | 2614 | 348 | 9 | 9 |
  | Remote run requirements | 767 | 395 | 3 | 2 |

- 25 requirements are ADDED, one for each behavior moved out of those descriptions. Each name starts with the name of the MODIFIED requirement its text comes from, followed by a colon, and `pull-runner` has no requirement of that name at the base commit 3c9c12b. Each has a description of at most 500 characters (the longest is 485) that holds SHALL or MUST, and one scenario of its own with a WHEN and a THEN step. Each scenario states behavior the code has at the base commit; the file (and test) that shows it is named under "Where each new scenario comes from".
- No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped or weakened. The 7 original descriptions hold 64. The cut descriptions hold 12 and the ADDED descriptions 52, 64 in all.
- Requirements under 500 characters, and the 5 long requirements left to `openspec-2-pull-runner-1`, are not touched. Nothing outside this change directory changes.

### Splits, lead-ins and SHALL at a joint

No sentence of the 7 original descriptions is longer than 500 characters on its own (the longest, "Worker usage" s1 and "Prepare failure limit" s4, are 400 and 395), so no sentence is split, no lead-in is repeated or added, and no SHALL is given at a joint.

Six sentences have no SHALL or MUST of their own. Each moves with, or stays beside, a SHALL sentence of its requirement:

- "Worker usage" s5 ("A spawned launch's usage comes only from its runner.") moves with s3 and s4 to "Worker usage: accepted launches".
- "Worker usage" s9 ("Self-reported usage is not authoritative; ...") moves with s7 and s8 to "Worker usage: recording".
- "Lease expiry" s5 ("A release with `keep` is unaffected: it commits untracked files too.") stays in the MODIFIED description with s2, the untracked-file rule it qualifies.
- "Lease renewal after a gap" s4 ("This excepts ...") moves with s2 to "Lease renewal after a gap: renewal is not progress". It cannot stay beside s1 (244 + 263 characters is over 500) nor join s3 (273 + 263), so it goes with s2 and its "This" is made explicit as "The renewal", that requirement's subject.
- "Prepare failure limit" s7 ("Nothing wakes the loop at `retryAt`: ...") moves with s6 to "Prepare failure limit: waiting task", and s14 ("The store has no kv delete: ...") with s11 and s12 to "Prepare failure limit: entry removal".

"Prepare failure limit" s16 ("An entry for an id that is not a task node of the loaded graph SHALL NOT.") moves unchanged with s15, whose verb it elides, to "Prepare failure limit: idle exit".

### Moved sentences

Sentences are numbered from 1 in each original description, across its paragraphs. For each MODIFIED requirement, the sentences that stay are named, then each sentence that moved, with its text at the base and the ADDED requirement that now holds it. A sentence marked "reference made explicit" changes only the words named.

### Session attachments

Stays in the MODIFIED description: s1, s2.

- s3 "A claim without an attachment SHALL be governed by its lease alone, as before." → "Session attachments: unattached claim" (unchanged)
- s4 "A kept release SHALL end the launch, so the former worker's token SHALL no longer authenticate." → "Session attachments: kept release ends the launch" (unchanged)

### Worker usage

Stays in the MODIFIED description: s1, s6.

- s2 "The route SHALL be identified by the body like `/v1/claims` and the release route and SHALL NOT need the launch token, because by the time the worker has the usage the task is `submitted` and the launch may have ended." → "Worker usage: route without the launch token" (reference made explicit: "The route" -> "The worker usage route `POST /v1/launches/:id/usage`")
- s3 "The daemon SHALL accept the post only for a launch that has a `worker` whose id equals `workerId`, has no pid, and is `live` or `ended`." → "Worker usage: accepted launches" (reference made explicit: "the post" -> "a worker usage post")
- s4 "Any other launch, including any launch with a pid, SHALL be refused with 409 and nothing recorded." → "Worker usage: accepted launches" (unchanged)
- s5 "A spawned launch's usage comes only from its runner." → "Worker usage: accepted launches" (unchanged)
- s7 "When the launch already has usage, the post SHALL be a no-op answered 200 with `recorded: false`." → "Worker usage: recording" (reference made explicit: "the post" -> "a worker usage post")
- s8 "Otherwise the daemon SHALL store the usage with `source: 'worker'` as health-monitoring "Usage accounting" states, pricing tokens without a cost with the posted `model` or else the launch's model, and SHALL answer 200 with `recorded: true` and the cost when known." → "Worker usage: recording" (unchanged)
- s9 "Self-reported usage is not authoritative; its provenance keeps it distinguishable." → "Worker usage: recording" (unchanged)

### Lease expiry

Stays in the MODIFIED description: s1, s2, s5.

- s3 "With progress and `interruptions` under `daemon.maxKeptReleases` (0: unlimited), the expiry SHALL be a kept release: the branch is kept with uncommitted tracked and staged work committed on it, the task is `unstarted` with `attempts` unchanged, and `carry.interrupted` has `reason: "leaseExpired"`." → "Lease expiry: kept release" (reference made explicit: "the expiry" -> "the lease expiry of a `running` claimed launch")
- s4 "When the work-in-progress commit fails (another process holds the index lock, say), the orchestrator SHALL read the worktree head instead: a head that is not the base sha SHALL still make the expiry a kept release at that head, without `wipCommit`; a head at the base sha SHALL make it a failed attempt." → "Lease expiry: failed work-in-progress commit" (reference made explicit: "the work-in-progress commit" -> "the work-in-progress commit of a lease expiry")
- s6 "A remote launch's expiry SHALL NOT check a worktree, preserve or remove anything: the orchestrator SHALL read the launch branch tip at origin (`ls-remote`)." → "Lease expiry: remote branch tip" (unchanged)
- s7 "A tip other than the base sha, with `interruptions` under the bound, SHALL make the expiry a kept release at that tip with reason `leaseExpired` and no `wipCommit`; no branch, or a tip at the base sha, SHALL make it a failed attempt with reason `leaseExpired`." → "Lease expiry: remote branch tip" (reference made explicit: "the bound" -> "`daemon.maxKeptReleases`")
- s8 "The tick SHALL NOT wait for this read beyond the short bound of integration-pipeline "The tick never waits for origin", and not at all while another remote command is queued or running; startup recovery SHALL await it in full." → "Lease expiry: tick does not wait for origin" (reference made explicit: "this read" -> "the read of a remote launch's branch tip at origin")
- s9 "When origin cannot be read, or the tick's read is still running, the expiry SHALL be left for a later tick, with the launch live, until twice the lease TTL has passed since the lease was last renewed (its expiry time plus one TTL); then the attempt SHALL fail with `leaseExpired`." → "Lease expiry: origin not read" (references made explicit: "the tick's read" -> "the tick's read of the branch tip", "the expiry" -> "a remote launch's lease expiry")
- s10 "A read of the branch tip that the tick started SHALL be used only for the lease expiry it was started for (the lease's expiry time when it started): once the lease is renewed (by a worker call or after a gap in the daemon's clock), the next expiry SHALL drop that read and start a new one, so it decides on the tip at origin after the renewal." → "Lease expiry: read belongs to one expiry" (unchanged)
- s11 "When a launch ends, for any reason, the orchestrator SHALL drop its read of the branch tip." → "Lease expiry: read belongs to one expiry" (unchanged)

### Silence limit in the claim

Stays in the MODIFIED description: s1.

- s2 "A work loop without `--max-silence-ms` SHALL take it as its first silence limit when it is positive, and SHALL then follow `budgets.stuckFailAfterMs` from `GET /v1/status` as host-integration "Work loop silence limit" states; when the value is 0 (the daemon never fails a stuck launch) the loop SHALL keep its own default, so a hung agent whose lease the loop renews is still bounded." → "Silence limit in the claim: work loop limit" (reference made explicit: "it" -> "the claim's `health.stuckFailAfterMs`")

### Lease renewal after a gap

Stays in the MODIFIED description: s1.

- s2 "The renewal SHALL NOT be a progress signal: it SHALL leave `progressAt`, `lastSignal`, `progressText` and `stuckSince` unchanged and SHALL append no `launch.unstuck` and no `launch.notice`." → "Lease renewal after a gap: renewal is not progress" (reference made explicit: "The renewal" -> "The lease renewal at a write of gaps")
- s4 "This excepts pull-runner "Lease renewal by the work loop" scenario "Renewal stops" and health-monitoring "Process liveness" scenario "Unknown liveness falls back to the lease": a gap after the last contact lengthens the time to expiry by up to the gap plus a TTL." → "Lease renewal after a gap: renewal is not progress" (reference made explicit: "This" -> "The renewal")
- s3 "The tick SHALL write pending gaps before it tests any lease against the clock it reads in the reconcile phase, and the lease-expiry test of a claimed launch SHALL note the clock and write pending gaps before each test, so no lease is expired while a noted gap is unwritten." → "Lease renewal after a gap: gaps written before the lease test" (unchanged)

### Prepare failure limit

Stays in the MODIFIED description: s1, s3.

- s2 "A failure SHALL be counted only when the task still runs on the failed launch; a cancel, a cascade reset, a stop or a crash during a command counts nothing, and a failure whose run overlapped a machine sleep counts like any other." → "Prepare failure limit: counted failures" (unchanged)
- s4 "Below `prepareFailureLimit` (a top-level file key read at start, positive integer, default 3) the task SHALL return to `unstarted` as "Prepare failure" says, and SHALL be admitted again only at `retryAt`: the failure time plus `prepareRetryBackoffMs` (a top-level file key read at start, non-negative integer, default 30000) times 2 to the power of the earlier failures, the factor capped at 32." → "Prepare failure limit: retry backoff" (unchanged)
- s5 "The wait SHALL count wall time and SHALL go on during a pause." → "Prepare failure limit: retry backoff" (reference made explicit: "The wait" -> "The wait for `retryAt`")
- s6 "A task before its `retryAt` SHALL NOT be a candidate for admission and SHALL hold no capacity slot." → "Prepare failure limit: waiting task" (unchanged)
- s7 "Nothing wakes the loop at `retryAt`: the task is admitted on the first tick at or after it." → "Prepare failure limit: waiting task" (unchanged)
- s8 "When `failures` reaches `prepareFailureLimit` the orchestrator SHALL apply `running -> blocked` with trigger `prepareFailed` and reason kind `prepareFailed`, attempts and carry unchanged, and remove the task's entry." → "Prepare failure limit: block at the limit" (unchanged)
- s9 "The message SHALL be `` prepare command `<command>` failed <n> times in a row; last: <reason> `` and SHALL carry no command output; the output stays in `launch.prepareFailed` and the daemon log." → "Prepare failure limit: block at the limit" (unchanged)
- s10 "`launch.prepareFailed` SHALL carry `failures` and `limit` when the failure is counted, and `retryAt` when the task is not blocked." → "Prepare failure limit: event fields" (unchanged)
- s11 "The entry of a task SHALL be removed when its prepare command succeeds (in the transaction that appends `launch.prepared`), when it is blocked at the limit, and by every transition of it with trigger `unblock`, `reopen`, `uncancel` or `cascade`." → "Prepare failure limit: entry removal" (unchanged)
- s12 "A cancel alone SHALL leave it; the uncancel removes it." → "Prepare failure limit: entry removal" (reference made explicit: "it" -> "the task's entry")
- s14 "The store has no kv delete: an emptied object is stored as `''`, which reads as no entries." → "Prepare failure limit: entry removal" (unchanged)
- s13 "A task the cascade does not reset, such as an `unstarted` dependent of the reopened task, SHALL keep its entry." → "Prepare failure limit: entry kept by the cascade" (reference made explicit: "its entry" -> "its prepare retry entry")
- s15 "Per operator-control "Idle exit", a retry entry whose id is a task node of the loaded graph that is `unstarted` SHALL keep the daemon from being quiescent, whatever its `retryAt` says." → "Prepare failure limit: idle exit" (unchanged)
- s16 "An entry for an id that is not a task node of the loaded graph SHALL NOT." → "Prepare failure limit: idle exit" (unchanged)
- s17 "With `prepareCommand` unset the entry SHALL never be read or written." → "Prepare failure limit: no prepare command" (reference made explicit: "the entry" -> "the prepare retry entry")

### Remote run requirements

Stays in the MODIFIED description: s1.

- s2 "These conditions SHALL be checked against the configuration in force, overrides included, and named in the same message as the others." → "Remote run requirements: configuration in force" (reference made explicit: "These conditions" -> "The `apiBaseUrl` and commit policy conditions of a remote run")
- s3 "On a remote run, admission SHALL block a task whose runner kind (its `runner` selector, else the kind in force) has commit policy `daemon` with reason kind `remoteNeedsAgentCommit`, before brief validation and without creating a launch." → "Remote run requirements: admission block" (unchanged)

### Where each new scenario comes from

At the base commit 3c9c12b:

- "An ended attachment leaves an unattached claim alone": `src/loop/orchestrator.ts` (`sweepAttachments` releases only the live launches whose `worker.attachment` is the ended attachment's id), `test/slice/claim.test.ts` ("a dead or ended attachment releases its launches with keep, matched by any pid in its chain").
- "Old token refused after a kept release": `test/slice/claim.test.ts` ("a kept release preserves uncommitted work on the branch and briefs the next claim with it": the worker commits, the release answers `outcome: 'unstarted'`, `kept: true`, and the heartbeat with the old token answers 401).
- "Usage posted after the token stopped working": `test/slice/claim.test.ts` ("a worker posts usage for its claimed launch after submit, ...": a report with the old token answers 401, and the usage post without a token answers 200 with `recorded: true`); `src/operator/routes.ts` (the usage route reads no authorization header).
- "Usage for a launch no worker holds": `src/loop/orchestrator.ts` (`recordWorkerUsage` answers 409 `launch <id> is not a claimed launch; its runner reports its usage` for a launch with a pid or without a `worker`, before anything is stored).
- "Answer carries the priced cost": `test/slice/claim.test.ts` ("a worker posts usage for its claimed launch after submit, ...": the answer is `{ status: 200, body: { ok: true, recorded: true, costUsd: 4.2961 } }`).
- "Kept release carries the expiry reason": `test/loop/lease.test.ts` ("an expiry with a commit since the claim is a kept release: ...": `attempts` 0, `interruptions` 1, the next brief's `carry.interrupted` with `priorBranch`, `headSha` and `reason: 'leaseExpired'`).
- "The work-in-progress commit fails on a branch without commits": `test/loop/lease.test.ts` ("a failed work-in-progress commit on a branch without commits spends the attempt").
- "Remote expiry touches no worktree": `test/slice/remote-release.test.ts` ("a branch pushed one commit ahead of base is a kept release at the pushed tip; ...": `counts.preserve` and `counts.remove` are 0).
- "Busy origin does not hold the tick": `test/slice/remote-release.test.ts` ("while origin is busy the expiry is skipped without waiting, and a later tick takes the tip": `expireClaim` returns `skipped` in under 900 ms).
- "Expiry skipped while the read runs": `test/slice/remote-release.test.ts` (the same test and `expiryLeavesRead`: with origin's queue held the expiry is `skipped`, the read is held in `tipReads`, and the launch is live).
- "An accepted submit drops the read": `test/slice/remote-release.test.ts` ("a launch that ends by an accepted submit drops its read").
- "A zero limit in the claim keeps the loop's default": `test/host/work-loop.test.ts` ("the silence limit: --max-silence-ms, else the claim, else 45 minutes; 0 is off": `silenceLimitMs(undefined, { health: { stuckFailAfterMs: 0 } })` is `DEFAULT_MAX_SILENCE_MS`).
- "A stuck launch stays stuck across a gap": `test/loop/gap.test.ts` ("a launch flagged stuck before the sleep stays flagged, and writing the gap appends no unstuck and no notice").
- "The lease-expiry test notes the clock": `src/loop/tick.ts` (`reconcile` calls `expireClaim` for a claimed launch whose lease is past `expiresAt` against the `now` it read), `src/loop/orchestrator.ts` (`expireClaim`'s `expired()` calls `noteClock()` and `recordGaps()`, whose write renews the lease, before it compares the lease with `now()`, and `expireClaim` returns `skipped` when the lease is no longer expired).
- "A cancel during a command counts nothing": `test/loop/prepare-failure.test.ts` ("a cancel during a command counts nothing").
- "Limit and backoff keys": `test/loop/prepare-failure.test.ts` ("the keys: limit 1 blocks at once, backoff 0 relaunches in the same tick, bad values are rejected").
- "Admitted on the first tick at retryAt": `test/loop/prepare-failure.test.ts` ("backoff: no launch before retryAt, one at retryAt, then 60000").
- "Block message without output": `test/loop/prepare-failure.test.ts` ("block at the limit: the third failure blocks as prepareFailed with no output; ...": the command `install`, output `npm ERR! boom`, the message, the transition's trigger, and the event's `output`).
- "Event of a failure under backoff 0": `test/loop/prepare-failure.test.ts` ("the keys: ...": with `prepareRetryBackoffMs: 0` the event has `failures: 1, retryAt` the clock).
- "Reset by an unblock": `test/loop/prepare-failure.test.ts` ("block at the limit: ...; unblock starts the count again").
- "An unstarted task waiting out a retry keeps its entry": `test/loop/prepare-failure.test.ts` ("cascade: a task reset by the cascade loses its entry; an unstarted one waiting out a retry keeps it").
- "An entry naming no task of the graph": `test/loop/prepare-failure.test.ts` ("activity: an entry of an unstarted task keeps the daemon from being quiescent": the `ZZ` entry).
- "No entry without a prepare command": `test/loop/prepare-failure.test.ts` ("with no prepareCommand the retry entry is never written").
- "One message names every unmet condition": `src/config.ts` (`remoteAccessProblems` lists `runner.mode must be pull, not <mode>` and `apiBaseUrl must be set ...`; `remoteAccessError` joins them with `; ` after `runner.access remote refused: `), `src/loop/orchestrator.ts` (`start` checks the kind and mode in force), `test/slice/remote-access.test.ts` ("names each unmet condition at once": one message, the conditions separated by `; `).
- "Admission block names the fix": `src/loop/tick.ts` (the `remoteNeedsAgentCommit` message `runner kind <kind> has commit policy daemon, ... set runner.<kind>.commit to agent ...`), `test/loop/remote-brief.test.ts` ("a task labelled runner:codex on a remote claude-code run is blocked at admission with remoteNeedsAgentCommit and gets no launch").

## Capabilities

### New Capabilities

### Modified Capabilities

- `pull-runner`: "Session attachments", "Worker usage", "Lease expiry", "Silence limit in the claim", "Lease renewal after a gap", "Prepare failure limit" and "Remote run requirements" have their descriptions cut to one behavior each; the moved behaviors become 25 ADDED requirements. What the spec requires is unchanged.

## Impact

Only `openspec/changes/openspec-2-pull-runner-2/`. No code changes.
