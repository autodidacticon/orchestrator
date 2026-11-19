## MODIFIED Requirements

### Requirement: Repository layout
The orchestrator SHALL manage one repository per instance. Its primary clone SHALL keep the integration branch checked out and SHALL never be used for work. Each launch SHALL get its own worktree from the shared object store, in a directory named by the launch id, on the branch `task/<id>/l<launches>`. The worktree SHALL be removed after the launch ends and the branch SHALL be retained.

#### Scenario: Agent cannot check out the integration branch
- **WHEN** an agent runs `git checkout main` inside its worktree
- **THEN** git refuses because the branch is checked out in the primary clone

#### Scenario: Worktree removed, branch kept
- **WHEN** a launch ends for any reason
- **THEN** its worktree directory no longer exists and its branch still does

### Requirement: Base selection
A launch SHALL start from the integration head observed at claim time, recorded as `baseSha` in the lease and stated in the brief. Because every dependency is `done` before a task is ready, the base MUST already contain the dependencies' published work.

#### Scenario: Base contains dependencies
- **WHEN** T2 is launched after T1 was published
- **THEN** T2's `baseSha` is at or after T1's published commit

#### Scenario: Base follows origin
- **WHEN** a person pushes commit H to origin's integration branch while pushing is on
- **THEN** the next observed integration head is H

### Requirement: Check and verified tree
The verifier SHALL run the effective check command, read when the job starts checking, with a timeout on the rebased tree and SHALL record the rebased head as `verifiedSha`. A non-zero exit or a timeout SHALL fail the task with the command output attached and SHALL increase `attempts`. The check command SHALL apply in every runner mode.

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

### Requirement: Compare-and-swap publication
Publication SHALL update the integration ref with a compare-and-swap that expects the head observed when the job started. If the expected head no longer matches, the job SHALL return to `queued`. `publishedSha` and the task's `done` transition SHALL be recorded in one transaction.

#### Scenario: Head moved during verification
- **WHEN** another publication lands while a job is checking
- **THEN** the compare-and-swap fails and the job is requeued from the rebase step

#### Scenario: Done and published together
- **WHEN** publication succeeds
- **THEN** the same transaction records `publishedSha` and sets the task `done`

#### Scenario: Origin moved before publication
- **WHEN** a person pushes commit H to origin after T1 is verified and squashed but before it is pushed
- **THEN** the push fails its lease, the job is requeued once, and T1 is then published as a child of H on origin and in the clone, with both commits kept

### Requirement: Milestone tagging
When a gated milestone becomes `submitted`, the orchestrator SHALL tag the pinned `integrationSha` as `milestone/<id>/v<reviewVersion>`. Tag creation SHALL be idempotent. With `git.pushIntegration` on, the tag SHALL also be pushed to origin without force. The push outcome SHALL be returned and never thrown, so neither the tick nor recovery fails on it.

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

### Requirement: Check environment
The check command SHALL run with the same environment isolation as a spawned agent: the daemon's environment with the git identity variables added, `ORCH_HOME` replaced by a directory inside the run's data directory, and `ORCH_URL`, `ORCH_REPO`, `ORCH_DATA_DIR` and `ORCH_RUN_ID` removed on every store kind. Repository code run by the check SHALL NOT be able to discover or stop any daemon of the user's through the run directory layout.

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
- The remote `origin` of the daemon's clone SHALL be the source of truth for the integration branch.

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

### Requirement: Prepare command before the check
With the top-level file key `prepareCommand` set, the verifier SHALL run it in each job's temporary worktree after the rebase and the declared no-op test and immediately before the check command, with `prepareTimeoutMs` (default 600000) and the check command's environment ("Check environment"). The value SHALL be read once when the verifier is built; it is a file key with no override. With `prepareCommand` unset the verifier SHALL behave as it does without this requirement.

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
A verifier run that ends `failed` with kind `checkFailed` or `checkTimeout`, or that throws, and whose run overlapped a gap in the daemon's clock SHALL be put back to `queued` instead of `failed`, once per job. No attempt SHALL be spent and the task SHALL stay `submitted`. "Check and verified tree" is unchanged.

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

## ADDED Requirements

### Requirement: Clone follows origin
With `git.pushIntegration` on, the clone SHALL have a remote `origin` whose integration branch is the source of truth (see "Origin as source of truth"); the clone's integration branch SHALL follow it and SHALL never hold a commit origin lacks except between a local compare-and-swap and its push.

#### Scenario: Clone and origin agree after a publication
- **WHEN** a task is published with `git.pushIntegration` on
- **THEN** the clone's integration branch and origin's integration branch both point at the task's trailer commit

### Requirement: Integration head read from origin
With `git.pushIntegration` on, the integration head SHALL be read from `refs/remotes/origin/<branch>`, fetched at most once per `git.fetchIntervalMs`, with a failed fetch keeping the last observed head; while the clone's branch is strictly ahead of origin's, the clone's head SHALL be used instead.

