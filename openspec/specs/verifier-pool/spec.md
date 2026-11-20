# verifier-pool Specification

## Purpose
Verification outside the daemon. Under `verifier.mode: remote` the daemon offers each verify job over its API; a verifier loop claims it with a lease, rebases the sealed commit onto the expected head, runs the check command, pushes the rebased commit to `refs/verify/<jobId>` and posts the result; the daemon checks that ref, squashes and publishes.

## Requirements

### Requirement: Verifier mode
The configuration SHALL have the block key `verifier: { mode }` with the values `local` (default) and `remote`. Under `local` the daemon SHALL check each job with the in-process backend as before. Any other value SHALL fail with `verifier.mode must be one of local, remote`. The key SHALL be read from the file at start and SHALL NOT be a runtime override.

#### Scenario: Default and refused value
- **WHEN** the configuration sets no `verifier` block, and then sets `verifier.mode: elsewhere`
- **THEN** the first resolves `verifier.mode` to `local`, and the second fails naming `verifier.mode`

### Requirement: Verifier mode: start refusal
`verifier.mode: remote` SHALL require `runner.access: remote`. Otherwise the daemon SHALL refuse to start with `verifier.mode remote refused: runner.access must be remote`, before the API listens, and `Orchestrator.start()` SHALL reject with the same message before it loads the graph.

#### Scenario: Remote verification with local access
- **WHEN** a daemon is started with `verifier.mode: remote` and `runner.access: local`
- **THEN** it fails to start with `verifier.mode remote refused: runner.access must be remote` and nothing listens

### Requirement: Remote verification run
Under `verifier.mode: remote` a run of a job without `offer` SHALL read the check command once and sync with origin as the in-process backend does, with the same outcomes. It SHALL then record `checking` with `expectedHead` and `offer: { at, checkCommand }` and wait for the result. With no check command the job SHALL fail as in process. The daemon MUST NOT create a worktree for the job or run the check command or the prepare command.

#### Scenario: Job offered
- **WHEN** a remote worker submits a task under `verifier.mode: remote` with `checkCommand: exit 9`
- **THEN** the job is `checking` with `expectedHead` and an `offer`, a verify claim answers `checkCommand` `exit 9`, and `<dataDir>/verify` does not exist

### Requirement: Remote verification run: declared no-op
Under `verifier.mode: remote` a declared no-op (`sealedSha` equal to `baseSha`) SHALL record `checking` with `expectedHead`, then `verified` with `verifiedSha` `expectedHead`, and SHALL be `published` at `expectedHead` with no offer.

#### Scenario: Nothing to publish
- **WHEN** a remote worker submits with `noChanges` and the launch branch at its base
- **THEN** the task is `done`, origin's head is unchanged, every verify claim made meanwhile answers 404, and no `verify.claimed` event exists

### Requirement: Remote verification run: the wait
The wait SHALL read the job row after each change and SHALL end with nothing recorded when the row is gone or `dropped`. It SHALL return a stored `result`. The first pass that finds neither `verifier` nor `result` once `leaseTtlMs` has passed since `offer.at` SHALL log the warning `verify job waits for a verifier` with `jobId`, `taskId` and `waitedMs`, at most once per run.

#### Scenario: No verifier claims
- **WHEN** an offered job is not claimed for `leaseTtlMs` and two more ticks run
- **THEN** `verify job waits for a verifier` has been logged once with the job's id, and the job is still `checking` with its offer

### Requirement: Remote verification outcomes
A stored result SHALL become the job's outcome: `checkFailed` and `checkTimeout` give `failed` with that kind and the result's output; `rebaseFailed` gives `failed` with kind `checkFailed`, message `rebase failed` and the output; `conflict` gives `conflict` with the result's `conflictFiles`. The gap rule of a failed check SHALL apply as in process.

#### Scenario: Failed check
- **WHEN** a verifier posts `checkFailed` with output `boom`
- **THEN** the job is `failed` with `failureKind` `checkFailed`, and the task is retried with `carry.verifierOutput` `boom` and `attempts` 1

### Requirement: Remote verification outcomes: origin failures
A result `originFailed` SHALL requeue the job with `retry`: `refused` when git's output reads as a refused push, a lost lease or a refused fetch, `unreachable` otherwise. The reason SHALL name the verifier and end with the last 4000 characters of the output. The push backoff and `git.pushRefusalLimit` SHALL apply as for a push, and no attempt SHALL be spent.

#### Scenario: Three origin failures
- **WHEN** a job gets `originFailed` with `[remote rejected]`, then `Authentication failed`, then `Could not resolve host`
- **THEN** three `verify.requeued` events carry `retry` `refused`, `refused`, `unreachable` and `refusals` 1, 2, 2, and the task stays `submitted` with `attempts` 0

### Requirement: Remote verification outcomes: job fields
Every job write that sets `queued`, `published`, `failed` or `conflict` SHALL remove `offer`, `verifier`, `token` and `result`. Progress records and drops SHALL keep them.

#### Scenario: Published job
- **WHEN** a remote job is published
- **THEN** its row has none of `offer`, `verifier`, `token` and `result`

### Requirement: Verify ref
A `verified` result whose `rebasedSha` is `expectedHead` SHALL be `published` there with no fetch. Otherwise the daemon SHALL fetch `refs/verify/<jobId>` into the same ref of its clone, check it and record `rebasedSha`. It SHALL publish at `expectedHead` if `noChanges` holds and the trees match, else record `verifiedSha` `rebasedSha` and publish as integration-pipeline "Squash with trailers", "Durable publishing record", "Compare-and-swap publication" and "Publication pushed with a lease" say.

#### Scenario: Verified and published
- **WHEN** a verifier pushes the rebased commit to `refs/verify/<jobId>` and posts `verified`
- **THEN** origin's main gains one commit whose parent is `expectedHead`, whose tree is the rebased tree and which carries the trailers, and the job's `verifiedSha` is the rebased commit

