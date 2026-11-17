# Integration Pipeline Specification

## Purpose
Repository layout, one worktree per launch, the serialized verifier job pipeline (rebase, check, squash with trailers), compare-and-swap publication, conflict handling, foreign-commit detection, and milestone tagging, with the rebase replaying only the commits after the merge base of the integration head and the sealed sha and the published outcome recording the files it changed, where a reopen never rewrites the integration branch and a revision of a reopened task lands as one further trailer commit on top of its prior one.
## Requirements
### Requirement: Repository layout
The orchestrator SHALL manage one repository per instance. Its primary clone SHALL keep the integration branch checked out and SHALL never be used for work. Each launch SHALL get its own worktree from the shared object store, in a directory named by the launch id, on the branch `task/<id>/l<launches>`. The worktree SHALL be removed after the launch ends and the branch SHALL be retained. With `git.pushIntegration` on, the clone SHALL have a remote `origin` whose integration branch is the source of truth (see "Origin as source of truth"); the clone's integration branch SHALL follow it and SHALL never hold a commit origin lacks except between a local compare-and-swap and its push.

#### Scenario: Agent cannot check out the integration branch
- **WHEN** an agent runs `git checkout main` inside its worktree
- **THEN** git refuses because the branch is checked out in the primary clone

#### Scenario: Worktree removed, branch kept
- **WHEN** a launch ends for any reason
- **THEN** its worktree directory no longer exists and its branch still does

### Requirement: Base selection
A launch SHALL start from the integration head observed at claim time, recorded as `baseSha` in the lease and stated in the brief. Because every dependency is `done` before a task is ready, the base MUST already contain the dependencies' published work. With `git.pushIntegration` on, the integration head SHALL be read from `refs/remotes/origin/<branch>`, fetched at most once per `git.fetchIntervalMs`, with a failed fetch keeping the last observed head; while the clone's branch is strictly ahead of origin's, the clone's head SHALL be used instead.

#### Scenario: Base contains dependencies
- **WHEN** T2 is launched after T1 was published
- **THEN** T2's `baseSha` is at or after T1's published commit

#### Scenario: Base follows origin
- **WHEN** a person pushes commit H to origin's integration branch while pushing is on
- **THEN** the next observed integration head is H

### Requirement: Verifier serialization and job states
The verifier SHALL process `submitted` tasks one at a time in submission order as durable jobs with states `queued`, `checking`, `verified`, `publishing`, `published`, `failed`, and `conflict`.

#### Scenario: Jobs are serialized
- **WHEN** two tasks are submitted within the same tick
- **THEN** the second job does not start until the first reaches a terminal state

### Requirement: Rebase and conflict handling
The verifier SHALL create a temporary worktree at the current integration head and rebase `sealedSha` onto it. On conflict the job SHALL end as `conflict`, `integrationRetries` SHALL increase, and while below the cap (default 3) the task SHALL return to `unstarted` with context naming the conflicting files, the tasks published since `baseSha`, and the previous branch; at the cap the task SHALL become `failed` with reason `integrationCapExceeded`.

#### Scenario: First conflict retries with context
- **WHEN** T2 and T3 both modify `shared.ts`, T3 is published first, and T2's rebase conflicts
- **THEN** T2 is `unstarted` with `integrationRetries` 1 and its next brief names `shared.ts`, T3, and branch `task/T2/l1`

#### Scenario: Cap exhausted
- **WHEN** a task conflicts for the fourth time with the cap at 3
- **THEN** the task is `failed` with reason `integrationCapExceeded`

### Requirement: Check and verified tree
The verifier SHALL run the effective check command, read when the job starts checking, with a timeout on the rebased tree and SHALL record the rebased head as `verifiedSha`. A non-zero exit or a timeout SHALL fail the task with the command output attached and SHALL increase `attempts`. While `checkCommand` is unresolved, a `queued` job whose sealed sha differs from its base sha SHALL NOT start checking: it SHALL stay `queued` with its sealed sha, the task SHALL stay `submitted`, `status` and the digest SHALL name `checkCommand` under `needsConfig`, and the job SHALL start on the first tick after a check command is set. A `queued` job whose sealed sha equals its base sha, a declared no-op, SHALL NOT be held: the verifier never reaches the check step for it, so it SHALL verify and publish at once. A job already `checking` when the command changes SHALL finish with the command it started with. The check command SHALL apply in every runner mode.