#### Scenario: Failed fetch keeps the last head
- **WHEN** pushing is on and the fetch made for base selection fails
- **THEN** the integration head is the commit last fetched into `refs/remotes/origin/<branch>`

#### Scenario: Clone ahead of origin
- **WHEN** pushing is on and the clone's integration branch holds a publication that origin has not received
- **THEN** the integration head is the clone's head

### Requirement: Unresolved check command holds the job
While `checkCommand` is unresolved, a `queued` job whose sealed sha differs from its base sha SHALL NOT start checking: it SHALL stay `queued` with its sealed sha, the task SHALL stay `submitted`, `status` and the digest SHALL name `checkCommand` under `needsConfig`, and the job SHALL start on the first tick after a check command is set.

#### Scenario: Held across ticks, published after the command is set
- **WHEN** a task with commits ahead of its base is submitted while `checkCommand` is unresolved, several ticks pass, and the operator then sets `checkCommand` to `true`
- **THEN** the job stays `queued` with its sealed sha through those ticks, `status` and the digest name `checkCommand` under `needsConfig`, and after the command is set the job is published and the task is `done` with no attempt spent

### Requirement: Declared no-op is not held
A `queued` job whose sealed sha equals its base sha, a declared no-op, SHALL NOT be held: the verifier never reaches the check step for it, so it SHALL verify and publish at once.

#### Scenario: No-op published while the command is unresolved
- **WHEN** a task declared `noChanges` with no commits ahead of its base is submitted while `checkCommand` is unresolved
- **THEN** its job is `published` and the task is `done`, while `needsConfig` still names `checkCommand`

### Requirement: Check command kept for a running check
A job already `checking` when the command changes SHALL finish with the command it started with.

#### Scenario: Command changed during a check
- **WHEN** the check command is changed from A to B while one job is `checking` with A and another job has not reached the check step
- **THEN** the first job finishes with A and the second job is checked with B

### Requirement: Publication pushed with a lease
With `git.pushIntegration` on, the expected head SHALL be origin's head after the job's fetch, and after the local compare-and-swap the verifier SHALL push the squash commit with `--force-with-lease=refs/heads/<branch>:<expectedHead>`; a push that is rejected or fails SHALL undo the local compare-and-swap and return the job to `queued`, so the next run rebases onto origin's new head.

#### Scenario: Failed push undoes the local swap
- **WHEN** the push of a squash commit fails after the local compare-and-swap because its lease failed or origin could not be reached
- **THEN** the clone's integration branch is moved back to the expected head and the job returns to `queued`

### Requirement: Milestone tag records
The local tag SHALL be recorded as `tagged:<id>:<version>` once it exists, and the push separately as `tagPushed:<id>:<version>`.

#### Scenario: Both records after a pushed tag
- **WHEN** a gated milestone's tag is created in the clone and pushed to origin with `git.pushIntegration` on
- **THEN** the store holds `tagged:<id>:<version>` and `tagPushed:<id>:<version>`, each set to the pinned sha

### Requirement: Milestone tag push retried
A push that fails SHALL be retried on every tick for a gated milestone in `submitted` or `done` until it lands.

#### Scenario: Tag lands once origin answers
- **WHEN** the tag push of a submitted gated milestone fails because origin cannot be reached, and origin answers again later
- **THEN** later ticks push the tag again, and once a push lands the tag is on origin and `tagPushed:<id>:<version>` is recorded

### Requirement: Milestone tag held at another sha
A tag that origin holds at another sha SHALL never be moved: it SHALL be reported once as a `milestone.tagConflict` event and not retried.

#### Scenario: Conflict is not retried
- **WHEN** a tag push finds origin holding the milestone tag at another sha
- **THEN** later ticks do not push that tag again and no further `milestone.tagConflict` event is recorded

### Requirement: Check environment while withholding
While the daemon withholds (specs/state-backend "Withholding follows the store": always on a Postgres store), `DATABASE_URL`, `DATABASE_URL_FILE`, every libpq connection variable named in `LIBPQ_VARS` and every variable whose value is the resolved store URL SHALL be removed too.

#### Scenario: Withheld variables absent from the check
- **WHEN** a check command that prints its environment runs on a daemon with a Postgres store whose environment holds `DATABASE_URL`, `DATABASE_URL_FILE` and a libpq variable
- **THEN** the printed environment holds none of those variables and no value equal to the store URL

### Requirement: Check environment without withholding
While the daemon does not withhold (a SQLite store with no Postgres input), `DATABASE_URL`, `DATABASE_URL_FILE`, every libpq connection variable named in `LIBPQ_VARS` and every variable whose value is the resolved store URL SHALL reach the check unchanged, so a project's check keeps its own database variables.