### Requirement: Verify ref: refusals
The job SHALL be requeued with `retry` `refused` when origin lacks `refs/verify/<jobId>`, when its tip is not the reported `rebasedSha`, or when `expectedHead` is not an ancestor of `rebasedSha`; the reason SHALL name the ref. A fetch of the ref that fails SHALL requeue with `retry` of the fetch's kind.

#### Scenario: Refused three times
- **WHEN** with `git.pushRefusalLimit: 3` a job is verified with the ref missing, then at another commit, then naming an orphan commit
- **THEN** the first two append `verify.requeued` with `retry` `refused` naming the ref, and the third blocks the task as `pushRefused` with `attempts` 0

### Requirement: Verify ref: deletion
Every run that read a `verified` result SHALL delete `refs/verify/<jobId>` on origin and in the clone after the daemon has written its outcome, whatever the outcome, a failed run, a drop and a job found no longer live included. A run that ends with nothing written, because the daemon stops, the store went fatal or the daemon dies, SHALL keep the ref for the resumed run. A failed deletion SHALL be logged as a warning and SHALL change nothing else.

#### Scenario: Ref gone after publication
- **WHEN** a job verified through its ref is published
- **THEN** `git ls-remote <origin> 'refs/verify/*'` prints nothing and the clone has no ref under `refs/verify/`

#### Scenario: Daemon killed before the outcome is written
- **WHEN** with `git.pushRefusalLimit: 2` a verified result is refused because the ref holds another commit, the daemon dies before it writes the outcome, and the daemon restarts
- **THEN** origin still holds `refs/verify/<jobId>` after the restart, the resumed run appends one `verify.requeued` with `retry` `refused` and `refusals` 1 naming the commit the ref holds, the ref is then deleted, and the task stays `submitted` with `attempts` 0

### Requirement: Remote verification and restarts
Under `verifier.mode: remote` the single verifier slot SHALL resume the oldest unapplied `checking` job with an `offer` before it starts a `queued` job, after the hold after a gap. A resumed run SHALL skip the sync and the offer, keep the stored `expectedHead` and check command, and return a stored result at once.

#### Scenario: Result stored while stopped
- **WHEN** a verifier posts `verified` while the daemon is stopped, and the daemon restarts
- **THEN** the job is published after the restart with no second `verify.claimed` event

### Requirement: Remote verification and restarts: stop
`stop()` SHALL end a run that waits for a result at once and record nothing; the job row SHALL stay as it is for the next start. A run already past its wait SHALL finish as before.

#### Scenario: Stop while waiting
- **WHEN** `stop()` is called while a job waits for a result
- **THEN** it returns within one second of the moment the reap and the prepare-command stop end, and the job row is unchanged

### Requirement: Integration steps under remote verification
Under `verifier.mode: remote` the verifier that claimed the job SHALL carry out integration-pipeline "Rebase and conflict handling" and "Rebase from the merge base" in its own clone, from origin's launch branch, instead of a temporary worktree of the daemon. It SHALL carry out "Check and verified tree" with its claim's check command, "Check environment" in its own environment, and "Check command kept for a running check" through the offer's command.

#### Scenario: Check runs on the verifier
- **WHEN** a job is verified under `verifier.mode: remote` with `checkCommand: exit 9`
- **THEN** the daemon runs no check, and the task is published on the verifier's `verified` result

### Requirement: Integration steps under remote verification: daemon steps
Under `verifier.mode: remote` the daemon SHALL keep the origin sync, the declared no-op, `verifiedSha`, the squash, the durable publishing record, the compare-and-swap, the push and its classification, `changedFiles`, and the gap rule of a failed check.

#### Scenario: Origin moved before publication
- **WHEN** origin's main moves after the claim and before the `verified` result
- **THEN** the daemon's push loses its lease, the job is requeued once without `retry`, and it is offered again with the new head as `expectedHead`

### Requirement: Verifier loop
The package SHALL ship the bin `orchestrator-verifier` (`dist/src/verifier/loop.js`, from `src/verifier/loop.ts`, whose first line is `#!/usr/bin/env node`). It SHALL require `ORCH_API`, claim with `POST /v1/verify/claims` and the body `{ verifierId }` and no credential, and work a claim answered 200 as one job, one job at a time. It SHALL open no store and never read `/v1/status`.

#### Scenario: One job per granted claim
- **WHEN** a verifier loop claims and the daemon answers 200 with a job
- **THEN** the claim body was exactly `{ verifierId }` with no `Authorization` header, and the loop works that job before it claims again

### Requirement: Verifier loop: identity and settings
The verifier id SHALL be `POD_NAME` when set and not empty, else `ORCH_VERIFIER_ID`, else the host name. The loop SHALL read `ORCH_VERIFIER_CACHE` (default `/var/cache/orchestrator`), `ORCH_VERIFIER_IDLE_EXIT_MS` (0), `ORCH_VERIFIER_MAX_JOBS` (0), `ORCH_VERIFIER_BACKOFF_MS` (1000), `ORCH_VERIFIER_BACKOFF_MAX_MS` (30000) and `ORCH_RETRY_WINDOW_MS` (60000). A missing `ORCH_API`, or a number that is not a non-negative integer, MUST stop the bin with exit 2 naming the variable.

#### Scenario: Refused settings
- **WHEN** the bin starts without `ORCH_API`, or with `ORCH_VERIFIER_BACKOFF_MS=soon`
- **THEN** it exits 2 with a message naming that variable

