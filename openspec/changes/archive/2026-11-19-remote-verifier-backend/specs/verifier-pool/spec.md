## Purpose

Verification outside the daemon. Under `verifier.mode: remote` the daemon offers each verify job over its API; a verifier loop claims it with a lease, rebases the sealed commit onto the expected head, runs the check command, pushes the rebased commit to `refs/verify/<jobId>` and posts the result; the daemon checks that ref, squashes and publishes.

## ADDED Requirements

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
Every run that read a `verified` result SHALL delete `refs/verify/<jobId>` on origin and in the clone as it ends, whatever the outcome. A failed deletion SHALL be logged as a warning and SHALL change nothing else.

#### Scenario: Ref gone after publication
- **WHEN** a job verified through its ref is published
- **THEN** `git ls-remote <origin> 'refs/verify/*'` prints nothing and the clone has no ref under `refs/verify/`

### Requirement: Remote verification and restarts
Under `verifier.mode: remote` the single verifier slot SHALL resume the oldest unapplied `checking` job with an `offer` before it starts a `queued` job, after the hold after a gap. A resumed run SHALL skip the sync and the offer, keep the stored `expectedHead` and check command, and return a stored result at once.

#### Scenario: Result stored while stopped
- **WHEN** a verifier posts `verified` while the daemon is stopped, and the daemon restarts
- **THEN** the job is published after the restart with no second `verify.claimed` event

### Requirement: Remote verification and restarts: stop
`stop()` SHALL end a run that waits for a result at once and record nothing; the job row SHALL stay as it is for the next start. A run already past its wait SHALL finish as before.

#### Scenario: Stop while waiting
- **WHEN** `stop()` is called while a job waits for a result
- **THEN** it returns within one second and the job row is unchanged

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
