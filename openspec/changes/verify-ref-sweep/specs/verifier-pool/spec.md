## MODIFIED Requirements

### Requirement: Verify result: body: limits
A result's `conflictFiles` SHALL be stored with its first 200 entries, and each stored entry SHALL keep its first 4096 characters.

#### Scenario: 500 conflict files
- **WHEN** a `conflict` result carries 500 `conflictFiles`
- **THEN** the stored result holds the first 200 files

#### Scenario: A long conflict file
- **WHEN** a `conflict` result carries one `conflictFiles` entry of 10,000 characters
- **THEN** the stored entry is its first 4096 characters

## ADDED Requirements

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