### Requirement: Verifier loop: claim answers and waits
A 404 SHALL wait: the first delay is `ORCH_VERIFIER_BACKOFF_MS`, each next one doubles up to `ORCH_VERIFIER_BACKOFF_MAX_MS`. A 400 SHALL print `claim-refused`, write the answer to stderr and end the loop with exit 1. Any other answer SHALL print `claim-refused` once until the next granted claim and wait as a 404 does. A claim with no answer within the retry window SHALL be written to stderr and wait as a 404 does; it MUST NOT end the loop.

#### Scenario: Refusals and no answer
- **WHEN** claims are answered 409, 409 and 503, and then a claim gets no answer within the retry window
- **THEN** one `claim-refused` line is printed, each claim is followed by a wait and another claim, and the loop does not return

### Requirement: Verifier loop: exits
The loop SHALL exit 0 with `idle-exit` when no job has been granted for `ORCH_VERIFIER_IDLE_EXIT_MS` (0: never), with `max-jobs` once `ORCH_VERIFIER_MAX_JOBS` granted jobs have ended however they ended (0: no limit), and on SIGTERM or SIGINT. It MUST NOT exit because a run is finished.

#### Scenario: Idle exit
- **WHEN** every claim is answered 404 with `ORCH_VERIFIER_IDLE_EXIT_MS=120000` and the default delays
- **THEN** the loop waits 1, 2, 4, 8, 16, 30, 30 and 30 seconds and exits 0 with `idle-exit` as its last line

### Requirement: Verifier loop: output
Stdout SHALL get one line per step, `verifier <id> <event> <jobId> <taskId>`, with `-` for a missing id. The events SHALL be `start`, `claimed`, `check`, the six outcomes once stored, `result-refused`, `lease-lost`, `claim-refused`, `released`, `idle-exit`, `max-jobs` and `terminating`. Details SHALL go to stderr; after a check ends the loop SHALL write the check's command, its exit code or `timeout`, and its output to stderr.

#### Scenario: Lines of a verified job
- **WHEN** a verifier loop works a job that passes its check
- **THEN** its stdout has `claimed`, `check` and `verified` lines for the job in that order, and its stderr holds the check's output

### Requirement: Verifier loop: sweep and delay after a job
At start, before its first claim, the loop SHALL remove every directory under `<cache>/verify/`. A job whose result was stored SHALL reset the delay, and the loop SHALL claim again at once. Any other end of a job (`lease-lost`, `result-refused`, an error of the loop, a release) SHALL leave the delay as it is, and the loop SHALL wait its next delay before claiming.

#### Scenario: Two failing jobs
- **WHEN** two jobs in a row end with an error of the loop
- **THEN** each is released, and they are followed by waits of 1 and then 2 seconds

### Requirement: Verifier job steps
A granted job SHALL be worked with the claim's fields in this order: the clone of `repoUrl` under the cache, `git fetch -q --prune origin`, a detached worktree at `expectedHead` under `<cache>/verify/<jobId>`, `rebaseSealed` from the merge base, the check, the push and the result. The worktree MUST be removed afterwards, whatever happened. For a remote job this carries out integration-pipeline "Rebase and conflict handling", "Rebase from the merge base" and "Check and verified tree".

#### Scenario: Verified job
- **WHEN** a sealed commit one commit past its base is verified against an `expectedHead` one other commit past that base, and the check passes
- **THEN** the answer is `verified` with `rebasedSha`, origin's `refs/verify/<jobId>` is `rebasedSha`, `expectedHead` is its ancestor, its tree holds the sealed change, and `<cache>/verify/<jobId>` is gone

### Requirement: Verifier job steps: origin failures
A clone or fetch that fails SHALL post `originFailed` with git's output, and so SHALL an `expectedHead` the clone lacks after the fetch. A `sealedSha` the clone lacks after the fetch SHALL post `rebaseFailed` with an output naming the sha.

#### Scenario: Missing origin and missing commits
- **WHEN** a job names a `repoUrl` that does not exist, or an `expectedHead` origin lacks, or a `sealedSha` origin lacks
- **THEN** the first two answer `originFailed`, and the third answers `rebaseFailed` with an output naming the sha

### Requirement: Verifier job steps: rebase outcomes
A rebase that answers `conflict` SHALL post `conflict` with the unmerged files as `conflictFiles`, and one that answers `failed` SHALL post `rebaseFailed` with the rebase's output. Neither SHALL run the check.

#### Scenario: Conflict
- **WHEN** the sealed commit and `expectedHead` both change `shared.txt`
- **THEN** the answer is `conflict` with `conflictFiles` `['shared.txt']`, and the check did not run

### Requirement: Verifier job steps: nothing to check
When the rebased head is `expectedHead` the loop SHALL post `verified` with `rebasedSha` equal to `expectedHead`, run no check and push nothing. When the claim's `noChanges` is true and the rebased tree equals `expectedHead`'s tree, the loop SHALL run no check, push the rebased head and post `verified` with it.

#### Scenario: Head already holds the work
- **WHEN** `expectedHead` already contains the sealed commit
- **THEN** the answer is `verified` with `rebasedSha` equal to `expectedHead`, the check did not run, and nothing was pushed

### Requirement: Verifier job steps: check outcomes
The check SHALL be the daemon's `runCheck` with the claim's `checkCommand` and `checkTimeoutMs`, in the worktree, keeping the last 65536 characters of output. An aborted check SHALL end the job with no result; a check past its limit SHALL post `checkTimeout`; a non-zero or null exit code SHALL post `checkFailed`. Both SHALL carry the output, and neither SHALL push.

#### Scenario: Failed and slow checks
- **WHEN** the check is `echo boom; exit 3`, and then `sleep 5` with `checkTimeoutMs` 200
- **THEN** the first answers `checkFailed` with `boom` in its output and origin has no `refs/verify/*`, and the second answers `checkTimeout`