#### Scenario: Red check fails with output
- **WHEN** the check command exits non-zero
- **THEN** the task is `failed` with the captured output and the next brief includes it

#### Scenario: Timeout is a failure
- **WHEN** the check command exceeds its timeout
- **THEN** it is killed and the task is `failed` with reason `checkTimeout`

#### Scenario: Unresolved command holds the job
- **WHEN** T1 is submitted while `checkCommand` is unresolved
- **THEN** T1's job stays `queued`, T1 stays `submitted`, no attempt is spent, and `needsConfig` names `checkCommand`

#### Scenario: Held job runs once the command is set
- **WHEN** the operator sets `checkCommand` to `npm test` while T1's job is held
- **THEN** the next tick runs `npm test` on T1's rebased tree and, when it passes, publishes T1's sealed work

#### Scenario: Declared no-op needs no command
- **WHEN** T1 is submitted with `noChanges` and no commits ahead of `baseSha` while `checkCommand` is unresolved
- **THEN** T1's job runs at once, publishes no commit, and T1 is `done` without any command being run

### Requirement: Squash with trailers
The verifier SHALL squash the rebased range into one commit whose tree is byte-identical to the verified tree and whose message is the report summary followed by the trailers `Orchestrator-Task: <id>` and `Orchestrator-Launch: <launchId>`.

#### Scenario: One commit per task
- **WHEN** a task with three commits on its branch is verified
- **THEN** the integration branch gains exactly one commit, its tree equals `verifiedSha`'s tree, and both trailers are present

### Requirement: Compare-and-swap publication
Publication SHALL update the integration ref with a compare-and-swap that expects the head observed when the job started. If the expected head no longer matches, the job SHALL return to `queued`. With `git.pushIntegration` on, the expected head SHALL be origin's head after the job's fetch, and after the local compare-and-swap the verifier SHALL push the squash commit with `--force-with-lease=refs/heads/<branch>:<expectedHead>`; a push that is rejected or fails SHALL undo the local compare-and-swap and return the job to `queued`, so the next run rebases onto origin's new head. `publishedSha` and the task's `done` transition SHALL be recorded in one transaction.

#### Scenario: Head moved during verification
- **WHEN** another publication lands while a job is checking
- **THEN** the compare-and-swap fails and the job is requeued from the rebase step

#### Scenario: Done and published together
- **WHEN** publication succeeds
- **THEN** the same transaction records `publishedSha` and sets the task `done`

#### Scenario: Origin moved before publication
- **WHEN** a person pushes commit H to origin after T1 is verified and squashed but before it is pushed
- **THEN** the push fails its lease, the job is requeued once, and T1 is then published as a child of H on origin and in the clone, with both commits kept

### Requirement: Foreign commit detection
A sweep SHALL flag any commit on the integration branch that lacks an `Orchestrator-Launch` trailer and SHALL report it in status. With `git.pushIntegration` on, commits that arrive on origin are expected: the sweep SHALL consider only commits on the clone's integration branch that `refs/remotes/origin/<branch>` lacks.

#### Scenario: Manual commit flagged
- **WHEN** a person commits directly to the integration branch
- **THEN** the next sweep reports that commit as foreign

#### Scenario: Human commit on origin is expected
- **WHEN** a person pushes a commit without trailers to origin while pushing is on
- **THEN** the sweep does not report it, and a trailer-less commit made only in the daemon's clone is reported

### Requirement: Milestone tagging
When a gated milestone becomes `submitted`, the orchestrator SHALL tag the pinned `integrationSha` as `milestone/<id>/v<reviewVersion>`. Tag creation SHALL be idempotent. With `git.pushIntegration` on, the tag SHALL also be pushed to origin without force. The push outcome SHALL be returned and never thrown, so neither the tick nor recovery fails on it. The local tag SHALL be recorded as `tagged:<id>:<version>` once it exists, and the push separately as `tagPushed:<id>:<version>`. A push that fails SHALL be retried on every tick for a gated milestone in `submitted` or `done` until it lands. A tag that origin holds at another sha SHALL never be moved: it SHALL be reported once as a `milestone.tagConflict` event and not retried.