#### Scenario: SQLite store written in the file
- **WHEN** the daemon's file sets `store.kind: sqlite`, its environment holds `DATABASE_URL` and `ORCH_RUN_ID`, and the check command prints its environment
- **THEN** the printed environment holds `DATABASE_URL` with its value and has no `ORCH_RUN_ID` line

### Requirement: Check cannot reach the state database
While the daemon withholds, repository code run by the check SHALL NOT be able to reach the orchestrator's state database through its environment. The check runs as the daemon's user, so it can still read what specs/state-backend "Store credentials a child can still reach" lists; this requirement does not cover that.

#### Scenario: No variable carries the store URL
- **WHEN** the daemon withholds and a variable of the daemon's environment, of any name, holds the store URL
- **THEN** that variable is not in the check command's environment

### Requirement: Origin remote configured before use
With `git.pushIntegration` on, when `originUrl` is set, the remote `origin` SHALL be added or re-pointed to it before first use. When `originUrl` is unset and the clone has no `origin`, every operation that needs origin SHALL fail naming the missing setting.

#### Scenario: Remote re-pointed to the setting
- **WHEN** pushing is on and `git.originUrl` names a URL other than the clone's `origin`
- **THEN** the clone's `origin` is re-pointed to that URL before the first fetch or push

#### Scenario: No remote and no setting
- **WHEN** pushing is on, `git.originUrl` is unset and the clone has no `origin`
- **THEN** the job that needs origin fails with a message naming `git.originUrl`

### Requirement: Remote commands run one at a time
With `git.pushIntegration` on, all fetches and pushes of one daemon SHALL run one at a time. A fetch SHALL update `refs/remotes/origin/<branch>` only, without tags.

#### Scenario: Fetch waits for a running push
- **WHEN** the verifier's fetch is requested while a push of the same daemon is running
- **THEN** the fetch starts only after the push has ended, and it updates `refs/remotes/origin/<branch>` and no tag

### Requirement: Fetch before the expected head
With `git.pushIntegration` on, before a verifier job observes its expected head, the verifier SHALL fetch. A fetch that fails SHALL requeue the job without spending an attempt, and the `verify.requeued` event and the daemon log SHALL carry the reason.

#### Scenario: Unreachable origin at the fetch
- **WHEN** origin cannot be reached by the verifier's fetch
- **THEN** the job returns to `queued`, no attempt is spent, and the reason of the `verify.requeued` event names the failed fetch

### Requirement: Launch already on origin
With `git.pushIntegration` on, when the job's `Orchestrator-Launch` trailer is already on origin, the job SHALL be published at that commit without a further push. While a push of a squash is in flight, base selection SHALL NOT use that squash.

#### Scenario: Landed push found by its trailer
- **WHEN** a push of a job's squash landed on origin but its answer was lost, and the job runs again
- **THEN** the job is published at the commit on origin that carries its `Orchestrator-Launch` trailer and nothing is pushed again

#### Scenario: Squash in flight is not a base
- **WHEN** base selection runs while the clone's integration head is a squash whose push has not returned
- **THEN** the base is origin's head as last fetched

### Requirement: Clone brought to origin
With `git.pushIntegration` on, when the job's `Orchestrator-Launch` trailer is not on origin, the verifier SHALL bring the clone's integration branch to origin's:
- when the clone is behind, by a fast-forward that also updates the primary worktree;
- when the clone is ahead or origin has no such branch, by pushing the clone's head with a lease;
- when the two have diverged, the job SHALL fail with a message naming both shas and the clone SHALL NOT be reset.

#### Scenario: Clone behind origin
- **WHEN** origin's integration branch holds a commit the clone lacks and the clone holds none that origin lacks
- **THEN** the clone's integration branch is fast-forwarded to origin's head and the job is rebased onto that head

### Requirement: Tracking ref after a push
With `git.pushIntegration` on, after a successful push, `refs/remotes/origin/<branch>` SHALL point at the pushed commit.

#### Scenario: Pushed squash seen without a fetch
- **WHEN** the push of a squash commit succeeds
- **THEN** `refs/remotes/origin/<branch>` points at that squash before any further fetch

### Requirement: Prepare command failures
A prepare command that exits non-zero, or whose exit code is null, SHALL fail the job with kind `checkFailed` and message `prepare command exited <code>`. A prepare command that exceeds `prepareTimeoutMs` SHALL be killed and SHALL fail the job with kind `checkTimeout` and message `prepare command exceeded <ms>ms`.

#### Scenario: Exit code null
- **WHEN** the shell that runs the prepare command is killed by a signal before `prepareTimeoutMs`, so the command's exit code is null
- **THEN** the job is `failed` with kind `checkFailed` and message `prepare command exited null`