### Requirement: Verifier job steps: push
After a passed check, and in the `noChanges` case, the loop SHALL run `git push --force origin <rebasedSha>:refs/verify/<jobId>` in the clone, up to three times, two seconds apart. After the third failure it SHALL post `originFailed` with git's last output; after a push that succeeds it SHALL post `verified` with `rebasedSha`.

#### Scenario: Refused push
- **WHEN** origin's `pre-receive` hook refuses every ref under `refs/verify/`
- **THEN** the hook runs three times, the loop pauses 2000 ms twice, and the answer is `originFailed` with the hook's message in its output

### Requirement: Verifier job steps: remote commands
The fetch and each push try SHALL run under `LC_ALL=C` with a fixed limit of 120000 ms (`VERIFIER_GIT_TIMEOUT_MS`), killed at the limit; a try past the limit SHALL count as a failure whose output says it timed out. No variable SHALL set the limit. The first clone of a `repoUrl` SHALL run through the worker loop's `ensureClone`, unchanged.

#### Scenario: Push past the limit
- **WHEN** the limit is 500 ms and origin's `pre-receive` hook sleeps 10 s
- **THEN** the answer is `originFailed` with `timed out` in its output

### Requirement: Verifier job steps: errors of the loop
A job that ends with no stored result while this verifier still holds it (an error of the loop, such as a full disk, a missing git, a claim answer that lacks a field or a `jobId` with characters other than letters, digits and `-`, or `result-refused`) SHALL post no result. The loop SHALL write the error to stderr, remove the worktree and, given a valid `jobId` and a `token`, post `POST /v1/verify/<jobId>/release` with the job token and `{ reason: 'verifierError' }`.

#### Scenario: Refused result
- **WHEN** the result post is answered 400
- **THEN** the loop prints `result-refused` and posts one release with the job token and `reason: 'verifierError'`

### Requirement: Verifier heartbeat
From the claim until the result post is answered, the loop SHALL send `POST /v1/verify/<jobId>/heartbeat` with the job token as `Authorization: Bearer`, every `lease.renewEveryMs` of the claim answer, else every third of `leaseTtlMs`, each timed from the answer to the one before, so two never overlap. No heartbeat SHALL be sent after the result post is answered.

#### Scenario: Three heartbeats
- **WHEN** the claim answer has `lease.renewEveryMs` 20000 and the job ends after three heartbeats
- **THEN** each heartbeat carries the job token, each was scheduled 20000 ms after the answer to the one before, and none follows the result post's answer

### Requirement: Verifier heartbeat: lost lease
A heartbeat answered 401 SHALL abort the job: the check's process group is killed, a git step in flight is awaited and no further step starts, no result and no release are posted, and the loop prints `lease-lost`. Any other answer, or none within the retry window, SHALL be written to stderr, and the loop SHALL keep the job.

#### Scenario: Heartbeat answered 401
- **WHEN** a heartbeat is answered 401 while the job runs
- **THEN** the job is aborted, no result and no release are posted, `lease-lost` is printed, and one delay passes before the next claim

### Requirement: Verifier result post
The loop SHALL post `POST /v1/verify/<jobId>/result` with the job token and `{ outcome, rebasedSha?, output?, conflictFiles? }`; `verified` SHALL carry `rebasedSha` and no output. A 200, with or without `duplicate: true`, SHALL print the outcome line, and the loop SHALL claim again at once.

#### Scenario: Stored result
- **WHEN** the result post is answered 200
- **THEN** the outcome line is printed and the next claim follows with no wait

### Requirement: Verifier result post: refusals
A result answered 401 SHALL print `lease-lost` and post no release. A 400 SHALL print `result-refused`. A 5xx SHALL be posted again once a second for at most the retry window, and a post with no answer within the retry window SHALL NOT be posted again; in both cases the loop SHALL then print `result-refused`. After `result-refused` the loop SHALL release the job with `verifierError`.

#### Scenario: Two 5xx answers
- **WHEN** the result post is answered 503, 503 and then 200
- **THEN** it was posted three times, one second apart, and the outcome line is printed once

### Requirement: Verifier check environment
The check SHALL get what `runCheck` gives in a process that opened no store, whatever the daemon's store kind: `ORCH_HOME` at `<cache>/child-home`; no `ORCH_URL`, `ORCH_REPO`, `ORCH_DATA_DIR` or `ORCH_RUN_ID`; no `DATABASE_URL`, `DATABASE_URL_FILE` or libpq name. The job token MUST NOT be put into any environment. This is integration-pipeline "Check environment" for a remote job; "Check environment without withholding" applies to the daemon's own check only.

#### Scenario: Check environment
- **WHEN** `ORCH_URL`, `ORCH_RUN_ID`, `DATABASE_URL` and `PGPASSWORD` are set in the loop's environment and the check is `env`
- **THEN** the check's environment holds none of the four, holds `ORCH_HOME` as `<cache>/child-home`, and does not contain the job token

### Requirement: Verifier termination
SIGTERM or SIGINT SHALL make the loop print `terminating` and claim no more; a second signal SHALL change nothing. While the loop waits between claims it SHALL exit 0 at once. The signal SHALL abort a claim in flight, which is sent again within 5000 ms: a job it grants SHALL be released at once with reason `podTerminating`, and any other end of the claim, no answer included, SHALL exit 0. Every call SHALL be bounded as `Verifier termination: bounded calls` says.

#### Scenario: Nothing to claim
- **WHEN** a verifier loop with nothing to claim gets SIGTERM, or SIGINT
- **THEN** it exits 0 with a `terminating` line and no `verify.released` event is appended

#### Scenario: Claim never answered
- **WHEN** in `test/verifier/loop.test.ts`, with `retryWindowMs` 60000, a claim is in flight at SIGTERM and the daemon never answers it
- **THEN** the loop exits 0 within `TERMINATION_CALL_MS` plus 1000 ms of the signal

