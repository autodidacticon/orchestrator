## ADDED Requirements

### Requirement: Seal
The seal of a remote submit SHALL run through the daemon's shared origin: one fetch of origin's `refs/heads/<branch>` (the launch row's branch) into the daemon clone's `refs/heads/<branch>`, forced, on the same serial chain as every other remote command, after which the fetched tip SHALL be compared with the reported `sealedSha`. When origin has no such branch, the submit SHALL answer 409 `{ reason: 'branchNotPushed', branch }`; the answer SHALL come from origin, never from a ref an earlier fetch left in the clone. When origin's tip differs, the submit SHALL answer 409 `{ reason: 'shaMismatch', branch, expected, actual }` with `expected` the reported `sealedSha` and `actual` origin's tip. When origin cannot be fetched (unreachable, timed out, or no remote configured), the submit SHALL answer 503 `{ reason: 'originUnreachable' }`; when origin refuses the credentials or access, 503 `{ reason: 'originRefused' }`. On any of these the task SHALL stay `running` and nothing SHALL be recorded, so the worker may retry. When the tips match, the fetched tip SHALL be the `sealedSha`, and the submission checks (`emptySubmission`, acceptance evidence) SHALL run against it and the launch's `baseSha` as for a local submit. The fetched commit SHALL stay in the clone, where the verifier rebases it. No commit is made and the commit policy does not apply. A seal called without a reported `sealedSha`, or on a daemon without an origin, SHALL reject as the tree-bound calls of "Remote workspace" do. The fallback report file SHALL NOT be read for a remote launch, and the launch branch on origin SHALL NOT be deleted after publication.

#### Scenario: Pushed tip accepted and published
- **WHEN** the worker of remote launch L commits C on L's branch in its own clone, pushes it to origin, and submits with `sealedSha` C
- **THEN** the response is 200 with `outcome` `submitted`, the daemon clone's `refs/heads/<branch>` is C, and the verifier publishes the task to origin's integration branch with an `Orchestrator-Task` trailer

#### Scenario: Branch not pushed
- **WHEN** the worker submits with `sealedSha` C without pushing the launch branch
- **THEN** the response is 409 with `reason` `branchNotPushed` and the task is still `running`

#### Scenario: Another tip on origin
- **WHEN** the worker pushes commit C and submits with `sealedSha` set to C's parent
- **THEN** the response is 409 with `reason` `shaMismatch`, `expected` C's parent and `actual` C, the task is still `running`, and a resubmit with C is accepted

#### Scenario: Origin unreachable
- **WHEN** origin cannot be reached while a remote submit is sealed
- **THEN** the response is 503 with `reason` `originUnreachable`, no `agent.report` event is appended, and the task is still `running`

#### Scenario: Empty remote submission
- **WHEN** the pushed tip equals `baseSha` and the report has no `noChanges`
- **THEN** the submission fails with reason `emptySubmission`, as a local one does