### Requirement: Prepare failure output
On either failure of the prepare command, by its exit code or by `prepareTimeoutMs`, the check command SHALL NOT run, an attempt SHALL be spent as for a failing check ("Check and verified tree"), and the job's output SHALL be the message, a newline, and the command's output tail, so the first line of the output names the prepare command.

#### Scenario: Output after the message
- **WHEN** the prepare command prints `oops` and exits 1
- **THEN** the check command does not run, an attempt is spent, and the job's output is `prepare command exited 1`, a newline, and output that ends with `oops`

### Requirement: Prepare command bounded by attempts
The verifier's prepare command SHALL have no failure count, backoff or block of its own; `maxAttempts` bounds it.

#### Scenario: Every failure spends an attempt
- **WHEN** the verifier's prepare command fails on every run of a task's jobs
- **THEN** each failure fails the job like a failing check and spends one attempt, with no retry wait and no `prepareFailed` block, until `maxAttempts` is spent

### Requirement: Prepare command output not published
The published tree SHALL be the one read before the prepare command runs ("Check and verified tree"), so nothing the command writes is published, and the verifier SHALL NOT test whether the command left the worktree clean.

#### Scenario: Files written by the command
- **WHEN** the prepare command writes files the repository does not ignore and the check passes
- **THEN** the job is published, none of those files is in the published tree, and the job does not fail for a dirty worktree

### Requirement: Prepare command that does not close
A prepare command that has not closed 2000 ms after the kill at `prepareTimeoutMs`, or that exited while another process still holds its output pipe, SHALL be recorded then as a timeout.

#### Scenario: Recorded 2000 ms after the kill
- **WHEN** the prepare command is killed at `prepareTimeoutMs` and its output has not closed 2000 ms later
- **THEN** the job is recorded then as `failed` with kind `checkTimeout`, without waiting longer for the command

### Requirement: Gap overlap read from the daemon clock
A verifier run overlapped a gap when the daemon's awake time between the run's start and the outcome's arrival is less than the wall time between them; both instants SHALL be read after a note of the clock, from the daemon's own gap list (specs/health-monitoring "Gap in the daemon's clock"), and the verifier SHALL keep no clock of its own.

#### Scenario: A gap that ended before the run
- **WHEN** a gap in the daemon's clock ended before a check run began and the run then fails
- **THEN** the run did not overlap a gap, the task fails by `verificationFailed`, and no `verify.requeued` event is appended

### Requirement: Gap requeue record
In one store transaction the daemon SHALL append `verify.requeued` with `jobId`, a `reason` naming the gap and the failure kind, and `gap: { failureKind, gapMs }`, where `gapMs` is the wall time less the awake time, and SHALL reset the job's `expectedHead`, `rebasedSha`, `verifiedSha` and `squashSha` as a `requeue` outcome does and set its `gapRequeues` to 1. Push retry state SHALL NOT change.

#### Scenario: Requeue after a check failure across a sleep
- **WHEN** a check run ends `failed` with kind `checkFailed` across a sleep of the machine
- **THEN** one `verify.requeued` event carries the job id, a reason naming the gap and `checkFailed`, and `gap.gapMs` equal to the length of the sleep, and the job is `queued` with `gapRequeues` 1 and no `expectedHead` or `rebasedSha`

### Requirement: Gap requeue count
The `gapRequeues` count SHALL be kept on the job row and SHALL NOT be cleared when the job is re-queued for another reason. A failure of a job whose `gapRequeues` is 1 SHALL be written `failed` as before, gap or no gap.

#### Scenario: Second gap failure is charged
- **WHEN** a job whose `gapRequeues` is 1 fails its check again across a second gap
- **THEN** the job is `failed` with `gapRequeues` still 1 and the task spends an attempt

### Requirement: Re-run after a gap requeue
The re-run of a job re-queued across a gap SHALL start like any queued job, after the hold that follows the gap (specs/health-monitoring "Hold after a gap").

#### Scenario: Re-run waits for the hold
- **WHEN** a job is re-queued across a gap and `health.gapHoldMs` has not yet passed since the gap
- **THEN** the job stays `queued` and no verifier run starts until the hold has passed, after which it runs and can publish

### Requirement: Outcomes outside the gap rule
A `conflict`, `published` or `requeue` outcome, another failure kind, a dropped job and a fatal store SHALL be handled as before, and `checkTimeoutMs` SHALL still count wall time. With `health.gapAfterMs` at 0 there are no gaps and the rule of "Failed check across a gap" re-queues nothing.

#### Scenario: Other failure kind across a gap
- **WHEN** a verifier run fails with kind `integrationCapExceeded` across a gap
- **THEN** the task fails and spends an attempt, and no `verify.requeued` event with `gap` is appended

#### Scenario: Gaps turned off
- **WHEN** `health.gapAfterMs` is 0 and a check fails after a jump of the clock
- **THEN** the task fails and spends an attempt