### Requirement: Verifier termination: job in progress
While a job is worked and before its result is posted, the signal SHALL abort the job, which kills the check, and the loop SHALL wait at most 5000 ms for the job to return. It SHALL then post the release with the job token and `{ reason: 'podTerminating' }`, print `released` on a 200, and exit 0 whatever the answer. After the signal no answered result post SHALL be posted again, a signal in the pause between posts included.

#### Scenario: SIGTERM while the check runs
- **WHEN** a verifier loop gets SIGTERM while its check runs
- **THEN** it exits 0 within five seconds with `terminating` and `released` lines, the daemon holds one `verify.released` event with reason `podTerminating`, origin has no `refs/verify/<jobId>`, and another verifier can claim the job

#### Scenario: Signal in the pause between posts
- **WHEN** a result post is answered 503 and the signal lands during the 1000 ms pause before the next post
- **THEN** no further post is made, so exactly one result post is made in total, and the job is released with reason `podTerminating`

### Requirement: Verify job offer
A verify job SHALL carry four optional fields in its JSON document, with no column and no migration: `offer` (`at`, `checkCommand`), `token`, `verifier` (`id`, `claimedAt`, `expiresAt`) and `result`. A job SHALL be claimable only when it is unapplied and `checking`, has an `offer`, holds neither `verifier` nor `result`, and its launch row exists. A job the in-process backend checks has no `offer` and SHALL never be claimable.

#### Scenario: Nothing offered
- **WHEN** the store holds a `queued` job, a `checking` job with `expectedHead` but no `offer`, and an offered job whose launch row is missing, and a verifier claims
- **THEN** the claim answers 404 `{ error: "nothing to verify" }`, the latest event sequence is unchanged and the three job rows are unchanged

#### Scenario: Fields survive a reopen on every backend
- **WHEN** a job is updated with `offer`, `token`, `verifier` and `result`, the store is reopened, then `verifier` and `token` are patched to `undefined` and the store is reopened again
- **THEN** the job first reads back with all four fields, and then holds neither `verifier` nor `token` while keeping `offer` and `result`

### Requirement: Verify claim
`POST /v1/verify/claims` with `{ verifierId }` SHALL grant the oldest claimable job, in `listJobs` order. One transaction SHALL set `token` to 48 random hex characters and `verifier` to `{ id, claimedAt: now, expiresAt: now + leaseTtlMs }`, and append `verify.claimed` with `jobId`, `verifierId` and `expectedHead`, naming the job's `taskId` and `launchId`. In M5 the claim SHALL read no credential.

#### Scenario: Grant
- **WHEN** verifier `v1` claims an offered job
- **THEN** the answer is 200 with `repeated: false` and a 48-character hex `token`, the row holds `verifier.id` `v1` with `claimedAt` at the clock and `expiresAt` at the clock plus `leaseTtlMs`, and exactly one `verify.claimed` event names the job, `v1`, the `expectedHead`, the task and the launch

#### Scenario: Oldest job first
- **WHEN** two jobs are offered and the one with the later id has the older `createdAt`
- **THEN** a claim grants the job with the older `createdAt`

### Requirement: Verify claim: refusals
A blank `verifierId`, after trimming, SHALL answer 400 `{ error: "verifierId is required" }`, and an id the store would rewrite SHALL answer 400 naming `verifierId`, before anything is written. With nothing to claim or hold the claim SHALL answer 404 `{ error: "nothing to verify" }` before resolving a repository URL; with no URL it SHALL answer 409. A 400, 404 or 409 SHALL append no event and change no row.

#### Scenario: Missing, blank and unstorable ids
- **WHEN** a claim has no `verifierId`, one of only spaces, or one holding a NUL character
- **THEN** the first two answer 400 `{ error: "verifierId is required" }`, the third is refused with the store's unstorable error naming `verifierId`, and no event is appended

#### Scenario: No repository URL
- **WHEN** the daemon's `repoPath` is an empty directory and no git URL is configured
- **THEN** a claim answers 404 while nothing is offered and 409 `{ ok: false, reason: "no repository URL: set git.workerOriginUrl or git.originUrl" }` once a job is offered, and neither appends an event or changes the job row

### Requirement: Verify claim: repeated claim
A verifier that holds an unapplied `checking` job with its id in `verifier.id` and no `result` SHALL get the same job and token again with `repeated: true`, also when its lease has run out but the tick has not ended it. The repeat SHALL move `verifier.expiresAt` to now plus `leaseTtlMs`, change nothing else and append no event. The claim SHALL look for a held or claimable job again after resolving the URL, and await nothing between that look and the grant.

#### Scenario: Same verifier claims again
- **WHEN** `v1` claims a job, the clock advances 1000 ms, and `v1` claims again
- **THEN** the answer names the same `jobId` and `token` with `repeated: true`, `expiresAt` and `leaseExpiresAt` are the new clock plus `leaseTtlMs`, and no second `verify.claimed` is appended

#### Scenario: Another verifier while the job is held
- **WHEN** `v1` holds the only offered job and `v2` claims
- **THEN** the claim answers 404 and writes nothing

### Requirement: Verify claim: answer
A claim SHALL answer 200 `{ ok, repeated, jobId, token, taskId, branch, repoUrl, integrationBranch, expectedHead, sealedSha, baseSha, noChanges, checkCommand, checkTimeoutMs, leaseTtlMs, leaseExpiresAt, lease }`: `branch` from the launch row, `repoUrl` as in a remote worker claim, `integrationBranch`, `checkTimeoutMs` and `leaseTtlMs` at their start values, `noChanges` from the submit report, `checkCommand` from the offer, and `lease` as `{ ttlMs, expiresAt, renewEveryMs }` from `verifier`.

