## Purpose

Verification outside the daemon. Under `verifier.mode: remote` the daemon offers each verify job over its API; a verifier loop claims it with a lease, rebases the sealed commit onto the expected head, runs the check command, pushes the rebased commit to `refs/verify/<jobId>` and posts the result; the daemon checks that ref, squashes and publishes.

## ADDED Requirements

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
SIGTERM or SIGINT SHALL make the loop print `terminating` and claim no more; a second signal SHALL change nothing. While the loop waits between claims it SHALL exit 0 at once. A claim in flight SHALL be awaited: a job it grants SHALL be released at once with reason `podTerminating`, and any other end of the claim SHALL exit 0. After the signal every call SHALL retry a connection failure for at most the smaller of the retry window and 5000 ms.

#### Scenario: Nothing to claim
- **WHEN** a verifier loop with nothing to claim gets SIGTERM, or SIGINT
- **THEN** it exits 0 with a `terminating` line and no `verify.released` event is appended

### Requirement: Verifier termination: job in progress
While a job is worked and before its result is posted, the signal SHALL abort the job, which kills the check, and the loop SHALL wait at most 5000 ms for the job to return. It SHALL then post the release with the job token and `{ reason: 'podTerminating' }`, print `released` on a 200, and exit 0 whatever the answer. A result post in flight SHALL be awaited with no further retries, and the loop SHALL then exit 0.

#### Scenario: SIGTERM while the check runs
- **WHEN** a verifier loop gets SIGTERM while its check runs
- **THEN** it exits 0 within five seconds with `terminating` and `released` lines, the daemon holds one `verify.released` event with reason `podTerminating`, origin has no `refs/verify/<jobId>`, and another verifier can claim the job