#### Scenario: Tag at the pinned sha
- **WHEN** MVP is submitted for review version 2
- **THEN** the tag `milestone/MVP/v2` points at MVP's `integrationSha`

#### Scenario: Repeated tagging is harmless
- **WHEN** tagging is retried after a crash
- **THEN** the tag still points at the same sha and no error is raised

#### Scenario: Accepted milestone tag on origin
- **WHEN** MVP is accepted at review version 1 while pushing is on, including after a tag push that failed while origin was unreachable
- **THEN** origin's `milestone/MVP/v1` points at MVP's reviewed `integrationSha`

#### Scenario: Conflicting tag is never moved
- **WHEN** origin already holds `milestone/MVP/v1` at another sha
- **THEN** that tag is unchanged, one `milestone.tagConflict` event is recorded, and a restart neither fails nor records another

### Requirement: Rebase from the merge base
The verifier SHALL rebase onto the integration head only the commits after the merge base of the head and `sealedSha`, and SHALL record on its published outcome the files changed between the expected head and the rebased sha, so that a branch the agent rebased onto a newer head verifies without replaying published commits and the base-moved notice can list what moved.

#### Scenario: Rebased branch verifies
- **WHEN** an agent rebases its launch branch onto the integration head after a `baseMoved` notice, commits one more change, and submits
- **THEN** verification publishes exactly one trailer commit containing only the agent's changes

#### Scenario: Changed files recorded
- **WHEN** a task is published with a commit touching `src/a.ts` and `README.md`
- **THEN** the job records `changedFiles` `["README.md", "src/a.ts"]`

### Requirement: Reopen leaves the integration branch untouched
Reopen, uncancel, and cascade SHALL NOT update the integration ref, revert or remove any published commit, or delete any milestone tag. A reopened task's next launch SHALL start from the current integration head, which contains its prior published commit, and its next publication SHALL add one further squash commit carrying the same `Orchestrator-Task` trailer and the new launch's `Orchestrator-Launch` trailer. The one-commit-per-task expectation SHALL be read per published launch.

#### Scenario: Head unchanged by reopen
- **WHEN** T1 is published at head H and then reopened with cascade over T2 and MVP
- **THEN** the integration head is still H, every tag still exists, and no foreign commit is reported

#### Scenario: Revision adds a second trailer commit
- **WHEN** reopened T1 is published again
- **THEN** the integration branch carries two commits with trailer `Orchestrator-Task: T1`, each with a distinct `Orchestrator-Launch`, and the second has the first as an ancestor

### Requirement: Check environment
The check command SHALL run with the same environment isolation as a spawned agent: the daemon's environment with the git identity variables added, `ORCH_HOME` replaced by a directory inside the run's data directory, and `ORCH_URL`, `ORCH_REPO`, `ORCH_DATA_DIR` and `ORCH_RUN_ID` removed on every store kind. While the daemon withholds (specs/state-backend "Withholding follows the store": always on a Postgres store), `DATABASE_URL`, `DATABASE_URL_FILE`, every libpq connection variable named in `LIBPQ_VARS` and every variable whose value is the resolved store URL SHALL be removed too. While it does not withhold (a SQLite store with no Postgres input), they SHALL reach the check unchanged, so a project's check keeps its own database variables. Repository code run by the check SHALL NOT be able to discover or stop any daemon of the user's through the run directory layout. While the daemon withholds, it SHALL NOT be able to reach the orchestrator's state database through its environment. The check runs as the daemon's user, so it can still read what specs/state-backend "Store credentials a child can still reach" lists; this requirement does not cover that.

#### Scenario: Check sees an isolated home
- **WHEN** the check command is `echo "$ORCH_HOME" > home.txt && test -z "$ORCH_URL"`
- **THEN** the check passes and the recorded path is inside the run's data directory