#### Scenario: Answer fields
- **WHEN** `v1` claims an offered job on a harness whose `git.workerOriginUrl` is `file:///origin.git`
- **THEN** the answer holds `branch` equal to the launch row's, `repoUrl` `file:///origin.git`, `noChanges: false`, `leaseExpiresAt` equal to `verifier.expiresAt`, and `lease.renewEveryMs` a third of `leaseTtlMs`

#### Scenario: Check command kept for the offer
- **WHEN** the check command is overridden to `make check` and a job offered with `checkCommand: "true"` is claimed
- **THEN** the answer's `checkCommand` is `true`

#### Scenario: Same repository URL as a remote worker
- **WHEN** on a remote run with a bare origin a worker claims with `access: remote` and later a verifier claims an offered job over HTTP
- **THEN** both answers carry the same `repoUrl`

### Requirement: Verify claim: pause and hold
Neither a paused run nor the hold after a gap in the daemon's clock SHALL stop the claim, heartbeat, result or release route.

#### Scenario: Paused and in the hold
- **WHEN** the run is paused, and again when the daemon is inside the hold after a gap, a verifier claims an offered job and sends a heartbeat and a result
- **THEN** the claim is granted and the heartbeat and the result answer 200

### Requirement: Verify claim: waiters
The daemon SHALL keep in-memory waiters per job: `verifyJobChanged` SHALL resolve at the job's next grant, repeated claim, result, release or lease expiry, and at the end of every lease-expiry pass of the tick; `wakeVerifyWaiters` SHALL resolve every pending one. Nothing about a waiter is stored.

#### Scenario: Waiters resolve
- **WHEN** a waiter is pending on a job and the job is granted, released, expired or given a result, or a tick changes nothing, or `wakeVerifyWaiters` is called
- **THEN** the waiter resolves each time

### Requirement: Verify job token
The heartbeat, result and release routes SHALL accept a request only when the job named in the path exists, is unapplied and `checking`, and its `token` equals the `Authorization: Bearer` value; anything else SHALL answer 401 `{ error: "unauthorized" }`. A missing header SHALL read as the empty token, and a job without a token SHALL never pass.

#### Scenario: Refused tokens
- **WHEN** a heartbeat, result or release is sent with a wrong token, an empty token, for an unknown job, for a claimed job set back to `queued`, or for a claimed job dropped by a cascade with its own token
- **THEN** each answers 401 `{ error: "unauthorized" }`, while the right token on the claimed job answers 200

#### Scenario: No header over HTTP
- **WHEN** heartbeat, result and release are sent over HTTP without an `Authorization` header
- **THEN** each answers 401

### Requirement: Verify job token: only in the claim answer
The job token SHALL leave the daemon only in the claim answer: no event, log line, status or other answer SHALL carry it.

#### Scenario: Status and events carry no token
- **WHEN** two verifiers have claimed a job over HTTP in turn
- **THEN** no answer of `GET /v1/status` or `GET /v1/events` contains either job token

### Requirement: Verify lease
`POST /v1/verify/:jobId/heartbeat` with the job token SHALL set `verifier.expiresAt` to now plus `leaseTtlMs`, append no event, and answer 200 `{ ok: true, ttlMs, expiresAt, renewEveryMs }`. A heartbeat on a job that holds a result SHALL also answer 200.

#### Scenario: Heartbeat
- **WHEN** the clock advances 1000 ms after a claim and the verifier sends a heartbeat
- **THEN** `verifier.expiresAt` is the clock plus `leaseTtlMs`, the answer holds `ttlMs`, `expiresAt` and `renewEveryMs`, and the latest event sequence is unchanged

### Requirement: Verify lease: expiry
Each tick SHALL, first in its verification phase and after writing pending gaps, end every lease of an unapplied `checking` job with a `verifier`, no `result` and `verifier.expiresAt` at or before now: one transaction SHALL remove `verifier` and `token` and append `verify.leaseExpired` with `jobId` and `verifierId`. Unless "Verify lease: cycle cap" ends it, the job SHALL stay `checking` with its `offer`, claimable again, and no attempt SHALL be spent.

#### Scenario: Lease runs out
- **WHEN** `leaseTtlMs` passes after a claim without a heartbeat and the tick runs
- **THEN** `verifier` and `token` are removed, one `verify.leaseExpired` names the job and `v1`, the job stays `checking` with its `offer`, the old token answers 401, and a claim by `v2` is granted with another token

#### Scenario: Heartbeats keep the lease
- **WHEN** the verifier sends a heartbeat every third of `leaseTtlMs` over three lease lengths while the tick runs
- **THEN** no `verify.leaseExpired` is appended

#### Scenario: A job with a result is not expired
- **WHEN** a job holds a `result` and two lease lengths pass before a tick
- **THEN** its `verifier` stays and no `verify.leaseExpired` is appended

### Requirement: Verify lease: renewal after a gap
The transaction that writes gaps in the daemon's clock SHALL, after renewing the leases of live launches, set `verifier.expiresAt` to the time of the write plus `leaseTtlMs` for every unapplied `checking` job that has a `verifier` and no `result`, and append no event for it.

#### Scenario: Sleep past the lease
- **WHEN** after a claim the daemon does not run for five lease lengths and then ticks
- **THEN** no `verify.leaseExpired` is appended and `verifier.expiresAt` is at or after the wake plus `leaseTtlMs`, and after a further `leaseTtlMs` of awake time a tick expires the lease

### Requirement: Verify result
`POST /v1/verify/:jobId/result` with the job token SHALL store `result` once, with `verifierId` from the row's `verifier.id` and `at` set to now, and append `verify.result` with `jobId`, `verifierId` and `outcome` in the same transaction; the event MUST NOT carry the output. The job SHALL stay `checking` and keep `token` and `verifier`, and the job's own `rebasedSha`, `output` and `conflictFiles` SHALL not change.

