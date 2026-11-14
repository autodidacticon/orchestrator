## ADDED Requirements

### Requirement: Publishing recovery while origin is unreachable
Recovery SHALL hand every job found `publishing` to the verifier backend, saying whether origin could be fetched. When the backend cannot confirm the push (origin unreachable, the lease lost, or the push refused), it SHALL put the clone's integration branch back on the job's expected head if the job's squash is still the tip. The job SHALL be requeued, and deferred while origin is unreachable. The clone MUST NOT keep an unpushed squash at its tip.

#### Scenario: Restarted while origin is unreachable
- **WHEN** the daemon is killed between the local swap and the push for a task whose branch has two commits that edit one file, and it restarts on the same clone while origin is unreachable
- **THEN** the clone's branch is back at the job's expected head and the task stays `submitted`. Once origin answers, the task is `done` exactly once, with one commit carrying its trailer on origin, one launch, and no integration retry.

### Requirement: A landed push is found by its trailer
A job whose swap recovery undid SHALL be published at origin's commit when its launch trailer is found on origin, once origin answers. Nothing SHALL be pushed again for it.

#### Scenario: The push had landed
- **WHEN** the lost push had reached origin before the kill
- **THEN** once origin answers, the job is recorded `published` at origin's commit, and nothing is pushed again