#### Scenario: Check sees no store URL
- **WHEN** the check command is `env > check.env` on a daemon that withholds, whose environment holds `DATABASE_URL` and another variable set to the store URL, `DATABASE_URL_FILE`, and every name in `LIBPQ_VARS` with `PGPASSWORD` set
- **THEN** `check.env` has none of those variables, not the password and not the `PGPASSWORD` value, so check output stored in job rows cannot carry them

#### Scenario: Check on a SQLite run keeps the project's database variables
- **WHEN** the check command is `env > check.env` on a daemon with a SQLite store and no Postgres input, whose environment holds `DATABASE_URL`, `APP_DATABASE` set to the same value, `DATABASE_URL_FILE`, `PGHOST` and `PGPASSWORD`
- **THEN** `check.env` holds each of them with its value, has no `ORCH_URL` or `ORCH_RUN_ID` line, and its `ORCH_HOME` is inside the run directory

### Requirement: Origin as source of truth
The configuration block `git` SHALL hold `originUrl` (optional), `pushIntegration` (default `false`) and `fetchIntervalMs` (default 30000).

With `pushIntegration` off, no git command the orchestrator runs SHALL name or contact a remote.

With it on, the following SHALL hold:
- The remote `origin` of the daemon's clone SHALL be the source of truth for the integration branch. When `originUrl` is set, the remote SHALL be added or re-pointed to it before first use. When it is unset and the clone has no `origin`, every operation that needs origin SHALL fail naming the missing setting.
- All fetches and pushes of one daemon SHALL run one at a time. A fetch SHALL update `refs/remotes/origin/<branch>` only, without tags.
- Before a verifier job observes its expected head, the verifier SHALL fetch. A fetch that fails SHALL requeue the job without spending an attempt, and the `verify.requeued` event and the daemon log SHALL carry the reason.
- When the job's `Orchestrator-Launch` trailer is already on origin, the job SHALL be published at that commit without a further push. While a push of a squash is in flight, base selection SHALL NOT use that squash.
- Otherwise the verifier SHALL bring the clone's integration branch to origin's:
  - when the clone is behind, by a fast-forward that also updates the primary worktree;
  - when the clone is ahead or origin has no such branch, by pushing the clone's head with a lease;
  - when the two have diverged, the job SHALL fail with a message naming both shas and the clone SHALL NOT be reset.
- After a successful push, `refs/remotes/origin/<branch>` SHALL point at the pushed commit.

#### Scenario: Default contacts no remote
- **WHEN** a run with `git.pushIntegration` unset publishes a task and tags and accepts a gated milestone, in a clone whose `origin` transport records any contact
- **THEN** no contact is recorded

#### Scenario: Fresh clone matches
- **WHEN** three tasks are published with `git.pushIntegration` on against a bare origin
- **THEN** each task's trailer commit is on origin's integration branch, and a fresh clone of origin has the same first-parent history as the daemon's clone

#### Scenario: Earlier publications are pushed first
- **WHEN** pushing is turned on while the clone holds a published commit origin lacks
- **THEN** the next job pushes that commit before its own, and origin ends with both

#### Scenario: Diverged clone fails loudly
- **WHEN** the clone and origin each hold a commit the other lacks
- **THEN** the job fails naming both heads and the clone's branch is not moved

### Requirement: Durable publishing record
The verifier SHALL wait until its `publishing` record is durable before it moves the integration branch or pushes to origin. If the store goes fatal while waiting, neither effect SHALL happen and no outcome SHALL be recorded. Other progress records SHALL NOT wait. This narrows state-backend "Durability before effects": the wait on entry to `run` is not enough for the effects inside it.

#### Scenario: Sink stalls after the check started
- **WHEN** the sink stalls while a job's check runs, and the job records `publishing`
- **THEN** the integration branch and origin do not move until the sink accepts that record, and the job is then published

#### Scenario: Fatal while waiting
- **WHEN** the store goes fatal while the verifier waits for the `publishing` record
- **THEN** the integration branch and origin are unchanged, no outcome is recorded, and recovery at the next start decides the job from its last durable record