#### Scenario: Verified result
- **WHEN** `v1` posts `outcome: verified` with an upper-case full `rebasedSha` and an output
- **THEN** `result` holds the lower-cased sha, the output, `conflictFiles: []`, `verifierId` `v1` and `at` at the clock, one `verify.result` event without an `output` key is appended, and the job stays `checking` with its `token`

### Requirement: Verify result: body
The result body SHALL be `{ outcome, rebasedSha?, output?, conflictFiles? }`: `outcome` one of `verified`, `checkFailed`, `checkTimeout`, `conflict`, `rebaseFailed`, `originFailed`; `rebasedSha` required for `verified`, a full hex object name when present, stored lower-cased; `output` a string, empty when absent, cut to its last 65536 characters; `conflictFiles` an array of strings, empty when absent. A malformed body SHALL answer 400 `{ error, field }` and store nothing.

#### Scenario: Outcomes and malformed bodies
- **WHEN** each of the six outcomes is posted on a job of its own, and then an unknown outcome, `verified` without `rebasedSha`, a short `rebasedSha`, a non-string `output` and a `conflictFiles` that is not an array of strings are posted
- **THEN** the six are accepted, and each malformed body answers 400 naming its field and stores no `result`

#### Scenario: Long output
- **WHEN** a result carries an `output` of 70000 characters
- **THEN** the stored output is its last 65536 characters

### Requirement: Verify result: duplicate
A result for a job that already holds a `result` SHALL answer 200 `{ ok: true, duplicate: true }` before its body is checked, and SHALL change nothing.

#### Scenario: Posted twice
- **WHEN** the same result is posted again, or a second result with another body
- **THEN** each answers `{ ok: true, duplicate: true }` and still one `verify.result` event exists

### Requirement: Verify release
`POST /v1/verify/:jobId/release` with `{ reason? }` and the job token SHALL hand the claim back: a job holding a `result` SHALL answer 409 `{ ok: false, reason: "a result is already recorded" }`; a `reason` that is not a string SHALL answer 400 naming `reason`. Otherwise one transaction SHALL remove `verifier` and `token` and append `verify.released` with `jobId`, `verifierId` and `reason` (default `released by verifier`). Unless the cycle cap ends it, the job SHALL keep its `offer`.

#### Scenario: Release and claim again
- **WHEN** `v1` releases with `reason: terminating`, `v2` claims, and `v1` releases again with its old token
- **THEN** the first release answers 200, removes `verifier` and `token` and appends one `verify.released` with the job, `v1` and `terminating`; `v2` is granted with another token; and the second release answers 401

#### Scenario: Release after a result
- **WHEN** a verifier that has posted a result releases the job
- **THEN** the release answers 409 and the row is unchanged

### Requirement: Verify ref: deletion: verify refs only
`Origin.deleteRef` SHALL refuse with an `Error` any name that does not start with `refs/verify/`, whatever its case, before it runs a command that talks to origin, changes a ref, or adds or re-points a remote. A verify ref that origin or the clone lacks SHALL NOT be an error.

#### Scenario: Branches and the tracking ref
- **WHEN** `deleteRef` is called with `refs/heads/main`, `refs/heads/MAIN` and `refs/remotes/origin/main`
- **THEN** each rejects with an `Error` naming the ref and `refs/verify/`, the clone's `main` and tracking ref and origin's `main` are unchanged, and no remote is added

#### Scenario: Missing verify ref
- **WHEN** `deleteRef` is called with a ref under `refs/verify/` that neither origin nor the clone has, or git answers `remote ref does not exist`
- **THEN** the call resolves and the clone has no such ref

### Requirement: Remote verification run: the wait: ended job
The wait SHALL end with nothing recorded when the job row has left `checking` without a result, as a job that lost its verifier three times has. The verifier slot SHALL then be free.

#### Scenario: Verifier lost while waiting
- **WHEN** three verifiers in turn claim an offered job and release it with reason `verifierError`
- **THEN** the job is `failed` with `failureKind` `verifierLost`, the verifier slot is free, and the task has spent an attempt

### Requirement: Remote verification outcomes: dropped job
A failed run, including a run that throws, SHALL write nothing to a job row that is gone, `dropped` or applied. The row SHALL keep its status, `applied` flag and fields.

#### Scenario: Dropped during the ref check
- **WHEN** a cascade drops a `checking` job that holds a `verified` result while its ref is fetched, and the run then throws an error that is not an `OriginFetchError`
- **THEN** the job stays `dropped` and applied with its result, has no `failureKind`, and the task's `attempts` is unchanged

### Requirement: Verify lease: cycle cap
A job SHALL count in `leaseLosses`, never cleared, each lease expiry and each release with reason `verifierError`. A release with any other reason, `podTerminating` included, SHALL NOT be counted. The event of a counted loss SHALL carry `leaseLosses`. At the third loss, the same transaction SHALL set the job `failed` with `failureKind` `verifierLost`, an output that names the count, and no `offer`, `verifier`, `token` or `result`. The tick SHALL then fail the task, spending an attempt.

#### Scenario: Third loss
- **WHEN** a job's lease expires, a verifier releases it with `podTerminating`, another releases it with `verifierError`, and a further lease expires
- **THEN** after the second counted loss the job is still `checking` with its offer and claimable, and after the third it is `failed` with `failureKind` `verifierLost`, `leaseLosses` 3 and an output naming 3, and the task has `attempts` 1

### Requirement: Verify claim: refusals: long verifierId
A `verifierId` longer than 253 characters, the longest pod name, after trimming, SHALL answer 400 `{ error, field: "verifierId" }` before anything is written.

#### Scenario: 254 characters
- **WHEN** a claim carries a `verifierId` of 254 characters, and then one of 253
- **THEN** the first answers 400 naming `verifierId` and appends no event, and the second is granted