### Requirement: Remote commands are bounded
With `git.pushIntegration` on, every git command that talks to origin (fetch, push, `ls-remote`) SHALL run in its own process group. When it has not finished within `git.remoteTimeoutMs` (default 120000; 0 disables the bound), the whole group SHALL be killed. A killed command SHALL be reported as a failure that names the timeout, and SHALL count as an unreachable origin.

#### Scenario: A stalled push is killed
- **WHEN** origin accepts a push connection and never answers, and `git.remoteTimeoutMs` is 2000
- **THEN** after 2000 ms the push and the process origin started for it are killed, and the job is requeued with a reason that says the push timed out

#### Scenario: A stalled fetch fails
- **WHEN** a fetch does not answer within `git.remoteTimeoutMs`
- **THEN** it is killed and reported as a failed fetch, and origin's queue is free again

### Requirement: The tick never waits for origin
While a remote command is queued or running, the tick MUST NOT wait for it: base selection SHALL keep the last fetched head, and a milestone tag push SHALL be left for a later tick. A fetch or tag push the tick starts itself SHALL be awaited at most a short bound (1 s); it runs on, bounded by `git.remoteTimeoutMs`. Startup recovery SHALL await its fetch in full.

#### Scenario: The tick keeps running during a stalled push
- **WHEN** the verifier's push is stalled
- **THEN** a tick returns without waiting for it, and base selection reads the last fetched head

#### Scenario: The tick's own fetch stalls
- **WHEN** origin stops answering fetches and nothing else is talking to it
- **THEN** base selection returns within the short bound with the last fetched head, and the fetch is killed at `git.remoteTimeoutMs`

### Requirement: Push failures are classified
A failed push of the integration branch SHALL be classified from git's output (`LC_ALL=C`). A lost lease is a `stale info` rejection. A refusal is origin declining the push: a rejected ref, a hook, failed authentication, or missing permission. Anything else, a timeout included, is an unreachable origin. Every failed push SHALL undo the clone's local swap. A lost lease SHALL requeue the job at once, with no backoff and no refusal counted.

#### Scenario: A lost lease is not a refusal
- **WHEN** origin moved between the job's fetch and its push
- **THEN** the job is requeued at once, with no backoff and no refusal counted

#### Scenario: A hook rejection is a refusal
- **WHEN** origin's pre-receive hook declines the push
- **THEN** the push is classified as a refusal, and the clone's branch is back at the job's expected head

### Requirement: Push retry backoff
A refused push, an unreachable origin, and a failed fetch at the start of a job SHALL requeue the job after a backoff. The backoff is `git.pushRetryBackoffMs` (default 30000), doubled for each earlier retry of the job, and at most 32 times the base. The job MUST NOT be started again before its backoff ends. The counts and the next retry time SHALL be kept per verifier job in the store's key-value table.

#### Scenario: An outage never blocks
- **WHEN** origin cannot be reached for many retries
- **THEN** each retry waits a longer backoff, up to 32 times the base, and the task stays `submitted`

### Requirement: Push refusal limit
Refusals SHALL be counted per verifier job. When a job's refusals reach `git.pushRefusalLimit` (default 5), the job SHALL fail with kind `pushRefused`. Its task SHALL then go from `submitted` to `blocked` with blocked kind `pushRefused` and the refusal's text as the message, and no attempt is spent. An unreachable origin MUST NOT count toward the limit.

#### Scenario: A protected branch blocks the task
- **WHEN** origin's pre-receive hook rejects every push with "Protected branch update failed", and `git.pushRefusalLimit` is 3
- **THEN** the job is requeued twice, each time after a longer backoff, and the third refusal blocks the task with kind `pushRefused` and a message holding origin's text, with `attempts` unchanged

### Requirement: Catch-up push publishes publications only
When the clone's integration branch is ahead of origin's at the start of a job, the verifier SHALL push it only if every commit origin lacks (first-parent, after the baseline) carries an `Orchestrator-Launch` trailer. A commit without one MUST NOT be pushed. It stays reported as foreign, and the job counts a refusal whose message names the commits.

#### Scenario: A commit made by hand in the clone is not pushed
- **WHEN** a trailer-less commit is made in the daemon's clone after the baseline, and a job starts
- **THEN** origin does not receive it, the commit is listed in `foreignCommits`, and the task is blocked as `pushRefused` once the refusal limit is reached