### Requirement: Verify result: body: limits
A result's `conflictFiles` SHALL be stored with its first 200 entries, and each stored entry SHALL keep its first 4096 characters.

#### Scenario: 500 conflict files
- **WHEN** a `conflict` result carries 500 `conflictFiles`
- **THEN** the stored result holds the first 200 files

#### Scenario: A long conflict file
- **WHEN** a `conflict` result carries one `conflictFiles` entry of 10,000 characters
- **THEN** the stored entry is its first 4096 characters

### Requirement: Verify release: reason limit
A release `reason` SHALL be stored in `verify.released` with its first 4096 characters.

#### Scenario: Long reason
- **WHEN** a verifier releases a job with a `reason` of 10000 characters
- **THEN** `verify.released` carries the reason's first 4096 characters

### Requirement: Verifier termination: refused result post
After the signal, a result post that ends neither stored (200) nor lost (401), because it is answered 400 or 5xx or gets no answer, SHALL be followed by one release with the job token and reason `podTerminating`, through the short window, and the loop SHALL then exit 0. A post stored or lost SHALL be followed by no release. The job is handed back, so it does not stay leased until `leaseTtlMs` runs out.

#### Scenario: Refused after the signal
- **WHEN** in `test/verifier/loop.test.ts` the result post in flight at SIGTERM is answered 400, or 503, or gets no answer
- **THEN** the loop posts one release `{ reason: 'podTerminating' }` with the job token, prints `released`, and exits 0 within 6000 ms of the signal

#### Scenario: Result post never answered
- **WHEN** with `retryWindowMs` 60000 a result post is in flight at SIGTERM and the daemon never answers it
- **THEN** the loop posts the release and exits 0 within `TERMINATION_CALL_MS` plus 1000 ms of the signal

### Requirement: Verifier termination: bounded calls
The verifier and worker loops SHALL share one termination-aware API client. The signal SHALL abort each fetch in flight through its `AbortSignal`, and that call SHALL retry with at most 5000 ms (`TERMINATION_CALL_MS`) left; a call started after the signal SHALL retry for at most the smaller of the retry window and 5000 ms. A fetch SHALL be aborted once its call's window has passed, but no sooner than 5000 ms before the signal or 1000 ms after it.

#### Scenario: Daemon holds the connection
- **WHEN** a call's fetch is accepted and never answered and the call's remaining window passes
- **THEN** the fetch is aborted and the call throws its error, so a call in flight at the signal ends at most `TERMINATION_CALL_MS` plus 1000 ms after it

#### Scenario: Answer cut off by the signal
- **WHEN** the signal aborts a fetch after its headers have arrived and while its body is read
- **THEN** the call counts it as no answer and sends it again, so a claim's grant is not taken for an empty answer: the repeated claim returns the job, which is released with `podTerminating`

#### Scenario: Before the signal
- **WHEN** no signal has come and a fetch is started with less than 5000 ms of its window left
- **THEN** the fetch is given 5000 ms, so a slow answer near the end of the window is still awaited

### Requirement: Verifier termination: bounded calls: timer cap
The timeout the shared API client gives `setTimeout` for one fetch SHALL be capped at 2^31 - 1 ms (`MAX_TIMER_MS`), the longest delay the timer takes, so a retry window of 2^31 ms or more cannot overflow it. The retry window itself SHALL keep its configured value.

#### Scenario: Retry window past the timer's range
- **WHEN** the retry window is 3e9 ms and the daemon answers a call in 50 ms
- **THEN** the call returns that first answer after one fetch, and no `TimeoutOverflowWarning` is emitted

### Requirement: Verify ref: deletion: sweep
Under `verifier.mode: remote`, startup recovery SHALL list origin's refs under `refs/verify/` once every verifier job is settled, and SHALL delete each `refs/verify/<jobId>` whose job is applied, `published`, `failed` or `dropped`. It SHALL keep the ref of a job that has not ended and of no job. The sweep SHALL wait for durability first. A failed listing or deletion SHALL be logged as a warning and tried again at the next start; with origin unreachable the sweep SHALL wait for the next start.

#### Scenario: Job lost after a push
- **WHEN** the last of three verifiers pushes `refs/verify/<jobId>` and releases with `verifierError`, the job ends `failed` with `verifierLost`, the deletion fails, and the daemon starts again
- **THEN** origin has no `refs/verify/<jobId>` after the start

#### Scenario: Daemon killed after the publication push
- **WHEN** the daemon dies after it pushed the publication and before it wrote `published`, and starts again
- **THEN** recovery records the job `published` and origin has no `refs/verify/<jobId>`

#### Scenario: Cancel while the run waits after a push
- **WHEN** a verifier pushes the ref, the task is cancelled while the run waits, the daemon dies before the ref is deleted, and starts again
- **THEN** origin has no `refs/verify/<jobId>` after the start

#### Scenario: Live job kept
- **WHEN** the daemon starts again while a claimed `checking` job holds a pushed ref and origin holds a ref under `refs/verify/` that no job has
- **THEN** both refs are still on origin after the start

### Requirement: Verify ref: deletion: ended job
A run that waited for a result and whose job, read after its outcome is written, is applied, `published`, `failed` or `dropped` SHALL delete `refs/verify/<jobId>` as "Verify ref: deletion" says, with or without a `verified` result. An error thrown while the failure of a run is written SHALL be logged with its own message, not as an after-outcome failure, and SHALL keep the ref.

#### Scenario: Cancel while the run waits
- **WHEN** a verifier pushes the ref and the task is cancelled while the run waits
- **THEN** origin has no `refs/verify/<jobId>` once the wait has ended

#### Scenario: Failure write throws
- **WHEN** a run throws and writing its failure throws too
- **THEN** the error is logged as "the failure could not be written" and no "after-outcome step failed" is logged