#### Scenario: Publications from before pushing was on are pushed
- **WHEN** the clone holds commits from before the baseline that origin lacks
- **THEN** the catch-up push sends them and the job verifies on top of them

### Requirement: Catch-up of the job's own squash
If the job's own launch trailer is on the clone's tip when the clone is ahead of origin, the catch-up push SHALL publish that commit as the job's publication. The job's sealed branch MUST NOT be rebased onto its own squash.

#### Scenario: The job's own squash at the tip
- **WHEN** the clone's tip is the job's own squash and origin is at the squash's parent
- **THEN** the catch-up push publishes the squash and the job is `published` at it, without a rebase

### Requirement: Milestone tag conflicts never throw
Tagging a milestone MUST NOT throw. When the clone already holds `milestone/<id>/v<n>` at another sha, for example a tag that `git clone` brought from origin, the tag SHALL NOT be moved or pushed, and the outcome SHALL be a conflict found in the clone. A conflict on origin SHALL be reported the same way, as found on origin. This applies with `git.pushIntegration` on or off.

#### Scenario: A tag in the clone at another sha
- **WHEN** a gated milestone is submitted and the clone holds its tag at another sha
- **THEN** the tick completes, and the tag still points at its old sha in the clone and on origin

### Requirement: Tag conflicts are recorded once
The tick, the milestone tag push and recovery SHALL record a tag outcome through one path. A conflict SHALL append one `milestone.tagConflict` event (with `sha`, `remoteSha` and `where`) and set `tagPushed:<id>:<n>` to `conflict:<sha>`. A recorded conflict MUST NOT be recorded again or retried.

#### Scenario: Recovery meets the conflict
- **WHEN** the daemon is killed after tagging a submitted milestone and before recording it, and the clone holds the tag at another sha
- **THEN** recovery completes and records one conflict with `where: clone`, and later ticks and restarts record no second conflict

### Requirement: Worktree commands are serialized per clone
Every `git worktree` command the daemon runs in a clone (adding a launch worktree, re-attaching a launch branch, removing, pruning, listing, and the verifier's temporary worktrees) SHALL wait for every such command already started in the same clone, so that no two overlap. The clone SHALL be identified by its real path, so that two spellings of one clone share the lock. A failed command SHALL release the lock to the next.

#### Scenario: Removal and add in one clone do not overlap
- **WHEN** the removal of a published launch's worktree and the next launch's `git worktree add` are started at the same time in one clone
- **THEN** one runs after the other, the add succeeds, and the removed worktree is neither on disk nor listed by `git worktree list`

#### Scenario: Two spellings of one clone share the lock
- **WHEN** worktree commands name the clone once through a symbolic link and once through its real path
- **THEN** they still run one at a time

### Requirement: Worktree removal on publish
When the tick applies a terminal verifier job, it SHALL await the removal of the job's launch worktree before later phases, and for a task now `done`, of its other ended launches' worktrees. A removal SHALL never throw and SHALL count as done only when the path is neither on disk nor registered with the clone. A worktree left behind SHALL be retried on every later tick until it is gone, with one attempt per tick while the launch is live.

#### Scenario: Worktree gone at the end of the publishing tick
- **WHEN** a task's verifier job is published while its launch is still live
- **THEN** at the end of the tick that marks the task `done`, the launch has no worktree

#### Scenario: Left-behind worktree retried
- **WHEN** the removal after a publication leaves the worktree behind
- **THEN** the next tick removes it

#### Scenario: Other ended launches of the task cleared
- **WHEN** a task is published while an earlier ended launch of the same task still has its worktree
- **THEN** that worktree is removed too

#### Scenario: Stale registration cleared
- **WHEN** a launch worktree's directory is already gone but the clone still lists it
- **THEN** the removal prunes the registration and reports the worktree gone

### Requirement: Fetch failures are classified
A failed fetch at the start of a verifier job SHALL be classified from git's output. Origin declining the credentials or the access is a refusal; anything else, a timeout included, is unreachable. A refused fetch SHALL count against `git.pushRefusalLimit`, with a message saying the fetch was refused, and SHALL block the task as `pushRefused` at the limit. An unreachable fetch MUST NOT count.

#### Scenario: An expired credential blocks the task
- **WHEN** every fetch fails with "Authentication failed", and `git.pushRefusalLimit` is 3
- **THEN** the job is requeued twice as a refusal, and the third refusal blocks the task with kind `pushRefused` and a message that says the fetch was refused and holds "Authentication failed", with `attempts` unchanged

#### Scenario: An unreachable origin is retried without a limit
- **WHEN** the fetch cannot reach origin more times than `git.pushRefusalLimit`
- **THEN** each failure requeues the job as unreachable with no refusal counted, and the task stays `submitted` and publishes once origin answers

### Requirement: A slow tag push is confirmed when it completes
A milestone tag push the tick starts and stops waiting for SHALL be kept with its outcome. A later tag call for the same tag and sha SHALL use that push rather than start another. While the push runs, the call SHALL wait on it within the tick's bound. Once it has landed, the call SHALL answer pushed without pushing again, and the tag SHALL be recorded as `tagPushed:<id>:<version>`. Once it has failed, the call SHALL push again.

#### Scenario: Every tag push outlives the tick's wait
- **WHEN** origin takes longer than the tick's wait to accept every tag push
- **THEN** the tag is recorded as pushed after its first push completes, and origin receives that one push only

### Requirement: A failed local tag is retried
With `git.pushIntegration` off, a tag created in the clone for a gated milestone SHALL be recorded as `tagLocal:<id>:<version>`. On every tick, a gated milestone in `submitted` or `done` with no such record and no recorded conflict SHALL have its tag created in the clone again, idempotently. A conflict SHALL still be recorded once and not retried.

#### Scenario: The tag could not be created when the milestone was submitted
- **WHEN** a gated milestone is submitted with pushing off while `git tag` fails in the clone, and the failure later clears
- **THEN** a later tick creates `milestone/<id>/v<version>` at the milestone's `integrationSha` and records it as `tagLocal:<id>:<version>`

### Requirement: Push retry state ends with its job
The push retry state the store keeps for a verifier job (`pushRetry:<jobId>`) SHALL be removed when the job's result is applied, in the same transaction. Whatever the outcome (published, conflict, failed or `pushRefused`), no later read SHALL find retry state for that job. Because the store offers no kv delete, the entry SHALL be emptied, and an empty entry SHALL read as no state.

#### Scenario: A job published after outages
- **WHEN** a job is requeued for an unreachable origin and later publishes
- **THEN** once the job is applied, reading its push retry state finds none

### Requirement: Prepare command before the check
With the top-level file key `prepareCommand` set, the verifier SHALL run it in each job's temporary worktree after the rebase and the declared no-op test and immediately before the check command, with `prepareTimeoutMs` (default 600000) and the check command's environment ("Check environment"). The value SHALL be read once when the verifier is built; it is a file key with no override. A prepare command that exits non-zero, or whose exit code is null, SHALL fail the job with kind `checkFailed` and message `prepare command exited <code>`. One that exceeds `prepareTimeoutMs` SHALL be killed and SHALL fail the job with kind `checkTimeout` and message `prepare command exceeded <ms>ms`. On either failure the check command SHALL NOT run, an attempt SHALL be spent as for a failing check ("Check and verified tree"), and the job's output SHALL be the message, a newline, and the command's output tail, so the first line of the output names the prepare command. The verifier's prepare command SHALL have no failure count, backoff or block of its own; `maxAttempts` bounds it. The published tree SHALL be the one read before the prepare command runs ("Check and verified tree"), so nothing the command writes is published, and the verifier SHALL NOT test whether the command left the worktree clean. A command that has not closed 2000 ms after the kill at `prepareTimeoutMs`, or that exited while another process still holds its output pipe, SHALL be recorded then as a timeout. With `prepareCommand` unset the verifier SHALL behave as it does without this requirement.

#### Scenario: Install before the check
- **WHEN** `prepareCommand` installs into `node_modules/` in the temporary worktree and the check command needs that install
- **THEN** the check passes, the submission is published and the task is `done`, and the published tree has no file under `node_modules/` even though the repository does not ignore it

#### Scenario: Non-zero exit
- **WHEN** the prepare command exits 3
- **THEN** the check command does not run, the job is `failed` with kind `checkFailed`, an attempt is spent, the first line of the job's output is `prepare command exited 3` followed by the command's output, and the task's next brief carries that output

#### Scenario: Timeout
- **WHEN** the prepare command runs longer than `prepareTimeoutMs`
- **THEN** it is killed, the check command does not run, the job is `failed` with kind `checkTimeout`, an attempt is spent, and the first line of the job's output is `prepare command exceeded <prepareTimeoutMs>ms`

#### Scenario: Output pipe held after exit
- **WHEN** the prepare command exits 0 but a process it started in another process group still holds its output pipe
- **THEN** the command is killed at `prepareTimeoutMs`, the job is recorded as `failed` with kind `checkTimeout` 2000 ms later while that process may still be alive, and the first line of the job's output is `prepare command exceeded <prepareTimeoutMs>ms`

#### Scenario: Declared no-op
- **WHEN** a declared no-op is verified with `prepareCommand` set
- **THEN** neither the prepare command nor the check command runs and the job is published at the integration head

#### Scenario: No check command
- **WHEN** a job reaches the check step with no check command
- **THEN** it fails as it does without `prepareCommand`, and the prepare command does not run

#### Scenario: Unset key
- **WHEN** `prepareCommand` is unset
- **THEN** the verifier runs only the check command and every outcome is as without this requirement

### Requirement: Failed check across a gap

A verifier run that ends `failed` with kind `checkFailed` or `checkTimeout`, or that throws, and whose run overlapped a gap in the daemon's clock SHALL be put back to `queued` instead of `failed`, once per job. No attempt SHALL be spent and the task SHALL stay `submitted`. The run overlapped a gap when the daemon's awake time between the run's start and the outcome's arrival is less than the wall time between them; both instants SHALL be read after a note of the clock, from the daemon's own gap list (specs/health-monitoring "Gap in the daemon's clock"), and the verifier SHALL keep no clock of its own. In one store transaction the daemon SHALL append `verify.requeued` with `jobId`, a `reason` naming the gap and the failure kind, and `gap: { failureKind, gapMs }`, where `gapMs` is the wall time less the awake time, and SHALL reset the job's `expectedHead`, `rebasedSha`, `verifiedSha` and `squashSha` as a `requeue` outcome does and set its `gapRequeues` to 1. Push retry state SHALL NOT change. The count SHALL be kept on the job row and SHALL NOT be cleared when the job is re-queued for another reason. A failure of a job whose `gapRequeues` is 1 SHALL be written `failed` as before, gap or no gap. The re-run SHALL start like any queued job, after the hold that follows the gap (specs/health-monitoring "Hold after a gap"). A `conflict`, `published` or `requeue` outcome, another failure kind, a dropped job and a fatal store SHALL be handled as before, and `checkTimeoutMs` SHALL still count wall time. With `health.gapAfterMs` at 0 there are no gaps and this rule re-queues nothing. "Check and verified tree" is unchanged.

#### Scenario: A check times out across a gap

- **WHEN** the machine sleeps longer than `health.gapAfterMs` while a check runs and the run ends `failed` with kind `checkTimeout`
- **THEN** the job is `queued` with `gapRequeues` 1 and no `rebasedSha`
- **AND** one `verify.requeued` event carries the job id and `gap: { failureKind: checkTimeout, gapMs }` with a positive `gapMs`
- **AND** the task is `submitted` with no attempt spent, and the job runs again after the hold

#### Scenario: The re-run fails across a second gap

- **WHEN** the job re-queued after a gap runs again and fails across a second gap
- **THEN** the task fails by `verificationFailed` and spends an attempt
- **AND** no second `verify.requeued` event with `gap` is appended

#### Scenario: A failure without a gap

- **WHEN** a check run during which the daemon's clock had no gap ends `failed`, including a run that began after a gap had ended
- **THEN** the task fails by `verificationFailed` and spends an attempt, and no `verify.requeued` event is appended

